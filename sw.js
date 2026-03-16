const CACHE_NAME = 'quan-ai-core-v5';
const DYNAMIC_CACHE = 'quan-ai-dynamic-v1';

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/pages/home.html',
  '/pages/login.html',
  '/config.js',
  '/images/icon.png',
  '/manifest.json'
];

// 1. Install Event: Cache the essential assets initially
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Quan AI] Service Worker Installed & Caching Assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // Force the new service worker to activate immediately
});

// 2. Activate Event: Clean up ANY old caches to free up memory
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME && key !== DYNAMIC_CACHE) {
            console.log('[Quan AI] Clearing Old Cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim(); // Take control of all open pages right away
});

// 3. Fetch Event: ADVANCED ROUTING (Stale-While-Revalidate + Network First)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // STRATEGY 1: Network First (For HTML files so you always get the latest code)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          return networkResponse;
        })
        .catch(() => {
          // If offline, return the cached HTML
          return caches.match(event.request);
        })
    );
  } 
  // STRATEGY 2: Cache First, Update in Background (For Images, JS, CSS, Icons)
  else {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        // Return instantly from cache if found
        const networkFetch = fetch(event.request).then((networkResponse) => {
          // Silently update the cache in the background for next time
          caches.open(DYNAMIC_CACHE).then((cache) => cache.put(event.request, networkResponse.clone()));
          return networkResponse;
        }).catch(() => null);

        return cachedResponse || networkFetch;
      })
    );
  }
});
