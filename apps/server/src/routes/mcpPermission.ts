import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { permissionBroker } from '../services.js'

// Per-spawn MCP endpoint backing claude's --permission-prompt-tool. Each
// ClaudeCodeAgent spawn injects an mcp-config entry pointing here with a
// fresh UUID; that unguessable spawnId is the auth capability (the claude
// process can't carry a session cookie). Stateless transport — every POST
// gets a fresh server instance; the broker holds all cross-request state.
export const mcpPermissionRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpPermissionRouter.post('/mcp/permission/:spawnId', async (req, res) => {
  // claude is spawned by this very process — anything not from localhost
  // (or holding a dead/unknown spawnId) has no business here.
  if (!isLoopback(req.socket.remoteAddress) || !permissionBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-permissions', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'approve',
      description: 'Ask the Axel user to approve or deny a tool call.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object', additionalProperties: true },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as { tool_name?: string; input?: unknown }
    const decision = await permissionBroker.request(spawnId, args.tool_name ?? 'unknown', args.input)
    return { content: [{ type: 'text', text: JSON.stringify(decision) }] }
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
    console.error('[mcp-permission] request failed:', err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal_error' },
        id: null,
      })
    }
  }
})

// Stateless transport: no SSE stream to resume, no session to delete.
const methodNotAllowed = (_req: import('express').Request, res: import('express').Response): void => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  })
}
mcpPermissionRouter.get('/mcp/permission/:spawnId', methodNotAllowed)
mcpPermissionRouter.delete('/mcp/permission/:spawnId', methodNotAllowed)
