// Service worker do Habblaud: só as notificações no celular (Web Push, server/push e client/src/ui/push.ts). Não guarda
// nada em cache nem intercepta requisições. Cada push vira uma notificação (o iPhone exige que todo push mostre uma);
// tocar nela traz o Habblaud para a frente no agente do aviso (?agent=, client/src/ui/index.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Habblaud';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      data: { url: typeof data.url === 'string' ? data.url : '/' },
      icon: '/assets/brand/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) {
          await w.focus();
          w.postMessage({ type: 'habblaud:open', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
