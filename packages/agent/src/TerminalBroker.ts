// Bridges the open_terminal MCP tool calls from a spawned claude process
// (via the /mcp/terminal/:spawnId endpoint in apps/server) to the orchestrator.
// Same capability model as PermissionBroker: each spawn registers a handler
// under an unguessable spawnId; the route resolves the spawnId to it.

export type OpenTerminalArgs = {
  directory?: string
  prompt?: string
  // Reuse an existing terminal in the target dir instead of spawning a new
  // PTY. Pass the `term` id surfaced in the root agent's BACKGROUND TERMINALS
  // section (the `[t-xxxxxxxx]` tag). If the id doesn't match a live PTY the
  // handler falls back to opening a fresh terminal — no error.
  term?: string
}
export type OpenTerminalResult =
  | { ok: true; target: string; term: string; reused: boolean }
  | { ok: false; error: string }

export type TerminalOpenHandler = (args: OpenTerminalArgs) => Promise<OpenTerminalResult>

export class TerminalBroker {
  private spawns = new Map<string, TerminalOpenHandler>()

  register(spawnId: string, handler: TerminalOpenHandler): void {
    this.spawns.set(spawnId, handler)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  async open(spawnId: string, args: OpenTerminalArgs): Promise<OpenTerminalResult> {
    const handler = this.spawns.get(spawnId)
    if (!handler) return { ok: false, error: 'Unknown session.' }
    return handler(args)
  }
}
