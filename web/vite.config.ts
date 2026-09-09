import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect } from 'vite'
import react from '@vitejs/plugin-react'

function rewriteAppPath(): Connect.NextHandleFunction {
  return (req, _res, next) => {
    const raw = req.url || ''
    const q = raw.indexOf('?')
    const pathname = q === -1 ? raw : raw.slice(0, q)
    const search = q === -1 ? '' : raw.slice(q)
    if (pathname === '/app' || pathname.startsWith('/app/')) {
      req.url = `/app.html${search}`
    }
    next()
  }
}

function appHtmlPlugin() {
  return {
    name: 'nod-app-html',
    configureServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(rewriteAppPath())
    },
    configurePreviewServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(rewriteAppPath())
    },
  }
}

export default defineConfig({
  plugins: [react(), appHtmlPlugin()],
  resolve: {
    alias: {
      // Always the real registerPlugin('NodMic') from this checkout. A stub here
      // made start()/startUplink() resolve without native capture or /ws/audio.
      'nod-mic': fileURLToPath(new URL('../plugins/nod-mic/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:9320', ws: true },
      '/api': { target: 'http://127.0.0.1:9320' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app.html', import.meta.url)),
      },
    },
  },
})
