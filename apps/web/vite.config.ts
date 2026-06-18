import { appendFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// TEMP: sink for window-resize diagnostics (src/debug/pointerLog.ts) — remove when done.
// Appends browser-side pointer/geometry events to /tmp/axel-uilog.jsonl.
const uilogSink = (): Plugin => ({
  name: 'uilog-sink',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/__uilog' || req.method !== 'POST') return next()
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const { sess, entries } = JSON.parse(body) as { sess: string; entries: Array<Record<string, unknown>> }
          appendFileSync('/tmp/axel-uilog.jsonl', entries.map(e => JSON.stringify({ sess, ...e })).join('\n') + '\n')
        } catch { /* ignore malformed */ }
        res.statusCode = 204
        res.end()
      })
    })
  },
})

export default defineConfig({
  plugins: [react(), basicSsl(), uilogSink()],
  server: {
    host: '0.0.0.0',
    port: 5183,
    proxy: {
      '/api': { target: 'http://localhost:8090', changeOrigin: true, secure: false },
      '/auth': { target: 'http://localhost:8090', changeOrigin: true, secure: false },
      '/stt': { target: 'http://localhost:8090', changeOrigin: true, secure: false },
      '/healthz': { target: 'http://localhost:8090', changeOrigin: true, secure: false },
      '/tts': { target: 'http://localhost:8090', changeOrigin: true, secure: false },
      '/agent': { target: 'http://localhost:8090', changeOrigin: true, secure: false, ws: true },
    },
  },
})
