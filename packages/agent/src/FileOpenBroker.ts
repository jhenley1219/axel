// Bridges the open_file MCP tool calls from a spawned claude process (via the
// /mcp/files/:spawnId endpoint in apps/server) to the orchestrator. Same
// capability model as TerminalBroker — unguessable spawnId per spawn, handler
// registered alongside. Fire-and-forget: the handler emits a file_open_request
// wire event and returns immediately; the user reacts on their own time.

export type Highlight = { snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }
export type Suggestion = { find: string; replace: string; reason?: string }

export type OpenFileArgs = {
  path: string
  highlights?: Array<Highlight>
  suggestion?: Suggestion
  prompt?: string
}

export type OpenFileResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

export type FileOpenHandler = (args: OpenFileArgs) => Promise<OpenFileResult>

export class FileOpenBroker {
  private spawns = new Map<string, FileOpenHandler>()

  register(spawnId: string, handler: FileOpenHandler): void {
    this.spawns.set(spawnId, handler)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  async open(spawnId: string, args: OpenFileArgs): Promise<OpenFileResult> {
    const handler = this.spawns.get(spawnId)
    if (!handler) return { ok: false, error: 'Unknown session.' }
    return handler(args)
  }
}
