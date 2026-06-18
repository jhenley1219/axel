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

  register(spawnId: string, onEvent: (event: AgentEvent) => void): void {
    this.spawns.set(spawnId, onEvent)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
    this.reported.delete(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
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
    onEvent({ type: 'message_end' })
    this.reported.add(spawnId)
    return { ok: true }
  }
}
