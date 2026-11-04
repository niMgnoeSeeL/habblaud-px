// Notificações no celular (Web Push): a página assina o push do aparelho (PushManager) com a chave VAPID do servidor e
// manda a assinatura a /api/push/subscribe; o service worker (/sw.js, client/public/sw.js) mostra cada aviso que o
// servidor mandar (server/push: "precisa de você" e "concluiu", com o Mac parado). No iPhone só existe no app da Tela de
// Início (iOS 16.4+) e por HTTPS, como o acesso do celular (npm run remote:setup) já é.
import { tr } from '../../../shared/i18n';

/**
 * - unsupported: o navegador não tem push;
 * - insecure: a página não está num contexto seguro (HTTPS ou localhost);
 * - install: iPhone/iPad fora do app da Tela de Início (lá o Safari não oferece push);
 * - denied: o aparelho bloqueou as notificações do Habblaud;
 * - off / on: dá para ligar / está ligado (este aparelho assinado no servidor).
 */
export type PushState = 'unsupported' | 'insecure' | 'install' | 'denied' | 'off' | 'on';

export interface PushEnv {
  secure: boolean;
  /** iPhone ou iPad (o iPad se diz Mac com toque). */
  ios: boolean;
  /** Aberto como app (Tela de Início): display-mode standalone. */
  standalone: boolean;
  hasPush: boolean;
  permission: NotificationPermission | 'unsupported';
}

/** O que dá para fazer neste aparelho, antes de saber se ele já está assinado. */
export function pushSupport(env: PushEnv): Exclude<PushState, 'on'> {
  if (!env.secure) return 'insecure';
  if (env.ios && !env.standalone) return 'install';
  if (!env.hasPush || env.permission === 'unsupported') return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'off';
}

/** A dica embaixo do interruptor, para cada estado. */
export function pushHint(state: PushState): string {
  switch (state) {
    case 'unsupported':
      return tr('Este navegador não recebe notificações push.');
    case 'insecure':
      return tr('Precisa do acesso do celular por HTTPS (npm run remote:setup).');
    case 'install':
      return tr('No iPhone: Compartilhar › Adicionar à Tela de Início, e abra o Habblaud por lá.');
    case 'denied':
      return tr('Bloqueadas no aparelho: libere em Ajustes › Notificações › Habblaud.');
    default:
      return tr('Avisa no celular quando alguém precisa de você ou termina o que estava fazendo, se o Mac estiver parado há 2 min.');
  }
}

/** Chave VAPID (base64url) no formato que o PushManager pede. */
export function vapidKeyBytes(key: string): Uint8Array {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function currentEnv(): PushEnv {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    secure: window.isSecureContext,
    ios,
    standalone,
    hasPush: 'serviceWorker' in navigator && 'PushManager' in window,
    permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  };
}

async function postJson(path: string, body: object): Promise<Response> {
  return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function errorOf(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    return typeof j.error === 'string' ? j.error : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export class PushControl {
  /** Antes da primeira conferência: só o que o navegador oferece (sem saber da assinatura). */
  state: PushState = typeof navigator === 'object' && typeof matchMedia === 'function' ? pushSupport(currentEnv()) : 'unsupported';
  busy = false;

  /** Confere o estado (o aparelho assinado e o servidor ainda com a assinatura). */
  async refresh(): Promise<PushState> {
    const base = pushSupport(currentEnv());
    if (base !== 'off') return (this.state = base);
    const sub = await this.subscription();
    if (!sub) return (this.state = 'off');
    try {
      const res = await postJson('/api/push/status', { endpoint: sub.endpoint });
      const j = res.ok ? ((await res.json()) as { subscribed?: boolean }) : {};
      return (this.state = j.subscribed ? 'on' : 'off');
    } catch {
      return (this.state = 'off');
    }
  }

  /** Liga: pede a permissão (precisa vir de um toque), assina o push e manda a assinatura ao servidor. */
  async enable(): Promise<string | undefined> {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      await this.refresh();
      return tr('Notificações bloqueadas no aparelho.');
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const keyRes = await fetch('/api/push', { credentials: 'same-origin', cache: 'no-store' });
      if (!keyRes.ok) return await errorOf(keyRes);
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(publicKey) as BufferSource }));
      const res = await postJson('/api/push/subscribe', { subscription: sub.toJSON() });
      if (!res.ok) return await errorOf(res);
      this.state = 'on';
      return undefined;
    } catch (err) {
      return (err as Error).message || String(err);
    } finally {
      await this.refresh();
    }
  }

  /** Desliga: tira a assinatura do servidor e do aparelho. */
  async disable(): Promise<void> {
    const sub = await this.subscription();
    if (sub) {
      await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe().catch(() => false);
    }
    await this.refresh();
  }

  /** "Mandar um teste": o servidor manda um push só para este aparelho. undefined = foi. */
  async test(): Promise<string | undefined> {
    const sub = await this.subscription();
    if (!sub) return tr('este aparelho não está assinado');
    const res = await postJson('/api/push/test', { endpoint: sub.endpoint });
    return res.ok ? undefined : await errorOf(res);
  }

  private async subscription(): Promise<PushSubscription | null> {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return (await reg?.pushManager.getSubscription()) ?? null;
  }
}
