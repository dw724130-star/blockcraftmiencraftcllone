const CACHE_NAME = 'blockcraft-v17';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/main.js',
  './js/panorama.js',
  './js/blocks.js',
  './js/textures.js',
  './js/noise.js',
  './js/world.js',
  './js/audio.js',
  './js/recipes.js',
  './js/inventory.js',
  './js/mobs.js',
  './js/player.js',
  './js/controls.js',
  './js/sky.js',
  './js/effects.js',
  './js/mods.js',
  './js/storage.js',
  './js/ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
