// Notificações no celular (Web Push): guarda o par de chaves VAPID e as assinaturas dos aparelhos em
// <dataDir>/push.json (modo 600) e manda, para cada assinatura, os avisos que pedem você ("precisa de você") e os de
// fim de turno ("concluiu"), os mesmos que o escritório mostra (Office.onNotice). Só com o Mac parado: com teclado ou
// mouse usados nos últimos `idleMs` (macOS, HIDIdleTime do ioreg), nada sai; fora do macOS (no Docker) não há como
// saber, então sai sempre. A assinatura que o serviço de push dá por encerrada (404/410) sai da lista.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Notice } from '../../shared/types';
import { tr } from '../../shared/i18n';
import { log } from '../log';
import { generateVapidKeys, sendPush, validSubscription, type FetchLike, type PushResult, type PushSubscriptionJson, type VapidKeys } from './webpush';

/** Contato do servidor no VAPID (a Apple exige um): a página do projeto, nada da pessoa. */
export const PUSH_CONTACT = 'https://github.com/marmottajr/habblaud';
/** Mac sem uso há pelo menos isto: os avisos vão para o celular. */
export const IDLE_MS = 2 * 60_000;
/** Aparelhos guardados no máximo (a assinatura mais antiga sai). */
export const MAX_SUBSCRIPTIONS = 10;

/** Os avisos que vão ao celular: os que pedem você e os de fim de turno. */
export type PushKind = 'wait' | 'done';

interface StoredSubscription extends PushSubscriptionJson {
  createdAt: number;
}

interface PushFile {
  vapid: VapidKeys;
  subscriptions: StoredSubscription[];
}

/** Há quanto tempo (ms) o Mac não recebe teclado nem mouse; undefined = não dá para saber (outro sistema, erro). */
export type IdleProbe = () => Promise<number | undefined>;

/** macOS: HIDIdleTime do IOHIDSystem (nanossegundos), lido no máximo a cada 5 s. */
export function macIdleProbe(): IdleProbe {
  let cached: { at: number; value: number | undefined } | undefined;
  return () => {
    if (process.platform !== 'darwin') return Promise.resolve(undefined);
    const now = Date.now();
    if (cached && now - cached.at < 5_000) return Promise.resolve(cached.value);
    return new Promise((done) => {
      execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 2_000 }, (err, stdout) => {
        const m = err ? null : /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
        const value = m ? Math.round(Number(m[1]) / 1e6) : undefined;
        cached = { at: Date.now(), value };
        done(value);
      });
    });
  };
}

export interface PushServiceOptions {
  /** <dataDir>/push.json */
  file: string;
  idle?: IdleProbe;
  fetch?: FetchLike;
  now?: () => number;
}

export class PushService {
  private data: PushFile;
  private readonly idle: IdleProbe;
  private readonly now: () => number;

  constructor(private readonly o: PushServiceOptions) {
    this.idle = o.idle ?? macIdleProbe();
    this.now = o.now ?? Date.now;
    this.data = this.load();
  }

  /** Chave pública VAPID (base64url) para a página assinar. */
  get publicKey(): string {
    return this.data.vapid.publicKey;
  }

  get count(): number {
    return this.data.subscriptions.length;
  }

  has(endpoint: string): boolean {
    return this.data.subscriptions.some((s) => s.endpoint === endpoint);
  }

  /** Guarda a assinatura do aparelho (a mesma de novo só atualiza as chaves). false = assinatura inválida. */
  subscribe(v: unknown): boolean {
    if (!validSubscription(v)) return false;
    const sub: StoredSubscription = { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth }, createdAt: this.now() };
    const rest = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.data.subscriptions = [...rest, sub].slice(-MAX_SUBSCRIPTIONS);
    this.save();
    return true;
  }

  unsubscribe(endpoint: string): boolean {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length === before) return false;
    this.save();
    return true;
  }

  /** Um aviso do escritório: vai aos aparelhos se é dos que pedem você ou de fim de turno, e o Mac está parado. */
  async notice(n: Notice, kind: PushKind): Promise<void> {
    if (!this.data.subscriptions.length) return;
    const idle = await this.idle();
    if (idle !== undefined && idle < IDLE_MS) return;
    const payload = {
      title: kind === 'wait' ? tr('Habblaud — precisa de você') : 'Habblaud',
      body: n.text,
      tag: `habblaud-${n.agentId ?? n.roomId ?? n.id}`,
      url: n.agentId ? `/?agent=${encodeURIComponent(n.agentId)}` : '/',
    };
    await this.sendAll(payload, payload.tag);
  }

  /** "Mandar um teste" (Configurações): só para o aparelho que pediu, com ou sem o Mac em uso. */
  async test(endpoint: string): Promise<PushResult | undefined> {
    const sub = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!sub) return undefined;
    const r = await this.sendOne(sub, { title: 'Habblaud', body: tr('Notificações no celular ligadas.'), tag: 'habblaud-test', url: '/' }, 'habblaud-test');
    return r;
  }

  private async sendAll(payload: object, topic: string): Promise<void> {
    await Promise.all(this.data.subscriptions.map((s) => this.sendOne(s, payload, topic)));
  }

  private async sendOne(sub: StoredSubscription, payload: object, topic: string): Promise<PushResult> {
    const r = await sendPush(sub, payload, this.data.vapid, { now: this.now(), contact: PUSH_CONTACT, topic, fetch: this.o.fetch });
    if (!r.ok && r.gone) {
      this.unsubscribe(sub.endpoint);
      log.info(tr('Notificações no celular: um aparelho deixou de receber; a assinatura dele saiu da lista.'));
    } else if (!r.ok) {
      log.warnOnce(`push:${r.status}`, tr('Notificações no celular: o serviço de push recusou a mensagem ({0}).', [r.error]));
    }
    return r;
  }

  private load(): PushFile {
    try {
      const raw = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<PushFile>;
      const vapid = raw.vapid;
      if (vapid && typeof vapid.publicKey === 'string' && vapid.privateJwk && typeof vapid.privateJwk.d === 'string') {
        const subs = Array.isArray(raw.subscriptions) ? raw.subscriptions.filter((s): s is StoredSubscription => validSubscription(s)) : [];
        return { vapid, subscriptions: subs };
      }
    } catch {
      // sem arquivo (ou estragado): chaves novas, e os aparelhos assinam de novo
    }
    const fresh: PushFile = { vapid: generateVapidKeys(), subscriptions: [] };
    this.data = fresh;
    this.save();
    return fresh;
  }

  private save(): void {
    const file = this.o.file;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      log.warnOnce('push-file', tr('Não foi possível gravar {0} ({1}).', [file, (err as NodeJS.ErrnoException).code ?? '?']));
    }
  }
}
