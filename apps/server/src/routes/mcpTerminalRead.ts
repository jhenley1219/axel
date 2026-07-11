import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { terminalReadBroker } from '../services.js'

// Per-spawn MCP endpoint backing the read_terminal tool — ROOT spawns only.
// Same capability model as the other axel_* routes: stateless transport,
// fresh Server per POST, loopback-only, unguessable spawnId as auth.
//
// This is the root agent's escape hatch when the BACKGROUND TERMINALS prompt
// prefill is missing or garbled. The orchestrator resolves (target, term?)
// to either the cleaned childTranscripts buffer or the raw PTY tail and
// hands it back as plain text.
export const mcpTerminalReadRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpTerminalReadRouter.post('/mcp/terminal_read/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !terminalReadBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-terminal-read', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'read_terminal',
      description:
        'Read the COMPLETE conversation of one of your sub-terminals — every user prompt, assistant reply, and tool call, straight from the terminal\'s persisted transcript. Use whenever the BACKGROUND TERMINALS section looks empty / says "(no output yet)" / shows garbled TUI fragments — this returns the real, full conversation instead. Pass `target` (the project dir name from the BACKGROUND TERMINALS header). Omit `term` to list every terminal open for that project and read the most recent; pass `term` (the [t-xxxxxxxx] id, or "main") to read a specific one. Set `raw: true` only if you need the unfiltered live PTY tail (last 4KB of ANSI-stripped output).',
      inputSchema: {
        type: 'object',
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Project dir name (matches a BACKGROUND TERMINALS header).' },
          term:   { type: 'string', description: 'Terminal id, e.g. "main" (default) or "t-a1b2c3d4".' },
          raw:    { type: 'boolean', description: 'When true, return the less-filtered PTY tail. Useful when the cleaner stripped the actual findings.' },
        },
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as { target?: string; term?: string; raw?: boolean }
    const result = await terminalReadBroker.read(spawnId, args)
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
    console.error('[mcp-terminal-read] request failed:', err)
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
mcpTerminalReadRouter.get('/mcp/terminal_read/:spawnId', methodNotAllowed)
mcpTerminalReadRouter.delete('/mcp/terminal_read/:spawnId', methodNotAllowed)
