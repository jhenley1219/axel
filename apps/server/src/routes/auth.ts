import type { Request } from 'express'
import { Router } from 'express'
import { SESSION_REMEMBER_MS } from '@axel/core'
import { config } from '../config.js'
import {
  passcodeService,
  rateLimiter,
  sessionManager,
  pairTokenStore,
  loadCredentials,
  saveCredentials,
} from '../services.js'
import { sessionGuard } from '../middleware/sessionGuard.js'
import { getLanIp } from '../services/lanIp.js'

export const authRouter = Router()

const MAX_USERNAME = 64
const MAX_PASSWORD = 256

const sessionCookie = (req: Request) => ({
  httpOnly: true,
  secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  sameSite: 'strict' as const,
  maxAge: SESSION_REMEMBER_MS,
})

// GET /auth/status — reports whether account exists and whether this request is authenticated
authRouter.get('/auth/status', async (req, res) => {
  if (!config.requireAuth) {
    res.json({ setup: true, authenticated: true })
    return
  }
  const creds = await loadCredentials()
  const token = req.cookies?.session as string | undefined
  const authenticated = Boolean(token && sessionManager.verify(token))
  res.json({ setup: creds !== null, authenticated })
})

// POST /auth/setup — one-time account creation; locked out once credentials exist
authRouter.post('/auth/setup', async (req, res) => {
  const ip = req.ip ?? 'unknown'
  const limit = rateLimiter.check(ip)
  if (!limit.allowed) {
    res.status(429).json({ ok: false, error: 'rate_limit', retryAfterMs: limit.retryAfterMs })
    return
  }

  if (await loadCredentials()) {
    res.status(409).json({ ok: false, error: 'already_configured' })
    return
  }

  const { username, password } = req.body as { username?: string; password?: string }
  const u = username?.trim() ?? ''
  if (!u || u.length > MAX_USERNAME || !password || password.length < 8 || password.length > MAX_PASSWORD) {
    res.status(400).json({ ok: false, error: 'invalid_credentials' })
    return
  }

  const passwordHash = await passcodeService.hash(password)
  await saveCredentials({ username: u, passwordHash })

  const token = sessionManager.issue(SESSION_REMEMBER_MS)
  res.cookie('session', token, sessionCookie(req))
  res.json({ ok: true })
})

// POST /auth/login — password authentication; rate-limited per IP
authRouter.post('/auth/login', async (req, res) => {
  const ip = req.ip ?? 'unknown'

  const limit = rateLimiter.check(ip)
  if (!limit.allowed) {
    res.status(429).json({ ok: false, error: 'rate_limit', retryAfterMs: limit.retryAfterMs })
    return
  }

  const creds = await loadCredentials()
  if (!creds) {
    res.status(403).json({ ok: false, error: 'needs_setup' })
    return
  }

  const { username, password } = req.body as { username?: string; password?: string }
  if (!username || !password || username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
    res.status(400).json({ ok: false, error: 'missing_fields' })
    return
  }

  const usernameOk = username.trim().toLowerCase() === creds.username.toLowerCase()
  // Always run argon2 verify regardless of username match to prevent timing oracle
  const passwordOk = await passcodeService.verify(password, creds.passwordHash)

  if (!usernameOk || !passwordOk) {
    rateLimiter.recordFailure(ip)
    res.status(401).json({ ok: false, error: 'invalid_credentials' })
    return
  }

  rateLimiter.recordSuccess(ip)
  const token = sessionManager.issue(SESSION_REMEMBER_MS)
  res.cookie('session', token, sessionCookie(req))
  res.json({ ok: true })
})

// DELETE /auth/session — logout; revokes token server-side
authRouter.delete('/auth/session', (req, res) => {
  const token = req.cookies?.session as string | undefined
  if (token) sessionManager.revoke(token)
  res.clearCookie('session')
  res.json({ ok: true })
})

// POST /auth/pair/create — issue a one-time pairing token. The desktop UI
// renders this token into a QR; the phone scans, opens /auth/pair/consume,
// and is logged in without typing the password. Authed: only an already
// signed-in user can mint a pairing link for their device.
authRouter.post('/auth/pair/create', sessionGuard, (_req, res) => {
  const { token, expiresAt } = pairTokenStore.issue()
  const lanIp = getLanIp()
  // HTTPS is required on the phone (iOS demands a secure context for the
  // mic). config.port is HTTP; the HTTPS listener runs on port+1 locally
  // and is created only when a cert is available.
  const httpsAvailable = process.env.NODE_ENV !== 'production'
  const httpsPort = config.port + 1
  res.json({ ok: true, token, expiresAt, lanIp, httpsPort, httpsAvailable })
})

// GET /auth/pair/consume?token=... — phone hits this after scanning. Single-
// use: the store removes the token on first read, so a leaked QR can't be
// replayed. Responds with an HTML page that already holds the session cookie
// and bounces to / — no client JS required, works on a fresh Safari load.
authRouter.get('/auth/pair/consume', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : ''
  const ok = token ? pairTokenStore.consume(token) : false
  if (!ok) {
    res.status(401).type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pairing failed</title>
<style>body{font:15px/1.4 -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#eee;padding:24px;text-align:center}a{color:#c9ff2e}</style>
<h1>Pairing failed</h1>
<p>This pairing link is expired or already used.</p>
<p>Generate a new one in Settings on your computer.</p>`)
    return
  }
  const sessionToken = sessionManager.issue(SESSION_REMEMBER_MS)
  res.cookie('session', sessionToken, sessionCookie(req))
  res.type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paired</title>
<meta http-equiv="refresh" content="0;url=/">
<style>body{font:15px/1.4 -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#eee;padding:24px;text-align:center}a{color:#c9ff2e}</style>
<p>Paired — opening Axel…</p>
<p><a href="/">Tap here if it doesn't open.</a></p>`)
})
