/**
 * sw.js — Service Worker avanzado
 * - Precaching del app shell (offline-first).
 * - Estrategia stale-while-revalidate para assets.
 * - Estrategia network-first + cache fallback para API NHTSA.
 * - Notificaciones locales con mensaje específico por tipo de mantenimiento.
 */

const SHELL_CACHE = 'garage-shell-v2';
const API_CACHE = 'nhtsa-api-cache-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API NHTSA -> network-first, cae a caché si falla la red.
  if (url.hostname.includes('vpic.nhtsa.dot.gov')) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(request);
          return cached || new Response(JSON.stringify({ Results: [] }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })
    );
    return;
  }

  // App shell -> stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});

/**
 * Recibe alertas específicas desde app.js y dispara una notificación
 * local por cada una, indicando el tipo exacto de mantenimiento.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SHOW_MAINTENANCE_ALERTS') return;

  const alerts = event.data.alerts || [];
  alerts.slice(0, 5).forEach((message, index) => {
    // Pequeño escalonado para que el SO no colapse las notificaciones en una sola.
    setTimeout(() => {
      self.registration.showNotification('🔧 Mi Garaje — Recordatorio', {
        body: message,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `garage-alert-${index}`,
        renotify: false,
        vibrate: [80, 40, 80],
      });
    }, index * 300);
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) return clientList[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
