import type { TerminalOpenHandler } from '../TerminalBroker.js'
import type { TerminalReadHandler } from '../TerminalReadBroker.js'
import type { CleanupHandler } from '../CleanupBroker.js'
import type { Tool } from './Tool.js'

// Root-controller orchestration tools for the LOCAL model (AxelAgent). These
// mirror the MCP tools the Claude Code path gets (apps/server/src/routes/
// mcpTerminal.ts etc.), but as in-process Tools bound to the handlers the
// orchestrator already passes into AxelAgent.run. They turn the local model
// from "describes open_terminal in text" into "actually spawns a sub-terminal".

export type RootOrchestrationHandlers = {
  open?: TerminalOpenHandler
  read?: TerminalReadHandler
  cleanup?: CleanupHandler
}

const json = (v: unknown): string => JSON.stringify(v)

export const buildRootOrchestrationTools = (handlers: RootOrchestrationHandlers): Array<Tool> => {
  const tools: Array<Tool> = []

  if (handlers.open) {
    const open = handlers.open
    tools.push({
      name: 'open_terminal',
      description:
        'Send a task to a sub-terminal in a project. By DEFAULT this continues the terminal already open for that project — the SAME conversation — so it is how you send a follow-up or the next step. Use this for ANY work inside a project. Pass `directory` (a project name) and `prompt` (the task). Pass `term` to target a specific terminal by its id (e.g. "main"). Pass `new: true` ONLY when the user explicitly wants separate parallel work — never just for a follow-up. You do not touch project files yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory name to work in (from the projects list). Omit to use the current project.' },
          prompt: { type: 'string', description: 'The task/message to send. Goes into the project\'s existing terminal by default.' },
          term: { type: 'string', description: 'Optional id of the terminal to send to — "main" or a [t-xxxxxxxx] id. Omit to use the project\'s current terminal.' },
          new: { type: 'boolean', description: 'Force a brand-new terminal (parallel work only, not for follow-ups).' },
        },
      },
      async execute(input: { directory?: string; prompt?: string; term?: string; new?: boolean }) {
        const result = await open({ directory: input?.directory, prompt: input?.prompt, term: input?.term, new: input?.new })
        return result.ok
          ? { ok: true, output: json(result) }
          : { ok: false, error: result.error }
      },
    })
  }

  if (handlers.read) {
    const read = handlers.read
    tools.push({
      name: 'read_terminal',
      description:
        'Read the COMPLETE conversation of one of your sub-terminals — every user prompt, assistant reply, and tool call, straight from the terminal\'s persisted transcript. Use whenever you need what a terminal actually did/said, or when the background summary looks empty or garbled. Pass `target` (the project name); omit `term` to list every terminal open for that project and read the most recent, or pass a specific `term` id. Set `raw` true only for the unfiltered live PTY tail.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The project/terminal name to read.' },
          term: { type: 'string', description: 'Optional [t-xxxxxxxx] id of the specific terminal.' },
          raw: { type: 'boolean', description: 'Return the less-filtered PTY tail instead of the cleaned transcript.' },
        },
      },
      async execute(input: { target?: string; term?: string; raw?: boolean }) {
        const result = await read({ target: input?.target, term: input?.term, raw: input?.raw })
        return result.ok
          ? { ok: true, output: json(result) }
          : { ok: false, error: result.error }
      },
    })
  }

  if (handlers.cleanup) {
    const cleanup = handlers.cleanup
    tools.push({
      name: 'close_idle_dirs',
      description: 'Close sub-terminals that are idle, tidying up the workspace. Use when the user asks to clean up or close finished terminals.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const result = await cleanup({})
        return result.ok
          ? { ok: true, output: json(result) }
          : { ok: false, error: result.error }
      },
    })
    tools.push({
      name: 'go_home',
      description: 'Return the user\'s view to the projects root (their "coding projects" home). Use when the user says to go back to the root / coding-projects directory, go home, or leave the current project without opening another. The root is NOT an openable project — never call open_terminal for it.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const result = await cleanup({ action: 'go_home' })
        return result.ok
          ? { ok: true, output: json(result) }
          : { ok: false, error: result.error }
      },
    })
  }

  return tools
}
