// Web Push (webpush.ts): o vetor de teste da RFC 8291 (apêndice A), o JWT do VAPID conferido com a chave pública, a
// lista de serviços de push aceitos e o envio contra um fetch falso.
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, sendPush, validSubscription, vapidAuthorization, type PushSubscriptionJson } from './webpush';

const b = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291, apêndice A.
const RFC_SUB: PushSubscriptionJson = {
  endpoint: 'https://web.push.apple.com/QGF2YXN0',
  keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
};

describe('encryptPayload (RFC 8291)', () => {
  it('o vetor do apêndice A: mesma mensagem cifrada, byte a byte', () => {
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), RFC_SUB, {
      asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
    });
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('sem chave fixa: chave efêmera e sal novos a cada mensagem', () => {
    const a = encryptPayload(Buffer.from('oi'), RFC_SUB);
    const c = encryptPayload(Buffer.from('oi'), RFC_SUB);
    expect(a.equals(c)).toBe(false);
    expect(a.readUInt32BE(16)).toBe(4096);
    expect(a[20]).toBe(65);
  });
});

describe('VAPID', () => {
  it('JWT ES256 com aud = origem do serviço, exp em até 24 h e sub; a assinatura confere com a chave pública', () => {
    const v = generateVapidKeys();
    const now = 1_790_000_000_000;
    const auth = vapidAuthorization('https://web.push.apple.com/abc?x=1', v, now, 'https://github.com/marmottajr/habblaud');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m).toBeTruthy();
    const claims = JSON.parse(b(m[2]).toString());
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe('https://github.com/marmottajr/habblaud');
    expect(claims.exp - now / 1000).toBeGreaterThan(0);
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(m[4]).toBe(v.publicKey);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.privateJwk.x, y: v.privateJwk.y }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(m[3]))).toBe(true);
    expect(b(v.publicKey).length).toBe(65);
  });
});

describe('validSubscription', () => {
  it('só serviços de push conhecidos, por https, com as chaves no tamanho certo', () => {
    expect(validSubscription(RFC_SUB)).toBe(true);
    expect(validSubscription({ ...RFC_SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/x' })).toBe(true);
    expect(validSubscription({ ...RFC_SUB, endpoint: 'http://web.push.apple.com/x' })).toBe(false);
    expect(validSubscription({ ...RFC_SUB, endpoint: 'https://127.0.0.1/x' })).toBe(false);
    expect(validSubscription({ ...RFC_SUB, endpoint: 'https://web.push.apple.com.evil.example/x' })).toBe(false);
    expect(validSubscription({ ...RFC_SUB, endpoint: 'https://user:pw@web.push.apple.com/x' })).toBe(false);
    expect(validSubscription({ ...RFC_SUB, keys: { ...RFC_SUB.keys, auth: 'AAAA' } })).toBe(false);
    expect(validSubscription({ endpoint: RFC_SUB.endpoint })).toBe(false);
    expect(validSubscription(null)).toBe(false);
  });
});

describe('sendPush', () => {
  it('POST cifrado com TTL, Urgency, Topic e VAPID; 201 = ok, 410 = assinatura acabou', async () => {
    const v = generateVapidKeys();
    const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    let status = 201;
    const fake = async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status };
    };
    const opts = { now: Date.now(), contact: 'https://github.com/marmottajr/habblaud', topic: 'habblaud-a:1', fetch: fake };
    expect(await sendPush(RFC_SUB, { title: 'x' }, v, opts)).toEqual({ ok: true });
    expect(calls[0].url).toBe(RFC_SUB.endpoint);
    expect(calls[0].headers).toMatchObject({ TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', Topic: 'habblaud-a1' });
    expect(calls[0].headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(calls[0].body.includes(Buffer.from('title'))).toBe(false);
    status = 410;
    expect(await sendPush(RFC_SUB, { title: 'x' }, v, opts)).toMatchObject({ ok: false, gone: true, status: 410 });
    status = 500;
    expect(await sendPush(RFC_SUB, { title: 'x' }, v, opts)).toMatchObject({ ok: false, gone: false, status: 500 });
  });
});
