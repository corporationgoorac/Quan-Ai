const CACHE_NAME = 'quan-ai-v2'; // CHANGED: Bumping to v2 forces the cache to clear!
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/pages/home.html',
  '/pages/login.html',
  '/config.js',
  '/images/icon.png',
  '/manifest.json'
];

// 1. Install Event: Cache the essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Quan AI: Caching shell assets v2');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // Force the new service worker to activate immediately
});

// 2. Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim(); // Take control of all open pages right away
});

// 3. Fetch Event: Serve from cache first, then network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
