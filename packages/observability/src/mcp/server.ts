import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { diffUiVsBackend } from '../diff.js'
import { reconstruct } from '../reconstruct.js'
import type { SessionReader } from '../SessionReader.js'

const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

// Builds the stdio MCP server an external Claude attaches to (via this repo's
// .mcp.json). Read-only: every tool reads recordings off disk through the
// SessionReader, so it works whether or not the axel app is running.
export const createObservabilityMcpServer = (reader: SessionReader): Server => {
  const server = new Server(
    { name: 'axel-observe', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_sessions',
        description: 'List recorded sessions (most recently active first) with their metadata: id, created/updated timestamps, record count, and last user input preview.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'latest_session',
        description: 'Return the id and metadata of the most recently active recorded session. Handy starting point for debugging "what just happened".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_session_feed',
        description: 'Return the chronological record feed for a session. Optionally filter by record kinds (session_start, user_input, control_input, wire_event, turn, ui_snapshot, session_reset), tail to a limit, or start after a seq.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string' },
            kinds: { type: 'array', items: { type: 'string' } },
            limit: { type: 'number', description: 'Return only the last N matching records.' },
            sinceSeq: { type: 'number', description: 'Only records with seq greater than this.' },
          },
        },
      },
      {
        name: 'get_ui_state',
        description: 'Return the most recent UI snapshot the web client reported for a session: the messages, target statuses, active tool invocations, and pending prompts the user is actually looking at.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string' } },
        },
      },
      {
        name: 'get_backend_state',
        description: 'Reconstruct what the conversation actually was on the backend (user messages, assistant text, tool calls/results, and raw model turns) from the recorded feed. Scope to a child agent with target/term.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string' },
            target: { type: 'string', description: 'Child agent project target; omit for the root agent.' },
            term: { type: 'string', description: 'Terminal id within the target (default main).' },
          },
        },
      },
      {
        name: 'diff_ui_vs_backend',
        description: 'THE debugging tool. Compare what the UI last showed against what the backend actually produced for a session and report divergences — e.g. the model emitted tool-call JSON as plain text that was rendered as a chat bubble with no tool executed, stuck streaming/working indicators, or message-count drift.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string' },
            target: { type: 'string' },
            term: { type: 'string' },
          },
        },
      },
      {
        name: 'tail_events',
        description: 'Return the last N records of a session feed (any kind). Quick way to see what just happened.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string' },
            n: { type: 'number', description: 'How many trailing records (default 30).' },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (name) {
        case 'list_sessions':
          return text(reader.listSessions())
        case 'latest_session': {
          const id = reader.latestSessionId()
          if (!id) return text({ error: 'no_sessions_recorded' })
          const meta = reader.listSessions().find(m => m.sessionId === id) ?? null
          return text({ sessionId: id, meta })
        }
        case 'get_session_feed': {
          const sessionId = str(args.sessionId)
          if (!sessionId) return text({ error: 'sessionId_required' })
          const kinds = Array.isArray(args.kinds) ? (args.kinds as Array<string>) : undefined
          return text(reader.readFeed(sessionId, { kinds, limit: num(args.limit), sinceSeq: num(args.sinceSeq) }))
        }
        case 'get_ui_state': {
          const sessionId = str(args.sessionId)
          if (!sessionId) return text({ error: 'sessionId_required' })
          return text(reader.latestUiSnapshot(sessionId) ?? { error: 'no_ui_snapshot' })
        }
        case 'get_backend_state': {
          const sessionId = str(args.sessionId)
          if (!sessionId) return text({ error: 'sessionId_required' })
          return text(reconstruct(reader.readFeed(sessionId), { target: str(args.target), term: str(args.term) }))
        }
        case 'diff_ui_vs_backend': {
          const sessionId = str(args.sessionId)
          if (!sessionId) return text({ error: 'sessionId_required' })
          const records = reader.readFeed(sessionId)
          const ui = reader.latestUiSnapshot(sessionId)
          return text(diffUiVsBackend(records, ui, { target: str(args.target), term: str(args.term) }))
        }
        case 'tail_events': {
          const sessionId = str(args.sessionId)
          if (!sessionId) return text({ error: 'sessionId_required' })
          return text(reader.readFeed(sessionId, { limit: num(args.n) ?? 30 }))
        }
        default:
          return text({ error: 'unknown_tool', name })
      }
    } catch (err) {
      return text({ error: 'tool_failed', message: (err as Error).message })
    }
  })

  return server
}
