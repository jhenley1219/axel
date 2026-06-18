import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileBroker } from '../services.js'
import type { OpenFileArgs } from '@axel/agent'

// Per-spawn MCP endpoint backing the open_file tool. Same capability model as
// /mcp/permission and /mcp/terminal: each spawn injects a fresh-UUID mcp-config
// entry; the unguessable spawnId is the auth. Fire-and-forget — the broker
// emits a file_open_request wire event and resolves immediately.
export const mcpFilesRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpFilesRouter.post('/mcp/files/:spawnId', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !fileBroker.has(req.params.spawnId)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }
  const spawnId = req.params.spawnId

  const server = new Server(
    { name: 'axel-files', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'open_file',
      description:
        'Surface a file to the user in the UI. Use this when the user needs to fill in values (e.g. an empty .env), when you want them to review a section before you change it, or when you want to suggest a one-shot edit they can accept with one click. Fire-and-forget: the call returns immediately while the user reacts on their own time.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file. Absolute or relative to the current project directory.',
          },
          highlights: {
            type: 'array',
            description: 'Literal substrings to highlight in the file. Each snippet is matched as-is (no regex). Use the actual text from the file — read it first if you need to.',
            items: {
              type: 'object',
              required: ['snippet'],
              properties: {
                snippet: { type: 'string', description: 'Exact text from the file to highlight.' },
                reason:  { type: 'string', description: 'Short note shown on hover explaining why this is highlighted.' },
                kind:    { type: 'string', enum: ['warn', 'error', 'info'], description: 'Visual style. Defaults to info.' },
              },
            },
          },
          suggestion: {
            type: 'object',
            description: 'A one-shot find/replace the user can accept or reject. Use sparingly — only when the edit is small and the change is unambiguous.',
            required: ['find', 'replace'],
            properties: {
              find:    { type: 'string', description: 'Exact text in the file to be replaced.' },
              replace: { type: 'string', description: 'Text to replace it with.' },
              reason:  { type: 'string', description: 'Why this change is being suggested.' },
            },
          },
          prompt: {
            type: 'string',
            description: 'Short banner shown above the file telling the user what you need from them (e.g. "Fill in ANTHROPIC_API_KEY").',
          },
        },
      },
    }],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as OpenFileArgs
    const result = await fileBroker.open(spawnId, args)
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
    console.error('[mcp-files] request failed:', err)
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
mcpFilesRouter.get('/mcp/files/:spawnId', methodNotAllowed)
mcpFilesRouter.delete('/mcp/files/:spawnId', methodNotAllowed)
