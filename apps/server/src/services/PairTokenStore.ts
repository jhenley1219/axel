import crypto from 'crypto'

// One-time, short-TTL tokens used to hand a fresh session cookie to a phone
// that scans a QR. Stored in memory only — losing them on restart is fine
// (the user just generates a new one). Single-use: a token is consumed the
// first time /auth/pair/consume sees it, so a leaked QR can't be reused.
export type PairTokenInfo = { token: string; expiresAt: number }

const DEFAULT_TTL_MS = 5 * 60_000
const SWEEP_MS       = 60_000

export class PairTokenStore {
  private tokens = new Map<string, number>()  // token -> expiresAt

  constructor() {
    // Periodic sweep so an unused token doesn't linger in memory past its TTL.
    setInterval(() => this.sweep(), SWEEP_MS).unref?.()
  }

  issue(ttlMs = DEFAULT_TTL_MS): PairTokenInfo {
    const token = crypto.randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    this.tokens.set(token, expiresAt)
    return { token, expiresAt }
  }

  // Consume returns true at most once per issued token, and only before expiry.
  consume(token: string): boolean {
    const exp = this.tokens.get(token)
    if (exp === undefined) return false
    this.tokens.delete(token)
    return Date.now() <= exp
  }

  private sweep(): void {
    const now = Date.now()
    for (const [t, exp] of this.tokens) {
      if (now > exp) this.tokens.delete(t)
    }
  }
}
