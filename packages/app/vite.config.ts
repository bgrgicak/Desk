/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// In dev, everything flows through the Vite port (5173 by default, or
// whatever DESK_APP_PORT is set to — e2e uses that to pick an isolated
// port) so VS Code Remote only needs one tunnel. Calls the app makes
// under /api/* get stripped of that prefix and proxied to the
// desk-server. WebSocket calls to /ws are proxied verbatim with WS
// upgrade support.
const API_TARGET = process.env.DESK_API_URL ?? 'http://127.0.0.1:35138'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')
const APP_PORT = Number(process.env.DESK_APP_PORT ?? 5173)

// Hosts the dev/preview servers will accept in the Host header. Comma-
// separated list via DESK_ALLOWED_HOSTS, e.g. "desk.test,desk.local".
// Defaults to "desk.test" so the bundled nginx fixture keeps working
// without any env setup.
const ALLOWED_HOSTS = (process.env.DESK_ALLOWED_HOSTS ?? 'desk.test')
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
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
  '/ws': {
    target: WS_TARGET,
    ws: true,
    changeOrigin: true,
  },
  // Static-app routes (issue #47, PR-C). Same-origin serving so the iframe
  // session cookie is path-scoped to the app and `fetch('/api/...')` calls
  // from inside the iframe go through the same Vite proxy.
  '/apps': {
    target: API_TARGET,
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Resolve workspace deps (@agent-desk/shared, @agent-desk/db) via the `@agent-desk/dev`
    // export condition so Vite pulls TS source from each package's src/
    // directly. Without this it walks the default `import` condition
    // (e.g. @agent-desk/shared/dist/index.js), which only exists after a
    // separate `tsc` build of the package — and silently goes stale.
    conditions: ['@agent-desk/dev'],
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
