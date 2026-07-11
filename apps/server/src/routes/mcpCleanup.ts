import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { cleanupBroker } from '../services.js'

// Per-spawn MCP endpoint backing the close_idle_dirs tool. Same capability
// model as /mcp/permission and /mcp/files: each spawn injects a fresh-UUID
// mcp-config entry; the unguessable spawnId is the auth. The handler delegates
// to the orchestrator, which decides which dirs are idle and emits dir_closed
// wire events.
export const mcpCleanupRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpCleanupRouter.post('/mcp/cleanup/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !cleanupBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-cleanup', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'close_idle_dirs',
        description:
          'Close any open project directories with no active work — no in-flight runs in any of the dir\'s terminals. Use this to tidy up after a batch of tasks finishes, so the constellation only shows dirs still doing something. Returns the list of dirs that were closed.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'go_home',
        description:
          'Return the user\'s view to the projects root (their "coding projects" home). Use when the user asks to go back to the root / coding-projects directory, go home, or leave the current project WITHOUT opening another. The projects root is NOT an openable project — never call open_terminal for it; call this instead.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const action = request.params.name === 'go_home' ? 'go_home' : 'close_idle'
    const result = await cleanupBroker.closeIdle(spawnId, { action })
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
    console.error('[mcp-cleanup] request failed:', err)
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
mcpCleanupRouter.get('/mcp/cleanup/:spawnId', methodNotAllowed)
mcpCleanupRouter.delete('/mcp/cleanup/:spawnId', methodNotAllowed)
