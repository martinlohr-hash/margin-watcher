// Service Worker — Margin Watcher
// Cacht statische Assets für Offline-Zugriff auf das UI

const CACHE = 'margin-watcher-v1';
const STATIC = [
  './',
  './index.html',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // GAS API-Calls nie cachen — immer live
  if (url.hostname.includes('script.google.com')) return;

  // Cache-First für statische Assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
