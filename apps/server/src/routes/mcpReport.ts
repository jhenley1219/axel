import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { reportBroker } from '../services.js'

// Per-spawn MCP endpoint backing the axel_report tool — CHILD spawns only.
// Same capability model as mcpAsk / mcpQueue: stateless transport, fresh
// Server per POST, loopback-only, spawnId-as-capability. Submitting a report
// re-emits the summary as a synthetic token + message_end via the broker; the
// orchestrator's wrappedOnEvent in runDirMessage appends it into
// childTranscripts so the root agent's BACKGROUND TERMINALS prompt section
// renders the summary instead of "(no output yet)".
export const mcpReportRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpReportRouter.post('/mcp/report/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !reportBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-report', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'report',
      description:
        'REQUIRED at the end of every task. Send a short plain-English summary of what you did, what you ran to verify, and anything that failed back to the root agent. Without this call the root agent has NO visibility into your work and tells the user "the terminal sent back no output". Call exactly once, just before your turn ends. The root agent will read this verbatim or paraphrase it for the user over voice — keep it readable and conversational.',
      inputSchema: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: {
            type: 'string',
            description: 'One to four sentences. Lead with the result, name the file(s) you touched, and mention any verification step (test pass, lint clean, file written). Plain prose — no markdown, no bullet lists, no code blocks.',
          },
        },
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as { summary?: unknown }
    const summary = typeof args.summary === 'string' ? args.summary : ''
    const result = reportBroker.submit(spawnId, { summary })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
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
    console.error('[mcp-report] request failed:', err)
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
mcpReportRouter.get('/mcp/report/:spawnId', methodNotAllowed)
mcpReportRouter.delete('/mcp/report/:spawnId', methodNotAllowed)
