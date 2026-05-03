// Minimal service worker for the Desk PWA.
//
// Strategy:
//   - Install: open the cache and warm it with the app shell so a cold
//     offline reload still resolves /, /index.html, /manifest.webmanifest,
//     and the favicon.
//   - Activate: drop any cache that doesn't match CACHE_NAME so a SW
//     bump (rev the constant) flushes the old shell on the next load.
//   - Fetch: network-first for same-origin GETs; on success we tee a copy
//     into the cache (so the next offline load works), on failure we fall
//     back to the cache and finally to /index.html for navigation requests
//     (the SPA boots and React Router resolves the deep link client-side).
//
// Pass-throughs (no SW interception):
//   - Cross-origin requests.
//   - /api/* and /ws — live data and the websocket upgrade must hit the
//     network unmediated; caching API responses would silently serve
//     stale data and the SW can't proxy a WS upgrade anyway.
//
// Bump CACHE_NAME to force clients onto a new cache after a deploy whose
// cache contents you no longer want to serve.
const CACHE_NAME = 'desk-app-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
