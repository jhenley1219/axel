import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { askBroker } from '../services.js'

// Per-spawn MCP endpoint backing the `ask_user` tool. Mirrors mcpPermission.ts:
// stateless transport, fresh Server instance per POST, the spawnId param is the
// only thing authenticating the request — claude carries no session cookie, so
// we rely on the unguessable spawnId + a loopback-only check.
export const mcpAskRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpAskRouter.post('/mcp/ask/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !askBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-ask', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'ask_user',
      description: 'Pose a multiple-choice question to the user. Returns the chosen option or a cancellation. Use when you need a decision that isn\'t a simple yes/no permission — e.g. picking an approach, a branch name, or a destination. The user can answer by voice or by clicking an option in the owning terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask, in natural language. Read aloud verbatim if the user has voice focus, so keep it concise.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 8,
            description: 'The choices the user picks from. Order matters — option 1 is the first one read aloud.',
          },
          target: {
            type: 'string',
            description: 'Optional. The owning project dir name when this question belongs to a child agent in a fan-out. Omit for root-agent questions.',
          },
          term: {
            type: 'string',
            description: 'Optional. The owning terminal name within `target` (defaults to "main").',
          },
        },
        required: ['question', 'options'],
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as {
      question?: string
      options?: Array<unknown>
      target?: string
      term?: string
    }
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    // Coerce every entry to a non-empty string and drop blanks. If the model
    // sent something pathological we'll surface that as a cancellation below.
    const options = Array.isArray(args.options)
      ? args.options.map(o => String(o ?? '').trim()).filter(Boolean)
      : []
    if (!question || options.length < 2) {
      const answer = { kind: 'cancelled' as const, message: 'ask_user needs a question and at least two non-empty options.' }
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
    }
    const target = typeof args.target === 'string' && args.target ? args.target : undefined
    const term   = typeof args.term   === 'string' && args.term   ? args.term   : undefined
    const answer = await askBroker.request(spawnId, question, options, target, term)
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
  })

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('[mcp-ask] request failed:', err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal_error' },
        id: null,
      })
    }
  }
})

// Stateless transport — no SSE stream to resume, no session to delete.
const methodNotAllowed = (_req: import('express').Request, res: import('express').Response): void => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  })
}
mcpAskRouter.get('/mcp/ask/:spawnId', methodNotAllowed)
mcpAskRouter.delete('/mcp/ask/:spawnId', methodNotAllowed)
