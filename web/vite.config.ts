import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * `src/` is compiled by tsc with NodeNext, so its relative imports carry a
 * `.js` extension. The browser bundle shares that code, so teach Vite to look
 * for the TypeScript file behind those specifiers.
 */
const resolveTsBehindJs = (): Plugin => ({
  name: 'resolve-ts-behind-js',
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'))
    return existsSync(candidate) ? candidate : null
  },
})

export default defineConfig({
  root: import.meta.dirname,
  plugins: [resolveTsBehindJs(), react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4571',
    },
  },
})
