// Bridges the open_terminal MCP tool calls from a spawned claude process
// (via the /mcp/terminal/:spawnId endpoint in apps/server) to the orchestrator.
// Same capability model as PermissionBroker: each spawn registers a handler
// under an unguessable spawnId; the route resolves the spawnId to it.

export type OpenTerminalArgs = {
  directory?: string
  prompt?: string
  // The specific terminal to send this to (the `[t-xxxxxxxx]` tag or "main"
  // from the BACKGROUND TERMINALS section). Omit to reuse the target's current
  // terminal by default — a follow-up continues the same conversation.
  term?: string
  // Force a brand-new terminal instead of reusing the target's current one.
  // ONLY set this when the user explicitly wants to work on something in
  // parallel — a separate conversation alongside the existing one.
  new?: boolean
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
