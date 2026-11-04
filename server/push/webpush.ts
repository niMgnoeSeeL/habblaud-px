// Web Push sem dependências: a criptografia da mensagem (RFC 8291, aes128gcm da RFC 8188) e a identificação do
// servidor (VAPID, RFC 8292, JWT ES256), só com node:crypto. O serviço de push do navegador (no iPhone, o da Apple)
// recebe a mensagem cifrada para a chave do aparelho: ele entrega, mas não lê o conteúdo.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Uma assinatura de push, como PushSubscription.toJSON() a manda (chaves em base64url). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Par de chaves VAPID: a pública (65 bytes, base64url) vai à página; a privada (JWK) fica em push.json. */
export interface VapidKeys {
  publicKey: string;
  privateJwk: { kty: 'EC'; crv: 'P-256'; d: string; x: string; y: string };
}

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Os serviços de push dos navegadores (só para eles o servidor manda: o endereço vem da página). */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

/** A assinatura é de um serviço de push conhecido, por https, com as chaves no tamanho certo? */
export function validSubscription(v: unknown): v is PushSubscriptionJson {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const keys = s.keys as Record<string, unknown> | undefined;
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2048 || !keys || typeof keys !== 'object') return false;
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return false;
  const p = fromB64u(keys.p256dh);
  return p.length === 65 && p[0] === 4 && fromB64u(keys.auth).length === 16;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(raw), privateJwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y } };
}

function privateKeyOf(v: VapidKeys): KeyObject {
  return createPrivateKey({ key: v.privateJwk, format: 'jwk' });
}

/**
 * Cabeçalho Authorization do VAPID: JWT ES256 com o `aud` (a origem do serviço de push), a validade (no máximo 24 h;
 * aqui 12 h) e o `sub` (contato do servidor, que a Apple exige).
 */
export function vapidAuthorization(endpoint: string, v: VapidKeys, nowMs: number, sub: string): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub })));
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKeyOf(v), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Tamanho do registro (rs) no cabeçalho do aes128gcm: a mensagem cabe num registro só. */
const RECORD_SIZE = 4096;

/**
 * Cifra `plaintext` para a assinatura (RFC 8291): ECDH com uma chave efêmera, HKDF com o segredo `auth`, AES-128-GCM
 * num registro só. `fixed` (chave efêmera e sal) só nos testes, para o vetor da RFC.
 */
export function encryptPayload(plaintext: Buffer, sub: PushSubscriptionJson, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // Último (e único) registro: o texto seguido do delimitador 0x02, sem enchimento.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number; error: string };

/** O mínimo do fetch que o envio usa (o global do Node; nos testes, um falso). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; signal?: AbortSignal }) => Promise<{ status: number }>;

/**
 * Manda uma notificação (`payload`, JSON) para a assinatura. `gone`: o serviço diz que a assinatura acabou (404/410),
 * então ela sai da lista. `topic` substitui uma notificação ainda não entregue com o mesmo tópico.
 */
export async function sendPush(
  sub: PushSubscriptionJson,
  payload: object,
  v: VapidKeys,
  opts: { now: number; contact: string; topic?: string; ttlSeconds?: number; fetch?: FetchLike; timeoutMs?: number },
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub);
  const headers: Record<string, string> = {
    TTL: String(opts.ttlSeconds ?? 3600),
    Urgency: 'high',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(sub.endpoint, v, opts.now, opts.contact),
  };
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  try {
    const res = await doFetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: (err as Error).message || String(err) };
  }
}
