import { Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appBroker } from '../services.js'

// Shared MCP endpoint backing the built-in apps (timer, notes). No spawnId —
// app state is global to the user (one timer, one notes blob), so a per-spawn
// capability model would just be ceremony. The route is loopback-only.
//
// Tools exposed:
//   timer.start  / pause / resume / cancel / status
//   notes.read   / write / append / clear
// Each tool is a thin wrapper around an AppBroker method; AppBroker emits
// state events that the WS layer broadcasts as `app_state` wire messages so
// every open client (bubble bar + popups) stays live.

export const mcpAppsRouter = Router()

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

mcpAppsRouter.post('/mcp/apps', async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(404).json({ ok: false, error: 'not_found' })
    return
  }

  const server = new Server(
    { name: 'axel-apps', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'start_timer',
        description: 'Start a countdown timer for `minutes` minutes. Replaces any timer already running. The bubble pulses while the timer ticks; the user can pause or cancel by clicking it.',
        inputSchema: {
          type: 'object',
          required: ['minutes'],
          properties: {
            minutes: { type: 'number', description: 'Duration in minutes, > 0 and ≤ 1440.' },
          },
        },
      },
      {
        name: 'pause_timer',
        description: 'Pause the running timer. Remaining time is preserved.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'resume_timer',
        description: 'Resume a paused timer.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'cancel_timer',
        description: 'Stop and discard the timer.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'timer_status',
        description: 'Get the current timer state: running, paused, remaining ms, duration ms. Returns { running: false } if no timer is active.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'read_notes',
        description: 'Read the current notes scratchpad content.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'write_notes',
        description: 'Replace the notes scratchpad with `content`. The user can also edit notes directly by clicking the notes bubble.',
        inputSchema: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', description: 'New content for the notes scratchpad. ≤ 1 MB.' },
          },
        },
      },
      {
        name: 'append_notes',
        description: 'Append `text` to the notes scratchpad (with a newline if needed).',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Text to append.' },
          },
        },
      },
      {
        name: 'clear_notes',
        description: 'Clear the notes scratchpad.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    const name = request.params.name
    let result: unknown
    switch (name) {
      case 'start_timer':   result = appBroker.startTimer(Number(args.minutes));   break
      case 'pause_timer':   result = appBroker.pauseTimer();                       break
      case 'resume_timer':  result = appBroker.resumeTimer();                      break
      case 'cancel_timer':  result = appBroker.cancelTimer();                      break
      case 'timer_status':  result = appBroker.timerStatus();                      break
      case 'read_notes':    result = appBroker.readNotes();                        break
      case 'write_notes':   result = appBroker.writeNotes(String(args.content ?? '')); break
      case 'append_notes':  result = appBroker.appendNotes(String(args.text ?? ''));   break
      case 'clear_notes':   result = appBroker.clearNotes();                       break
      default:              result = { ok: false, error: `unknown tool: ${name}` }
    }
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
    console.error('[mcp-apps] request failed:', err)
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
mcpAppsRouter.get('/mcp/apps', methodNotAllowed)
mcpAppsRouter.delete('/mcp/apps', methodNotAllowed)
