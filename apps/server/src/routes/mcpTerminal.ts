import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { terminalBroker } from '../services.js'

// Per-spawn MCP endpoint backing the open_terminal tool. Same capability
// model as /mcp/permission: each spawn injects an mcp-config entry pointing
// here with a fresh UUID; the unguessable spawnId is the auth. Stateless
// transport — every POST gets a fresh server; the broker holds all state.
export const mcpTerminalRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpTerminalRouter.post('/mcp/terminal/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !terminalBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-terminals', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'open_terminal',
      description:
        'Open OR reuse a project terminal. If the BACKGROUND TERMINALS section already lists a terminal in the dir you want and you have a follow-up task for it, pass that terminal\'s [t-xxxxxxxx] id as `term` — the prompt goes to the SAME claude conversation, the SAME visible tab. Same dir + new task with NO `term` opens a NEW tab; do that only when you genuinely need parallel work in that dir. Pass `prompt` to start work immediately, or omit it to just open an empty tab.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory name under the projects root. Omit to open in the current project.' },
          prompt: { type: 'string', description: 'Optional task for the terminal to start on immediately.' },
          term: { type: 'string', description: 'Optional. The [t-xxxxxxxx] id of an existing terminal in this dir, taken from the BACKGROUND TERMINALS section. Setting this reuses that terminal (same conversation, same tab) instead of spawning a new PTY. If the id no longer matches a live PTY the call silently falls back to opening a fresh terminal — no error.' },
        },
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as { directory?: string; prompt?: string; term?: string }
    const result = await terminalBroker.open(spawnId, args)
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
    console.error('[mcp-terminal] request failed:', err)
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
mcpTerminalRouter.get('/mcp/terminal/:spawnId', methodNotAllowed)
mcpTerminalRouter.delete('/mcp/terminal/:spawnId', methodNotAllowed)
