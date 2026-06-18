import type { Message } from './messages.js'

// Per-tab persistence of the parts of the voice loop a stray reload would
// otherwise destroy. sessionStorage (not localStorage) — every browser tab is
// its own session and must not stomp on the laptop's local one. On mobile
// Safari this survives the in-place reload that happens when a tab is
// restored from a backgrounded state; it does NOT survive closing the tab.
const STORAGE_KEY = 'axel:session-state:v1'

export type FanOutSnapshot = {
  targets: Array<{ id: string; name: string; dir: string }>
  status: Record<string, 'streaming' | 'done'>
}

export type PersistedSession = {
  messages: Array<Message>
  targetMessages: Record<string, Array<Message>>
  fanOut: FanOutSnapshot | null
  currentTarget: string | null
  targetStatus: Record<string, 'working' | 'done' | 'error'>
}

const EMPTY: PersistedSession = {
  messages: [],
  targetMessages: {},
  fanOut: null,
  currentTarget: null,
  targetStatus: {},
}

// Anything that was mid-stream when the tab reloaded is dead — clear the
// streaming flag so the UI doesn't render a stuck dotted bubble forever.
function settle(messages: Array<Message>): Array<Message> {
  return messages.map(m => m.streaming ? { ...m, streaming: false } : m)
}

export function loadPersistedSession(): PersistedSession {
  if (typeof sessionStorage === 'undefined') return EMPTY
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    const targetMessages: Record<string, Array<Message>> = {}
    for (const [k, v] of Object.entries(parsed.targetMessages ?? {})) {
      targetMessages[k] = settle(v as Array<Message>)
    }
    // A status of 'working' from before the reload is a lie — nothing on the
    // server is streaming to this tab anymore. Demote to 'done' so the dir
    // node stops pulsing.
    const targetStatus: Record<string, 'working' | 'done' | 'error'> = {}
    for (const [k, v] of Object.entries(parsed.targetStatus ?? {})) {
      targetStatus[k] = v === 'working' ? 'done' : v
    }
    return {
      messages: settle(parsed.messages ?? []),
      targetMessages,
      fanOut: parsed.fanOut ?? null,
      currentTarget: parsed.currentTarget ?? null,
      targetStatus,
    }
  } catch {
    return EMPTY
  }
}

export function savePersistedSession(state: PersistedSession): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota / private-mode failures are fine — persistence is best-effort.
  }
}

export function clearPersistedSession(): void {
  if (typeof sessionStorage === 'undefined') return
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
