import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Renderer dev/build config. `root` is this folder; the built bundle lands in
// `dist/` (loaded by Electron main in production via loadFile).
export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
  },
})
