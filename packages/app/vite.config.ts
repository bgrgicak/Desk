/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

// Read the app's version once at config time so it can be inlined into
// both the React bundle (via `define`) and the service worker (via the
// post-build plugin below). The SW uses it as a cache key + the page
// uses it to decide if there is a real update waiting.
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string

// The public/sw.js source ships with a literal `__APP_VERSION__`
// placeholder. After Vite copies it into dist/ we rewrite that token to
// the real version — the cache name keys off it, so each released
// version gets its own cache and the previous one is dropped on
// activate. Build-only: dev never serves the SW (see main.tsx).
function injectServiceWorkerVersion() {
  return {
    name: 'inject-sw-version',
    apply: 'build' as const,
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/sw.js')
      if (!fs.existsSync(swPath)) return
      const original = fs.readFileSync(swPath, 'utf8')
      const staticAssetRevision = hashStaticShellAssets()
      const updated = original
        .replace(/__APP_VERSION__/g, APP_VERSION)
        .replace(/__STATIC_ASSET_REVISION__/g, staticAssetRevision)
      if (updated !== original) fs.writeFileSync(swPath, updated)
    },
  }
}

function hashStaticShellAssets(): string {
  const files = [
    'index.html',
    'manifest.webmanifest',
    'favicon.svg',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
  ]
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    const filePath = path.resolve(__dirname, 'dist', file)
    hash.update(file)
    hash.update('\0')
    hash.update(fs.readFileSync(filePath))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

// In dev, everything flows through the Vite port (5173 by default, or
// whatever ROOMY_APP_PORT is set to — e2e uses that to pick an isolated
// port) so VS Code Remote only needs one tunnel. Calls the app makes
// under /api/* get stripped of that prefix and proxied to the
// roomy-server. WebSocket calls to /ws are proxied verbatim with WS
// upgrade support.
const API_TARGET = process.env.ROOMY_API_URL ?? 'http://127.0.0.1:35138'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')
const APP_PORT = Number(process.env.ROOMY_APP_PORT ?? 5173)

// Hosts the dev/preview servers will accept in the Host header. Comma-
// separated list via ROOMY_ALLOWED_HOSTS, e.g. "roomy.test,roomy.local".
// Defaults to "roomy.test" so the bundled nginx fixture keeps working
// without any env setup.
const ALLOWED_HOSTS = (process.env.ROOMY_ALLOWED_HOSTS ?? 'roomy.test')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

// The dev and preview commands each have their own proxy section —
// `vite preview` doesn't honour `server.proxy`, so the tests (which run
// against the preview server) need their own copy.
const proxy = {
  '/api': {
    target: API_TARGET,
    changeOrigin: true,
    xfwd: true,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
  '/ws': {
    target: WS_TARGET,
    ws: true,
    changeOrigin: true,
    xfwd: true,
  },
  // Static-app routes (issue #47, PR-C). Same-origin serving so the iframe
  // session cookie is path-scoped to the app and `fetch('/api/...')` calls
  // from inside the iframe go through the same Vite proxy.
  '/apps': {
    target: API_TARGET,
    changeOrigin: true,
    xfwd: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectServiceWorkerVersion()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Resolve workspace deps (@roomy-ai/shared, @roomy-ai/db) via the `@roomy-ai/dev`
    // export condition so Vite pulls TS source from each package's src/
    // directly. Without this it walks the default `import` condition
    // (e.g. @roomy-ai/shared/dist/index.js), which only exists after a
    // separate `tsc` build of the package — and silently goes stale.
    conditions: ['@roomy-ai/dev'],
  },
  // Bind explicitly to 127.0.0.1 (default `host: false` resolves
  // `localhost` and on stock GH runners that lands on ::1 only — the e2e
  // fixture probes 127.0.0.1 and would never see the server).
  server: { host: '127.0.0.1', port: APP_PORT, strictPort: true, proxy, allowedHosts: ALLOWED_HOSTS },
  preview: { host: '127.0.0.1', port: APP_PORT, strictPort: true, proxy, allowedHosts: ALLOWED_HOSTS },
  // Vitest config — exclude Playwright e2e specs (they live under e2e/
  // and use Playwright's `test()`, which Vitest can't run). Without this
  // exclude, vitest tries to import each Playwright spec, fails to
  // resolve `test()`, and reports the whole file as a failed collection
  // even though the actual unit tests inside src/ are green.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'e2e/**',
    ],
  },
} as any)
