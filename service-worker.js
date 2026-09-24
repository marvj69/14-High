// Keep APP_VERSION in sync with the version badge and the app.js?v= query in
// index.html (tests/release.test.mjs checks this).
const APP_VERSION = '2.6.0';
const CACHE_NAME = `14-high-v${APP_VERSION}`;
const APP_SHELL = './index.html';
const OFFLINE_PAGE = './offline.html';
// Slow networks fall back to the cached app shell after this long; the
// network response still refreshes the cache in the background.
const NAVIGATION_TIMEOUT_MS = 3500;

const REQUIRED_ASSETS_TO_CACHE = [
  APP_SHELL,
  `./app.js?v=${APP_VERSION}`,
  './manifest.json',
  OFFLINE_PAGE,
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  `./vendor/qrcode.min.js?v=${APP_VERSION}`,
  `./vendor/lz-string.min.js?v=${APP_VERSION}`,
  `./vendor/html5-qrcode.min.js?v=${APP_VERSION}`,
  './vendor/fonts/inter.css',
  './vendor/fonts/inter-latin.woff2',
  './vendor/fonts/inter-latin-ext.woff2',
  './vendor/fontawesome/css/all.min.css',
  './vendor/fontawesome/webfonts/fa-solid-900.woff2',
];

const scopeURL = new URL(self.registration.scope);
const appShellPaths = new Set([scopeURL.pathname, `${scopeURL.pathname}index.html`]);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(REQUIRED_ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try {
        await self.registration.navigationPreload.enable();
      } catch (err) {
        // Navigation preload is an optimization only.
      }
    }
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Third-party requests (analytics) go straight to the network.
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const network = fetchNavigation(event);
    event.waitUntil(network.catch(() => {}));
    event.respondWith(respondToNavigation(network));
    return;
  }
  event.respondWith(cacheFirst(event));
});

async function fetchNavigation(event) {
  const response = (await event.preloadResponse) || await fetch(event.request);
  if (response && response.status === 200 && response.type === 'basic' && !response.redirected &&
      appShellPaths.has(new URL(event.request.url).pathname)) {
    // Keep the installed app's offline shell current without delaying the page.
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(APP_SHELL, copy)));
  }
  return response;
}

async function respondToNavigation(network) {
  let timer;
  const timedOut = new Promise(resolve => { timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null); });
  try {
    const response = await Promise.race([network, timedOut]);
    if (response && response.status < 500) return response;
    // Slow network or a server error: use the installed app shell.
    const shell = await caches.match(APP_SHELL, { cacheName: CACHE_NAME });
    return shell || response || await network;
  } catch (err) {
    return (await caches.match(APP_SHELL, { cacheName: CACHE_NAME })) ||
      (await caches.match(OFFLINE_PAGE, { cacheName: CACHE_NAME })) ||
      Response.error();
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (err) {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/html')) {
      const offline = await cache.match(OFFLINE_PAGE);
      if (offline) return offline;
    }
    return new Response('Not available while offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}
