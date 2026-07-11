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
        'Send a task to a project terminal — and by DEFAULT continue the one that is already open. If a terminal exists for the directory (shown in BACKGROUND TERMINALS, including the user\'s "main" terminal), your `prompt` goes into that SAME claude conversation, SAME tab, keeping full context — that is how you send a follow-up, answer its question, or give it the next step. Pass `term` to target a specific terminal by its [id] (e.g. "main" or "t-xxxxxxxx"). Pass `new: true` ONLY when the user explicitly wants a separate terminal for parallel work on something else — never just to relay a follow-up. Omit `prompt` to just focus/open a tab.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory name under the projects root. Omit to use the current project.' },
          prompt: { type: 'string', description: 'The task/message to send. Goes into the target\'s existing terminal by default.' },
          term: { type: 'string', description: 'Optional. The [id] of the terminal to send to — "main" (the user\'s own terminal) or a [t-xxxxxxxx] id from BACKGROUND TERMINALS. Reuses that exact conversation. Omit to use the directory\'s current terminal.' },
          new: { type: 'boolean', description: 'Set true to force a brand-new terminal instead of reusing the current one. ONLY for explicit parallel work on something separate — not for follow-ups.' },
        },
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as { directory?: string; prompt?: string; term?: string; new?: boolean }
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
