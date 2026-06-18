import type { BrowseResponse, ClaudeAuthState, SettingsResponse } from '@axel/core'

const BASE = ''

export type AuthStatus = {
  setup: boolean
  authenticated: boolean
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BASE}/auth/status`, { credentials: 'include' })
  return res.json() as Promise<AuthStatus>
}

export async function setup(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string; retryAfterMs?: number }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  })
  return res.json() as Promise<{ ok: boolean; error?: string; retryAfterMs?: number }>
}

// null on HTTP error — callers treat it the same as a missing payload
export async function getSettings(): Promise<SettingsResponse | null> {
  const res = await fetch(`${BASE}/api/settings`, { credentials: 'include', cache: 'no-store' })
  return res.ok ? (res.json() as Promise<SettingsResponse>) : null
}

export type OllamaModelsResponse =
  | { ok: true; models: Array<{ id: string; sizeBytes?: number }> }
  | { ok: false; error: string }

// Lists Ollama models installed on the server. ok:false → daemon unreachable.
export async function getOllamaModels(): Promise<OllamaModelsResponse> {
  try {
    const res = await fetch(`${BASE}/api/runtime/ollama/models`, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return { ok: false, error: `http ${res.status}` }
    return await res.json() as OllamaModelsResponse
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type OllamaPullEvent =
  | { type: 'progress'; status: string; digest?: string; total?: number; completed?: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

// Streams Ollama pull progress as NDJSON events. The caller passes a callback
// for each event. Returns when the pull finishes (success or error) or when
// the AbortSignal fires. Closing the connection mid-pull does NOT cancel the
// download on the Ollama daemon — it just stops the progress feed.
export async function pullOllamaModel(
  name: string,
  onEvent: (ev: OllamaPullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/api/runtime/ollama/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name }),
    signal,
  })
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: `http ${res.status}` })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { onEvent(JSON.parse(line) as OllamaPullEvent) }
      catch { /* skip malformed line */ }
    }
  }
}

// Parses error bodies too (400 not_readable carries the reason); throws on network failure
export async function browseDir(path: string): Promise<BrowseResponse> {
  const res = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent(path)}`, { credentials: 'include' })
  return res.json() as Promise<BrowseResponse>
}

// Drop the server-side conversation state for this session so the agent forgets
// prior context. Paired with clearing the local snapshot for a true "new session".
export async function resetSession(): Promise<void> {
  await fetch(`${BASE}/api/session/reset`, { method: 'POST', credentials: 'include' })
}

export async function getClaudeStatus(): Promise<ClaudeAuthState> {
  const res = await fetch(`${BASE}/auth/claude/status`, { credentials: 'include', cache: 'no-store' })
  return res.json() as Promise<ClaudeAuthState>
}

export type PairTokenResponse = {
  ok: boolean
  token: string
  expiresAt: number
  lanIp: string | null
  httpsPort: number
  httpsAvailable: boolean
}

// POST a fresh single-use pairing token. The phone hits /auth/pair/consume
// with this token to obtain a session cookie without re-typing the password.
export async function createPairToken(): Promise<PairTokenResponse> {
  const res = await fetch(`${BASE}/auth/pair/create`, {
    method: 'POST',
    credentials: 'include',
  })
  return res.json() as Promise<PairTokenResponse>
}
