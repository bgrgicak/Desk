import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import * as fs from 'node:fs'
import * as path from 'node:path'

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
