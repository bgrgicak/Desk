// Roomy PWA service worker.
//
// Caching strategy:
//   - Hashed /assets/* (Vite build outputs): cache-first. The hash is the
//     version, so anything in cache is by definition still correct.
//   - Static shell files (icons, manifest, favicon, fonts): stale-while-
//     revalidate. Served instantly from cache; revalidated in the
//     background so the next visit picks up changes.
//   - Navigation requests (HTML): network-first. We try the network so a
//     deployed update is picked up, and fall back to the cached
//     /index.html shell when offline (the SPA boots and React Router
//     resolves the deep link client-side).
//   - /api/*, /apps/*, /ws*: passthrough. Live data, generated app
//     iframes/assets, and the websocket upgrade must hit the network
//     unmediated — caching them would serve stale or wrong content and
//     the SW can't proxy a WS upgrade anyway.
//
// Update flow:
//   On install we precache the shell and call self.skipWaiting() so the
//   new SW activates immediately. service-worker.ts detects the resulting
//   controllerchange event and reloads the page, giving users the new
//   build without any manual "Reload" prompt.
//
// VERSION is substituted at build time by the inject-sw-version plugin
// in vite.config.ts; in unbuilt copies it stays as the literal placeholder
// (the SW only runs from a production build, so that's fine).
const VERSION = '__APP_VERSION__';
// STATIC_ASSET_REVISION is a build-time hash of the app shell files below.
// It makes icon/manifest/favicon-only releases produce a new SW byte stream
// and a fresh cache even when package.json#version has not changed.
const STATIC_ASSET_REVISION = '__STATIC_ASSET_REVISION__';
const CACHE_NAME = `roomy-app-${VERSION}-${STATIC_ASSET_REVISION}`;
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  // Precache the shell so a cold offline reload still resolves the SPA
  // boot. skipWaiting() activates the new SW immediately so users never
  // run old code just because they ignored an update prompt.
  event.waitUntil(
    Promise.all([
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.addAll(SHELL_URLS))
        .catch(() => {}),
      self.skipWaiting(),
    ]),
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

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  // The page asks the waiting worker for its version so the update toast
  // can show the new version, not the running bundle's old one.
  if (event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

function isNavigationRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return req.method === 'GET' && accept.includes('text/html');
}

function isHashedAsset(url) {
  // Vite emits hashed files under /assets/. Anything that lands there is
  // immutable for the lifetime of the build.
  return url.pathname.startsWith('/assets/');
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
  }
  return res;
}

async function staleWhileRevalidate(req) {
  const cached = await caches.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  return Response.error();
}

async function networkFirstNavigation(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/apps/') ||
    url.pathname.startsWith('/ws')
  ) return;

  if (isNavigationRequest(req)) {
    event.respondWith(networkFirstNavigation(req));
    return;
  }
  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
