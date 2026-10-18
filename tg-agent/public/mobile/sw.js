/* Service worker мобильного пульта: показывает push и открывает сайт по нажатию.
   Payload не обязателен: сервер отправляет пустой push, а текст уведомления
   остаётся общим — подробности человек увидит в приложении. */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let title = 'Ассистент'
  let body = 'Новое сообщение в пульте'
  let url = '/mobile/'
  if (event.data) {
    try {
      const payload = event.data.json()
      if (payload && typeof payload.title === 'string') title = payload.title
      if (payload && typeof payload.body === 'string') body = payload.body
      if (payload && typeof payload.url === 'string') url = payload.url
    } catch {
      /* пустой или не-JSON payload — оставляем общий текст */
    }
  }
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/mobile/icons/icon-192.png',
    badge: '/mobile/icons/icon-192.png',
    tag: 'assistant-message',
    renotify: true,
    data: { url }
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/mobile/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(target).catch(() => {})
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target)
  })())
})
