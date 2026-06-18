import { AUTH_MAX_ATTEMPTS, AUTH_LOCKOUT_MS } from '@axel/core'

type Entry = { count: number; lockedUntil: number }

export class RateLimiter {
  private state = new Map<string, Entry>()

  check(ip: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    const entry = this.state.get(ip) ?? { count: 0, lockedUntil: 0 }

    if (now < entry.lockedUntil) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - now }
    }

    if (now >= entry.lockedUntil && entry.lockedUntil > 0) {
      this.state.set(ip, { count: 0, lockedUntil: 0 })
    }

    return { allowed: true }
  }

  recordFailure(ip: string): void {
    const entry = this.state.get(ip) ?? { count: 0, lockedUntil: 0 }
    const newCount = entry.count + 1
    this.state.set(ip, {
      count: newCount,
      lockedUntil: newCount >= AUTH_MAX_ATTEMPTS ? Date.now() + AUTH_LOCKOUT_MS : 0,
    })
  }

  recordSuccess(ip: string): void {
    this.state.delete(ip)
  }
}
