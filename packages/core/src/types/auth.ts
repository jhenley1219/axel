export type AuthResult =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: 'passcode' | 'speaker' | 'rate_limit' | 'needs_enrollment' | 'error'; retryAfterMs?: number }

export type SpeakerEmbedding = {
  vector: number[]
  enrolledAt: number
}

export type SessionPayload = {
  sessionId: string
  issuedAt: number
  expiresAt: number
}
