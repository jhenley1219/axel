import type { Request, Response, NextFunction } from 'express'

export const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — ${req.ip}`)
  next()
}
