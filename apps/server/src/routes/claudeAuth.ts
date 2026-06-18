import { Router } from 'express'
import { sessionGuard } from '../middleware/sessionGuard.js'
import { claudeAuthService } from '../services.js'

export const claudeAuthRouter = Router()

// GET /auth/claude/check — verify python and script exist
claudeAuthRouter.get('/auth/claude/check', sessionGuard, (_req, res) => {
  res.json(claudeAuthService.checkEnv())
})

// GET /auth/claude/pty-test — run python pty script for 90s and return raw output
claudeAuthRouter.get('/auth/claude/pty-test', sessionGuard, async (_req, res) => {
  res.json(await claudeAuthService.ptyTest())
})

// GET /auth/claude/status
claudeAuthRouter.get('/auth/claude/status', sessionGuard, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(claudeAuthService.status())
})

// POST /auth/claude/start-oauth
claudeAuthRouter.post('/auth/claude/start-oauth', sessionGuard, async (_req, res) => {
  const result = await claudeAuthService.startOauth()
  switch (result.status) {
    case 'url':
      res.json({ ok: true, url: result.url, port: result.port })
      return
    case 'pending':
      res.json({ ok: true, pending: true })
      return
    case 'error':
      if (result.code === 'oauth_script_missing') {
        res.status(500).json({ ok: false, error: result.code, script: result.detail })
      } else if (result.code === 'spawn_error') {
        res.status(500).json({ ok: false, error: result.detail })
      } else {
        res.status(504).json({ ok: false, error: result.detail ?? result.code })
      }
  }
})

// POST /auth/claude/complete-oauth
// User pastes the authorization code shown on claude.com after signing in.
claudeAuthRouter.post('/auth/claude/complete-oauth', sessionGuard, async (req, res) => {
  const { code } = req.body as { code?: string }
  if (!code?.trim()) { res.status(400).json({ ok: false, error: 'missing code' }); return }

  const result = await claudeAuthService.completeOauth(code)
  if (!result.ok) { res.status(400).json(result); return }
  res.json(result)
})

// POST /auth/claude/logout
claudeAuthRouter.post('/auth/claude/logout', sessionGuard, (_req, res) => {
  claudeAuthService.logout()
  res.json({ ok: true })
})

// POST /auth/claude/restore-backup
claudeAuthRouter.post('/auth/claude/restore-backup', sessionGuard, (_req, res) => {
  const result = claudeAuthService.restoreBackup()
  if (!result.ok) {
    res.status(result.error === 'no_backup_found' ? 404 : 500).json(result)
    return
  }
  res.json(result)
})
