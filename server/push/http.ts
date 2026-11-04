// Rotas das notificações no celular (Web Push). A trava (porta local com Host local, ou a porta do celular com login)
// já foi conferida em http/app.ts; o guard (http/guard.ts) já exigiu JSON e a mesma origem nos POST (contra CSRF).
//
//   GET  /api/push              {publicKey}: a chave VAPID para a página assinar
//   POST /api/push/subscribe    {subscription}: 201 {ok} | 400 (assinatura inválida ou de serviço desconhecido)
//   POST /api/push/unsubscribe  {endpoint}: 200 {ok, removed}
//   POST /api/push/status       {endpoint}: 200 {subscribed}
//   POST /api/push/test         {endpoint}: 200 {ok} | 404 (aparelho não assinado) | 502 (o serviço de push recusou)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import type { PushService } from './service';

function endpointOf(body: unknown): string {
  const e = body && typeof body === 'object' ? (body as Record<string, unknown>).endpoint : undefined;
  if (typeof e !== 'string' || !e || e.length > 2048) throw new HttpError(400, tr('esperado {endpoint: string}'));
  return e;
}

export function createPushRoutes(push: PushService): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const handle = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const method = req.method ?? 'GET';
    if (path === '/api/push') {
      if (method !== 'GET') throw new HttpError(405, tr('método não permitido'));
      return sendJson(res, 200, { publicKey: push.publicKey });
    }
    if (method !== 'POST') throw new HttpError(405, tr('método não permitido'));
    const body = await readJson(req);
    switch (path) {
      case '/api/push/subscribe': {
        const sub = body && typeof body === 'object' ? (body as Record<string, unknown>).subscription : undefined;
        if (!push.subscribe(sub)) throw new HttpError(400, tr('assinatura de push inválida ou de um serviço desconhecido'));
        return sendJson(res, 201, { ok: true });
      }
      case '/api/push/unsubscribe':
        return sendJson(res, 200, { ok: true, removed: push.unsubscribe(endpointOf(body)) });
      case '/api/push/status':
        return sendJson(res, 200, { subscribed: push.has(endpointOf(body)) });
      case '/api/push/test': {
        const r = await push.test(endpointOf(body));
        if (!r) return sendJson(res, 404, { error: tr('este aparelho não está assinado') });
        if (!r.ok) return sendJson(res, 502, { error: tr('o serviço de push recusou a mensagem ({0})', [r.error]) });
        return sendJson(res, 200, { ok: true });
      }
      default:
        throw new HttpError(404, tr('rota desconhecida'));
    }
  };
  return (req, res, path) => {
    handle(req, res, path).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) {
        if (err.status === 405) res.setHeader('Allow', path === '/api/push' ? 'GET' : 'POST');
        sendJson(res, err.status, { error: err.message });
      } else sendJson(res, 500, { error: tr('erro interno') });
    });
  };
}
