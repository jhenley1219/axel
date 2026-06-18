import type { AgentEvent } from '../ClaudeCodeAgent.js'

export type ToolContext = {
  allowedDirs: Array<string>
  cwd: string
  abortSignal?: AbortSignal
  emitEvent?: (event: AgentEvent) => void
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string }

export type Tool = {
  name: string
  description: string
  inputSchema: object
  execute: (input: any, ctx: ToolContext) => Promise<ToolResult>
}
