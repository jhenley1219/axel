// Bridges the close_idle_dirs MCP tool calls from a spawned claude process
// (via the /mcp/cleanup/:spawnId endpoint in apps/server) to the orchestrator.
// Same capability model as TerminalBroker / FileOpenBroker — unguessable
// spawnId per spawn, handler registered alongside. The handler decides which
// dirs are idle and emits dir_closed wire events.

export type CloseIdleArgs = Record<string, never>
export type CloseIdleResult =
  | { ok: true; closed: Array<string> }
  | { ok: false; error: string }

export type CleanupHandler = (args: CloseIdleArgs) => Promise<CloseIdleResult>

export class CleanupBroker {
  private spawns = new Map<string, CleanupHandler>()

  register(spawnId: string, handler: CleanupHandler): void {
    this.spawns.set(spawnId, handler)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  async closeIdle(spawnId: string, args: CloseIdleArgs): Promise<CloseIdleResult> {
    const handler = this.spawns.get(spawnId)
    if (!handler) return { ok: false, error: 'Unknown session.' }
    return handler(args)
  }
}
