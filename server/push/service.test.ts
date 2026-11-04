// Notificações no celular (service.ts): push.json em modo 600 com as chaves VAPID, assinaturas válidas só de serviços de
// push conhecidos, o aviso só com o Mac parado (ou sem como saber), a assinatura encerrada (410) saindo da lista e o
// teste só para o aparelho que pediu.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Notice } from '../../shared/types';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { IDLE_MS, MAX_SUBSCRIPTIONS, PushService } from './service';

setQuiet(true);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const sub = (n = 1) => ({ endpoint: `https://web.push.apple.com/dev${n}`, keys: KEYS });
const notice: Notice = { id: 'n-1', level: 'alert', text: '✋ Ana precisa de você em loja: aprovar uma permissão', at: 1, agentId: '.claude:42', roomId: '/r' };

function make(opts: { idle?: number | undefined; status?: number } = {}) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const file = join(tmp.dir, 'push.json');
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const state = { idle: 'idle' in opts ? opts.idle : 10 * 60_000, status: opts.status ?? 201 };
  const push = new PushService({
    file,
    idle: async () => state.idle,
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers });
      return { status: state.status };
    },
  });
  return { push, file, sent, state };
}

describe('PushService', () => {
  it('push.json em modo 600 com o par VAPID; o mesmo par ao reabrir', () => {
    const { push, file } = make();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.vapid.publicKey).toBe(push.publicKey);
    expect(new PushService({ file, idle: async () => 0 }).publicKey).toBe(push.publicKey);
  });

  it('assina só serviços de push conhecidos; a mesma de novo não duplica; no máximo MAX_SUBSCRIPTIONS', () => {
    const { push } = make();
    expect(push.subscribe({ endpoint: 'https://example.com/x', keys: KEYS })).toBe(false);
    expect(push.subscribe(sub(1))).toBe(true);
    expect(push.subscribe(sub(1))).toBe(true);
    expect(push.count).toBe(1);
    for (let i = 2; i <= MAX_SUBSCRIPTIONS + 3; i++) push.subscribe(sub(i));
    expect(push.count).toBe(MAX_SUBSCRIPTIONS);
    expect(push.has(sub(1).endpoint)).toBe(false);
    expect(push.unsubscribe(sub(MAX_SUBSCRIPTIONS + 3).endpoint)).toBe(true);
    expect(push.unsubscribe('https://web.push.apple.com/nada')).toBe(false);
  });

  it('com o Mac parado (ou sem como saber), o aviso vai para cada aparelho, com o tópico do agente', async () => {
    const { push, sent, state } = make();
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    await push.notice(notice, 'wait');
    expect(sent.map((s) => s.url)).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent[0].headers.Topic).toBe('habblaud-claude42');
    state.idle = undefined;
    await push.notice(notice, 'done');
    expect(sent).toHaveLength(4);
  });

  it('com o Mac em uso (teclado ou mouse há menos de IDLE_MS), nada sai', async () => {
    const { push, sent } = make({ idle: IDLE_MS - 1 });
    push.subscribe(sub(1));
    await push.notice(notice, 'wait');
    expect(sent).toHaveLength(0);
  });

  it('assinatura encerrada (410) sai da lista e do arquivo', async () => {
    const { push, file } = make({ status: 410 });
    push.subscribe(sub(1));
    await push.notice(notice, 'wait');
    expect(push.count).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions).toEqual([]);
  });

  it('teste: só o aparelho que pediu, mesmo com o Mac em uso; aparelho não assinado = undefined', async () => {
    const { push, sent } = make({ idle: 0 });
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    expect(await push.test(sub(2).endpoint)).toEqual({ ok: true });
    expect(sent.map((s) => s.url)).toEqual([sub(2).endpoint]);
    expect(await push.test('https://web.push.apple.com/nada')).toBeUndefined();
  });
});
