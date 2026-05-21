import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Multi-entry build:
//   - index.html        → the full app SPA (built to dist/index.html)
//   - fragments/<name>/index.html → each fragment's standalone build
//     (output at dist/fragments/<name>/index.html)
//
// We discover fragments dynamically so the agent can drop a new
// fragments/<name>/ directory and a rebuild picks it up without
// editing this file.
const fragmentsDir = path.resolve(__dirname, 'fragments')
const fragmentEntries: Record<string, string> = {}
if (fs.existsSync(fragmentsDir)) {
  for (const name of fs.readdirSync(fragmentsDir)) {
    const html = path.join(fragmentsDir, name, 'index.html')
    if (fs.existsSync(html)) {
      fragmentEntries[`fragments/${name}`] = html
    }
  }
}

export default defineConfig({
  // Relative base so the built dist/ serves correctly under either
  // `/apps/library/<name>/dist/...` or `/apps/chat/<chatId>/<name>/dist/...`
  // without a rebuild.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        ...fragmentEntries,
      },
    },
  },
})
