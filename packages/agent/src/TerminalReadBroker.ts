// Lets the ROOT agent read the recent text from any of its sub-terminals on
// demand. Exists because PTY-mode children render through xterm bytes and the
// BACKGROUND TERMINALS prompt prefill — fed by childTranscripts — only
// captures what the child explicitly emitted via mcp__axel_report__report or
// the end-of-turn TUI scrape. When the scrape misses (status lines without
// findings, model forgot to report, cleaner over-stripped) the root would
// otherwise have no recourse. This broker is the recourse: the root calls
// mcp__axel_terminals__read_terminal({target, term?}) and gets back the
// cleanest text the system can produce for that terminal right now.
//
// Per-spawn registration (root spawn only); the unguessable spawnId is the
// auth. Same shape as TerminalBroker — kept separate so the existing
// open_terminal broker stays single-purpose.

export type ReadTerminalArgs = {
  target?: string
  term?: string
  // raw=true returns the less-filtered PTY tail (4KB ANSI-stripped window)
  // instead of the orchestrator's cleaned childTranscripts text. Useful when
  // the cleaner stripped the actual findings.
  raw?: boolean
}

export type ReadTerminalResult =
  | { ok: true; target: string; term: string; text: string; source: 'full' | 'transcript' | 'raw' | 'mixed' }
  | { ok: false; error: string }

export type TerminalReadHandler = (args: ReadTerminalArgs) => Promise<ReadTerminalResult>

export class TerminalReadBroker {
  private spawns = new Map<string, TerminalReadHandler>()

  register(spawnId: string, handler: TerminalReadHandler): void {
    this.spawns.set(spawnId, handler)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  async read(spawnId: string, args: ReadTerminalArgs): Promise<ReadTerminalResult> {
    const handler = this.spawns.get(spawnId)
    if (!handler) return { ok: false, error: 'Unknown session.' }
    return handler(args)
  }
}
