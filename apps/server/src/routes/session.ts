import { Router } from 'express'
import { config } from '../config.js'
import { sessionManager, orchestrator } from '../services.js'
import { sessionGuard } from '../middleware/sessionGuard.js'

export const sessionRouter = Router()

// POST /api/session/reset — drop the server-side conversation state for the
// caller's session so the next message starts a fresh runtime conversation.
// Backs the UI's "new session" control; resolves the session id the same way
// the agent WebSocket does (cookie → verify, or 'no-auth' when auth is off).
sessionRouter.post('/api/session/reset', sessionGuard, (req, res) => {
  let sessionId = 'no-auth'
  if (config.requireAuth) {
    const token = req.cookies?.session as string | undefined
    const session = token ? sessionManager.verify(token) : null
    if (!session) {
      res.status(401).json({ ok: false, error: 'not_authenticated' })
      return
    }
    sessionId = session.sessionId
  }
  orchestrator.resetSession(sessionId)
  res.json({ ok: true })
})
