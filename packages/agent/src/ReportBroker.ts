import type { AgentEvent } from './ClaudeCodeAgent.js'

// One-shot end-of-turn report from a child sub-agent back to the root agent.
// Exists because PTY-mode children render through xterm bytes and never emit
// structured `token` events — so the orchestrator's childTranscripts buffer
// stays empty and the root's BACKGROUND TERMINALS prompt section reads
// "(no output yet)". This bridge lets the child push a short plain-English
// summary that the broker re-emits as a synthetic token + message_end pair;
// the same wrappedOnEvent in AgentOrchestrator.runDirMessage that handles real
// tokens then appends the summary into childTranscripts, so the root sees it.
//
// Mirrors AskBroker structurally: per-spawn registration under an unguessable
// spawnId, fire-and-forget submit (no pending Promise — the child doesn't
// wait for the user).

export type ReportArgs = { summary: string }

export type ReportResult =
  | { ok: true }
  | { ok: false; error: string }

export class ReportBroker {
  private spawns = new Map<string, (event: AgentEvent) => void>()
  // Tracks which spawns delivered a non-empty report this run. PtyAgent reads
  // this at turn-end to decide whether to also append its raw TUI scrape —
  // when the child reported cleanly, the scrape would just push the clean
  // report out of the prompt's 800-char truncation window.
  private reported = new Set<string>()
  // Per-spawn resolvers awaiting THIS turn's report. A child PTY turn is only
  // "done" once the child calls report (the same signal the root agent reads),
  // so PtyAgent.run() blocks on whenReported() instead of the TUI-idle
  // heuristic that used to flip a terminal to "done" while it was still working.
  private reportWaiters = new Map<string, Array<() => void>>()

  register(spawnId: string, onEvent: (event: AgentEvent) => void): void {
    this.spawns.set(spawnId, onEvent)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
    this.reported.delete(spawnId)
    // Session tearing down mid-turn (PTY exit / closeSession): release any
    // run() blocked on this turn's report so it settles instead of hanging.
    this.resolveWaiters(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  // Resolves when this spawn submits a report — or immediately if it already
  // has this turn. The authoritative end-of-turn signal for a child PTY. Reset
  // each turn with clearReported() so it tracks the CURRENT turn, not a stale
  // report from a prior turn on the same long-lived PTY.
  whenReported(spawnId: string): Promise<void> {
    if (this.reported.has(spawnId)) return Promise.resolve()
    return new Promise<void>(resolve => {
      const list = this.reportWaiters.get(spawnId) ?? []
      list.push(resolve)
      this.reportWaiters.set(spawnId, list)
    })
  }

  // Forget a prior turn's report so the next turn's whenReported() waits afresh.
  // Without this the `reported` flag is sticky for the PTY's whole lifetime, so
  // turn 2+ would complete instantly and skip its transcript scrape.
  clearReported(spawnId: string): void {
    this.reported.delete(spawnId)
  }

  private resolveWaiters(spawnId: string): void {
    const waiters = this.reportWaiters.get(spawnId)
    if (!waiters) return
    this.reportWaiters.delete(spawnId)
    for (const w of waiters) w()
  }

  // True if this spawn has already submitted a non-empty report. Used by the
  // PtyAgent transcript scraper to skip itself when the model gave us a clean
  // structured summary — otherwise the noisier scrape clobbers it in the
  // prompt's tail-truncation window.
  wasReported(spawnId: string): boolean {
    return this.reported.has(spawnId)
  }

  submit(spawnId: string, args: ReportArgs): ReportResult {
    const onEvent = this.spawns.get(spawnId)
    if (!onEvent) return { ok: false, error: 'Unknown session.' }
    const text = (args.summary ?? '').trim()
    if (!text) return { ok: false, error: 'summary required' }
    // Re-emit as the same shape a stream-json child would produce — token
    // (the prose) then message_end (closes the assistant turn). The
    // orchestrator's wrappedOnEvent appends token text to childTranscripts and
    // stamps the buffer's lastUpdatedAt, exactly what we need for the root's
    // BACKGROUND TERMINALS section to render this on the next root turn.
    onEvent({ type: 'token', value: text })
    // `reported: true` is the authoritative completion signal the server's
    // auto-wake keys off — distinct from the heuristic idle-scrape message_end,
    // so the root is pinged only when the child explicitly finished.
    onEvent({ type: 'message_end', reported: true })
    this.reported.add(spawnId)
    // Unblock PtyAgent.run() — this is the "child told the master it's done"
    // moment that flips the terminal from working to done.
    this.resolveWaiters(spawnId)
    return { ok: true }
  }
}
