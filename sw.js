const CACHE_NAME = 'route-tracker-v9';
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
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
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

// Réseau d'abord : une nouvelle version publiée s'affiche dès l'ouverture suivante.
// Hors ligne (ou réseau en panne) : on sert la copie en cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
