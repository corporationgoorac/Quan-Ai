const CACHE_NAME = 'quan-ai-dynamic-v35'; // Bumped version to force the new code to activate
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

// 3. Fetch Event: Completely Detached Background Update
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // EXCEPTION 1: Ignore Firebase and Firestore API calls entirely
  if (url.hostname.includes('firestore.googleapis.com') || 
      url.hostname.includes('firebaseio.com') || 
      url.hostname.includes('identitytoolkit')) {
      return; 
  }

  // EXCEPTION 2: Only intercept standard GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      
      if (cachedResponse) {
        // THE MAGIC TRICK: event.waitUntil() completely hides this fetch from the browser's UI.
        // The native loading bar will NOT spin for this.
        event.waitUntil(
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse.clone()); // Update cache silently
              });
            }
          }).catch((error) => {
            console.log('[Quan AI] Offline background sync failed, keeping old cache.');
          })
        );
        
        // Return the cached file INSTANTLY. The browser stops the loading bar right here.
        return cachedResponse;
      }

      // IF NOT IN CACHE (e.g., very first launch): We have to fetch it normally.
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      });
    })
  );
});
