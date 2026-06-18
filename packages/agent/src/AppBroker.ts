// Shared in-process state for the built-in apps surfaced as bubbles in the UI
// (timer, notes). State is updated by:
//   - the agent via MCP tool calls routed through /mcp/apps
//   - the user via WS app_action control messages from the bubble popup
// Both paths funnel through the same methods on this broker. Every mutation
// emits an event to all subscribers, which the WS layer broadcasts as an
// `app_state` wire message so every open client stays in sync without polling.
//
// State is in-memory only (v1). A pomodoro that's running when the server
// restarts is gone — acceptable for now; persistence is a follow-up.

export type TimerState = {
  startedAt: number       // ms timestamp the countdown started from
  durationMs: number      // total target duration
  paused: boolean
  pausedAt?: number       // ms timestamp when pause was hit (only set while paused)
}
export type NotesState = {
  content: string
  updatedAt: number
}
export type AppState = {
  timer: TimerState | null  // null when no timer is active
  notes: NotesState
}

type Listener = (app: 'timer' | 'notes', state: unknown) => void

export type AppActionResult =
  | { ok: true; result?: unknown }
  | { ok: false; error: string }

export class AppBroker {
  private state: AppState = {
    timer: null,
    notes: { content: '', updatedAt: 0 },
  }
  private listeners = new Set<Listener>()

  // Subscribe to state changes. Returns an unsubscribe.
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): AppState { return this.state }

  private emit(app: 'timer' | 'notes', state: unknown): void {
    for (const l of this.listeners) {
      try { l(app, state) } catch { /* one bad listener can't break the rest */ }
    }
  }

  // ── Timer actions ─────────────────────────────────────────────────────────
  startTimer(minutes: number): AppActionResult {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return { ok: false, error: 'minutes must be > 0 and ≤ 1440' }
    }
    this.state.timer = { startedAt: Date.now(), durationMs: minutes * 60 * 1000, paused: false }
    this.emit('timer', this.state.timer)
    return { ok: true, result: this.timerStatus() }
  }
  pauseTimer(): AppActionResult {
    if (!this.state.timer) return { ok: false, error: 'no timer is running' }
    if (this.state.timer.paused) return { ok: false, error: 'timer is already paused' }
    this.state.timer = { ...this.state.timer, paused: true, pausedAt: Date.now() }
    this.emit('timer', this.state.timer)
    return { ok: true, result: this.timerStatus() }
  }
  resumeTimer(): AppActionResult {
    const t = this.state.timer
    if (!t) return { ok: false, error: 'no timer is running' }
    if (!t.paused || t.pausedAt === undefined) return { ok: false, error: 'timer is not paused' }
    // Shift startedAt forward by the pause duration so remaining time is
    // preserved — purely cosmetic, no clock drift since wall time is the only
    // reference both client and server use.
    const elapsedPaused = Date.now() - t.pausedAt
    this.state.timer = { ...t, startedAt: t.startedAt + elapsedPaused, paused: false, pausedAt: undefined }
    this.emit('timer', this.state.timer)
    return { ok: true, result: this.timerStatus() }
  }
  cancelTimer(): AppActionResult {
    this.state.timer = null
    this.emit('timer', null)
    return { ok: true, result: { running: false } }
  }
  timerStatus(): { running: boolean; remainingMs?: number; durationMs?: number; paused?: boolean } {
    const t = this.state.timer
    if (!t) return { running: false }
    const elapsed = t.paused && t.pausedAt !== undefined
      ? t.pausedAt - t.startedAt
      : Date.now() - t.startedAt
    return {
      running: true,
      paused: t.paused,
      durationMs: t.durationMs,
      remainingMs: Math.max(0, t.durationMs - elapsed),
    }
  }

  // ── Notes actions ─────────────────────────────────────────────────────────
  readNotes(): NotesState { return this.state.notes }
  writeNotes(content: string): AppActionResult {
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
    if (content.length > 1_000_000) return { ok: false, error: 'content exceeds 1 MB' }
    this.state.notes = { content, updatedAt: Date.now() }
    this.emit('notes', this.state.notes)
    return { ok: true, result: { length: content.length } }
  }
  appendNotes(text: string): AppActionResult {
    if (typeof text !== 'string') return { ok: false, error: 'text must be a string' }
    const current = this.state.notes.content
    const sep = current && !current.endsWith('\n') ? '\n' : ''
    return this.writeNotes(current + sep + text)
  }
  clearNotes(): AppActionResult {
    this.state.notes = { content: '', updatedAt: Date.now() }
    this.emit('notes', this.state.notes)
    return { ok: true, result: { length: 0 } }
  }
}
