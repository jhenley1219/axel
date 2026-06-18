import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import express, { type NextFunction, type Request, type Response } from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { claudeAuthRouter } from './routes/claudeAuth.js'
import { ttsRouter } from './routes/tts.js'
import { networkRouter } from './routes/network.js'
import { mcpPermissionRouter } from './routes/mcpPermission.js'
import { mcpTerminalRouter } from './routes/mcpTerminal.js'
import { mcpFilesRouter } from './routes/mcpFiles.js'
import { mcpAppsRouter } from './routes/mcpApps.js'
import { mcpCleanupRouter } from './routes/mcpCleanup.js'
import { mcpAskRouter } from './routes/mcpAsk.js'
import { mcpQueueRouter } from './routes/mcpQueue.js'
import { mcpReportRouter } from './routes/mcpReport.js'
import { mcpTerminalReadRouter } from './routes/mcpTerminalRead.js'
import { sessionRouter } from './routes/session.js'
import { createAgentWss, handleAgentUpgrade, broadcast } from './routes/agent.js'
import { createPtyWss, handlePtyUpgrade } from './routes/agentPty.js'
import { requestLogger } from './middleware/requestLogger.js'
import { config } from './config.js'
import { settingsManager, mcpRegistry, appBroker, queueBroker } from './services.js'
import { startProjectsWatcher } from './services/ProjectsWatcher.js'
import { getLanIp } from './services/lanIp.js'

const DEV_SECRET = 'dev-secret-change-me'
if (config.sessionSecret === DEV_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[axel] FATAL: SESSION_SECRET is the dev default. Set a real secret in your environment.')
    process.exit(1)
  } else {
    console.warn('[axel] WARNING: SESSION_SECRET not set — using insecure default. Add SESSION_SECRET to .env')
  }
} else {
  // Validate entropy: must be at least 32 chars and look like hex or base64 (not a short dictionary word)
  const secret = config.sessionSecret
  if (secret.length < 32) {
    console.error('[axel] FATAL: SESSION_SECRET must be at least 32 characters')
    process.exit(1)
  }
  if (!/^[A-Za-z0-9+/=_\-]+$/.test(secret)) {
    console.error('[axel] FATAL: SESSION_SECRET contains invalid characters — use a hex or base64 string')
    process.exit(1)
  }
}

const app = express()

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false)

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)

const isPrivateNetwork = (origin: string) =>
  /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)(:\d+)?$/.test(origin)

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      ALLOWED_ORIGINS.includes(origin) ||
      (process.env.NODE_ENV !== 'production' && isPrivateNetwork(origin))
    ) {
      cb(null, true)
    } else {
      cb(null, false)
    }
  },
  credentials: true,
}))

app.use(cookieParser())
// 1 MB is plenty for any of our JSON endpoints (settings, auth code paste,
// TTS text). Bumped from 10 KB which was clipping long settings payloads.
app.use(express.json({ limit: '1mb' }))
app.use(requestLogger)

app.use(healthRouter)
app.use(authRouter)
app.use(claudeAuthRouter)
app.use(ttsRouter)
app.use(networkRouter)
app.use(mcpPermissionRouter)
app.use(mcpTerminalRouter)
app.use(mcpFilesRouter)
app.use(mcpAppsRouter)
app.use(mcpCleanupRouter)
app.use(mcpAskRouter)
app.use(mcpQueueRouter)
app.use(mcpReportRouter)
app.use(mcpTerminalReadRouter)
app.use(sessionRouter)

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
if (existsSync(publicDir)) {
  app.use(express.static(publicDir))
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')))
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error('[axel] unhandled error:', err.message, err.stack)
  } else {
    console.error('[axel] unhandled error:', err.message)
  }
  res.status(500).json({ ok: false, error: 'internal_error' })
})

// In production, SSL is terminated by the reverse proxy (e.g. Traefik or nginx).
// Locally we create a self-signed cert so the browser treats the page as a
// secure context — required for webkitSpeechRecognition and getUserMedia on iOS.
function loadOrCreateCert(certDir: string): { key: Buffer; cert: Buffer } | null {
  if (process.env.NODE_ENV === 'production') return null
  try {
    const keyPath  = path.join(certDir, 'key.pem')
    const certPath = path.join(certDir, 'cert.pem')
    if (existsSync(keyPath) && existsSync(certPath)) {
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
    }
    mkdirSync(certDir, { recursive: true })
    const lanIp = getLanIp()
    const san = ['DNS:localhost', 'IP:127.0.0.1', lanIp ? `IP:${lanIp}` : null].filter(Boolean).join(',')
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 3650 -nodes -subj "/CN=axel-local" -addext "subjectAltName=${san}"`,
      { stdio: 'ignore' },
    )
    console.log('[axel] generated self-signed cert for local HTTPS')
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  } catch {
    console.warn('[axel] WARNING: could not generate self-signed cert — running HTTP only')
    return null
  }
}

const certDir = path.resolve('./data/certs')
const tlsCredentials = loadOrCreateCert(certDir)
const agentWss = createAgentWss()
const ptyWss = createPtyWss()

const upgradeHandler = (req: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
  if (req.url === '/agent/stream') {
    handleAgentUpgrade(agentWss, req, socket, head)
  } else if (req.url?.startsWith('/agent/pty/')) {
    handlePtyUpgrade(ptyWss, req, socket, head)
  } else {
    socket.destroy()
  }
}

// Always run plain HTTP so WebSocket clients on the same machine still work.
// HTTPS runs on port+1 when a cert is available — that's the URL phones use.
const httpServer = createHttpServer(app)
httpServer.on('upgrade', upgradeHandler)

const httpsPort = config.port + 1
const httpsServer = tlsCredentials ? createHttpsServer(tlsCredentials, app) : null
if (httpsServer) httpsServer.on('upgrade', upgradeHandler)

const onReady = async () => {
  const lanIp = getLanIp()
  console.log(`[axel] server running on http://localhost:${config.port}`)
  if (httpsServer) {
    console.log(`[axel] HTTPS running on https://localhost:${httpsPort}`)
    if (lanIp) {
      console.log(`[axel] on your phone (voice) → https://${lanIp}:${httpsPort}`)
      console.log(`[axel]   ⚠  first visit: tap "Advanced" → "Visit this website" to trust the cert`)
    }
  } else if (lanIp) {
    console.log(`[axel] on your phone → http://${lanIp}:${config.port}`)
  }

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  execFileAsync(config.claudeBin, ['--version']).catch(() => {
    console.warn('[axel] WARNING: claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code')
  })

  execFileAsync(config.pythonPath, ['-c', 'import piper']).catch(() => {
    console.warn('[axel] WARNING: piper-tts not found. Server TTS unavailable — run `pip3 install -r python/requirements.txt`. Browser speech synthesis will be used instead.')
  })

  // Watch the projects root for directory add/remove and push a live `fs_changed`
  // to every connected client, so the constellation ring surfaces new directories
  // without a full page reload (which would drop the session and running agents).
  try {
    const settings = await settingsManager.getSettings()
    const watchRoot = settings.projectsRoot ?? config.projectsDir
    startProjectsWatcher(watchRoot, () => broadcast(agentWss, { type: 'fs_changed' }))
    console.log(`[axel] watching ${watchRoot} for directory changes`)
  } catch (err) {
    console.error('[axel] could not start projects watcher:', err)
  }

  // Watch the MCP registry directory and push live tool_registered /
  // tool_unregistered updates to every connected client. The first emission
  // after a change is always a full list — clients diff against their cached
  // bubble-bar state.
  mcpRegistry.watch(view => broadcast(agentWss, { type: 'tool_catalog', tools: view }))
  console.log('[axel] watching MCP registry for tool changes')

  // Bridge the AppBroker → WebSocket. Whenever any client (or the agent via
  // an MCP tool) mutates app state, every connected tab sees the same
  // `app_state` event and renders the new state — no polling, no refresh.
  appBroker.subscribe((app, state) => broadcast(agentWss, { type: 'app_state', app, state }))

  // Bridge the RequestQueue → WebSocket. Sub-agent queue requests, claims, and
  // resolutions reach every client so the pending badge stays in sync and the
  // constellation orb floats to the sender dir on claim.
  queueBroker.subscribe(event => broadcast(agentWss, event))
}

httpServer.listen(config.port, '0.0.0.0', onReady)
if (httpsServer) httpsServer.listen(httpsPort, '0.0.0.0')

const onError = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[axel] FATAL: port already in use. Try a different PORT.\n`)
    process.exit(1)
  }
  throw err
}
httpServer.on('error', onError)
if (httpsServer) httpsServer.on('error', onError)
