const CACHE_NAME = 'quan-ai-dynamic-v34'; // Bumped to v34 to force the new strategy to activate
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/pages/home.html',
  '/pages/login.html',
  '/pages/settings.html',
  '/pages/setup.html',
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

// 2. Activate Event: Clean up any old caches
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

// 3. Fetch Event: STALE-WHILE-REVALIDATE (Kills the native loading bar)
self.addEventListener('fetch', (event) => {
  // Only intercept standard GET requests
  if (event.request.method !== 'GET') return;

  // Prevent caching browser extensions or external non-http schemes
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      
      // Kick off a background network request to fetch the freshest data
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        
        // Safety Check: Only cache valid, successful responses
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        // THE FIX: Clone the response IMMEDIATELY before the stream is consumed by the browser
        const responseToCache = networkResponse.clone();

        caches.open(CACHE_NAME).then((cache) => {
          // Update the cache silently in the background so the next launch is up-to-date
          cache.put(event.request, responseToCache);
        });
        
        return networkResponse;
      }).catch((error) => {
        console.log('[Quan AI] Offline, sticking to cache for:', event.request.url);
      });

      // THE MAGIC TRICK: Return the cached response INSTANTLY if we have it.
      // If we don't have it in the cache yet (e.g., very first launch), fall back to the network.
      return cachedResponse || fetchPromise;
    })
  );
});
