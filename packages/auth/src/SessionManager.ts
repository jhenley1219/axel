import crypto from 'crypto'
import { SESSION_TTL_MS, type SessionPayload } from '@axel/core'

export class SessionManager {
  private revoked = new Set<string>()

  constructor(private secret: string) {}

  issue(ttlMs = SESSION_TTL_MS): string {
    const payload: SessionPayload = {
      sessionId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return `${encoded}.${sig}`
  }

  verify(token: string): SessionPayload | null {
    try {
      const dotIdx = token.lastIndexOf('.')
      if (dotIdx === -1) return null
      const encoded = token.slice(0, dotIdx)
      const sig = token.slice(dotIdx + 1)
      const expected = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url')
      const sigBuf = Buffer.from(sig, 'base64url')
      const expBuf = Buffer.from(expected, 'base64url')
      if (sigBuf.length !== expBuf.length) return null
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as SessionPayload
      if (Date.now() > payload.expiresAt) return null
      if (this.revoked.has(payload.sessionId)) return null
      return payload
    } catch {
      return null
    }
  }

  revoke(token: string): void {
    try {
      const dotIdx = token.lastIndexOf('.')
      if (dotIdx === -1) return
      const encoded = token.slice(0, dotIdx)
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as SessionPayload
      this.revoked.add(payload.sessionId)
    } catch {
      // invalid token — nothing to revoke
    }
  }
}
