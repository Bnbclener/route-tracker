const CACHE_NAME = 'route-tracker-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app-main.js',
  './core/geo.js',
  './core/stop-detector.js',
  './core/address-matcher.js',
  './core/learner.js',
  './core/optimizer.js',
  './core/storage-adapter.js',
  './core/traccar-adapter.js',
  './core/file-import.js',
  './core/index.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
