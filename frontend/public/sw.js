/* TradePilot service worker — app-shell cache only.
 *
 * Safety contract for a trading terminal:
 *  - Never intercept /api or /ws. Those must always hit the network so that a
 *    disconnected or stale terminal shows "unavailable" rather than a cached,
 *    misleading price or account state.
 *  - Only cache the immutable shell: static chunks, icons, the manifest and
 *    pre-rendered page shells.
 *  - Navigations are network-first, falling back to the cached shell so the app
 *    still opens offline (where it then clearly reports the connection is down).
 */
const CACHE = 'tradepilot-shell-v1';
const SHELL = ['/', '/dashboard', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations

  const url = new URL(request.url);

  // Live data must always be fresh. Let the app surface "unavailable" offline.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Never cache dev-only hot-reload artifacts, which change every compile.
  if (url.pathname.includes('webpack') || url.pathname.includes('hot-update') || url.pathname.startsWith('/__next')) return;

  // Page navigations: network first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/dashboard'))
        )
    );
    return;
  }

  // Same-origin static assets: cache first, then network.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
      )
    );
  }
});
