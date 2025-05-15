const CACHE_NAME = '14-high-v2.1.2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
];

// Install event - cache app shell
self.addEventListener('install', event => {
  console.log('[Service Worker] Installing Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Caching app shell...');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => {
        console.log('[Service Worker] App shell cached successfully');
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activating Service Worker...');
  event.waitUntil(
    caches.keys()
      .then(keyList => {
        return Promise.all(keyList.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache', key);
            return caches.delete(key);
          }
        }));
      })
      .then(() => {
        console.log('[Service Worker] Claiming clients...');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache first, then network
self.addEventListener('fetch', event => {
  // Handle HTML navigation requests (document requests) differently
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // If fetch fails (offline), show the offline page
          return caches.match('/offline.html');
        })
    );
    return; // Skip the rest of the function
  }
  
  // Handle all other requests
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return the response from cache
        if (response) {
          return response;
        }
        
        // Clone the request because it's a one-time use stream
        const fetchRequest = event.request.clone();
        
        // Make network request and cache the response
        return fetch(fetchRequest)
          .then(response => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // Clone the response because it's a one-time use stream
            const responseToCache = response.clone();
            
            // Open cache and store the new response
            caches.open(CACHE_NAME)
              .then(cache => {
                // Don't cache cross-origin resources like Google Fonts and Font Awesome CSS
                if (event.request.url.startsWith(self.location.origin)) {
                  cache.put(event.request, responseToCache);
                }
              });
            
            return response;
          })
          .catch(error => {
            console.log('[Service Worker] Fetch failed:', error);
            
            // For API requests or other non-HTML resources, we can return a custom response
            if (event.request.headers.get('accept').includes('text/html')) {
              return caches.match('/offline.html');
            }
            
            // If it's an image request, you could return a placeholder image from cache
            if (event.request.headers.get('accept').includes('image/')) {
              return new Response('Not available while offline', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: new Headers({
                  'Content-Type': 'text/plain'
                })
              });
            }
          });
      })
  );
}); 
