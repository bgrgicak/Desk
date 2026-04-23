import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// In dev, everything flows through the Vite port (5173/5174) so VS Code
// Remote only needs one tunnel. Calls the app makes under /api/* get
// stripped of that prefix and proxied to the desk-server. WebSocket calls
// to /ws are proxied verbatim with WS upgrade support.
const API_TARGET = process.env.DESK_API_URL ?? 'http://127.0.0.1:3013'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/ws': {
        target: WS_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
