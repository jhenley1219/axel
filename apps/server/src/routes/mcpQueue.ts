import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { queueBroker } from '../services.js'

// Per-spawn MCP endpoint backing the request-queue tools. Same shape as
// mcpAsk / mcpPermission: stateless transport, fresh Server per POST,
// loopback-only, spawnId-as-capability. Tools surfaced depend on the spawn's
// role registered with the broker — children see only `request`, root sees
// only `list` / `claim` / `resolve`.
export const mcpQueueRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpQueueRouter.post('/mcp/queue/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !queueBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId
  const role = queueBroker.roleOf(spawnId)
  if (!role) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }

  const server = new Server(
    { name: 'axel-queue', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const childTools = [{
    name: 'request',
    description: 'Raise a request to the main agent (who routes it to the user). Use for anything that needs human input from a sub-terminal: a proposed fix that needs approval, a clarifying question, a confirmation before a destructive step. Blocks until the user answers via the main agent. Responses come back through the main agent — you do NOT speak to the user directly.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['proposal', 'question', 'confirmation'],
          description: 'proposal = "here is what I want to do, accept/deny". question = open-ended ask. confirmation = yes/no gate before a destructive step.',
        },
        prompt: {
          type: 'string',
          description: 'The human-readable text the main agent will surface to the user. Keep it concise — voice may read it verbatim.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional multi-choice options. Omit for free-form / accept-or-deny questions.',
        },
      },
      required: ['kind', 'prompt'],
    },
  }]

  const rootTools = [
    {
      name: 'list',
      description: 'List every pending queue item raised by sub-terminals. Returns id, fromTarget (sender dir), fromTerm, kind, prompt, options, createdAt, status. Call this at the end of a turn when the current topic feels concluded — if anything is pending, surface a summary to the user and ask which to handle next.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'claim',
      description: 'Take ownership of one queue item by id. The constellation orb floats to the sender dir automatically so the user can see where the request came from. Returns the full item. Always call this before presenting the item to the user.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The queue item id, from list().' } },
        required: ['id'],
      },
    },
    {
      name: 'resolve',
      description: 'Send the user\'s answer back to the waiting sub-terminal. accepted=true for go-ahead, false for stop/deny. answer is optional free-form text passed back to the sub-agent (e.g. the chosen option label, or a clarification).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          accepted: { type: 'boolean' },
          answer: { type: 'string' },
        },
        required: ['id', 'accepted'],
      },
    },
  ]

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: role.role === 'child' ? childTools : rootTools,
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    if (role.role === 'child' && name === 'request') {
      const kindRaw = String(args.kind ?? '')
      const kind = kindRaw === 'proposal' || kindRaw === 'question' || kindRaw === 'confirmation' ? kindRaw : null
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!kind || !prompt) {
        return { content: [{ type: 'text', text: JSON.stringify({ accepted: false, answer: 'request needs a kind and a non-empty prompt.' }) }] }
      }
      const options = Array.isArray(args.options)
        ? args.options.map(o => String(o ?? '').trim()).filter(Boolean)
        : undefined
      const result = await queueBroker.push(spawnId, { kind, prompt, options })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }

    if (role.role === 'root' && name === 'list') {
      return { content: [{ type: 'text', text: JSON.stringify({ items: queueBroker.list() }) }] }
    }

    if (role.role === 'root' && name === 'claim') {
      const id = typeof args.id === 'string' ? args.id : ''
      const item = id ? queueBroker.claim(id) : undefined
      return { content: [{ type: 'text', text: JSON.stringify(item ? { ok: true, item } : { ok: false, error: 'not_found_or_already_claimed' }) }] }
    }

    if (role.role === 'root' && name === 'resolve') {
      const id = typeof args.id === 'string' ? args.id : ''
      const accepted = args.accepted === true
      const answer = typeof args.answer === 'string' && args.answer ? args.answer : undefined
      if (!id) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_id' }) }] }
      }
      queueBroker.resolve(id, { accepted, answer })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown_tool' }) }] }
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
    console.error('[mcp-queue] request failed:', err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal_error' },
        id: null,
      })
    }
  }
})

const methodNotAllowed = (_req: import('express').Request, res: import('express').Response): void => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  })
}
mcpQueueRouter.get('/mcp/queue/:spawnId', methodNotAllowed)
mcpQueueRouter.delete('/mcp/queue/:spawnId', methodNotAllowed)
