import type { Request, Response, NextFunction } from 'express'
import { config } from '../config.js'
import { sessionManager } from '../services.js'

export const sessionGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (!config.requireAuth) { next(); return }
  const token = req.cookies?.session as string | undefined
  if (!token) {
    res.status(401).json({ ok: false, error: 'not_authenticated' })
    return
  }
  const payload = sessionManager.verify(token)
  if (!payload) {
    res.status(401).json({ ok: false, error: 'session_expired' })
    return
  }
  next()
}
