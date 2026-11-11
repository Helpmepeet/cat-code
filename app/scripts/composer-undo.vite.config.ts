import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './', publicDir: false,
  plugins: [react(), tailwindcss()], resolve: { dedupe: ['react', 'react-dom'] },
  build: { rollupOptions: { input: fileURLToPath(new URL('./composer-undo-fixture.html', import.meta.url)) } },
})
