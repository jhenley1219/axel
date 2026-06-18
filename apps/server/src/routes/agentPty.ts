// Bidirectional WebSocket carrying raw PTY bytes for one interactive `claude`
// session. The web client connects to /agent/pty/<spawnId> after receiving a
// `pty_ready` event on /agent/stream, mounts an xterm.js view, and pipes
// keystrokes back. Multiple clients can subscribe to the same spawnId — a
// phone and a laptop watching the same terminal both see the bytes.
//
// Control frames (text JSON):
//   { "type": "resize", "cols": N, "rows": M }
// Anything else (binary OR non-JSON text) is forwarded verbatim to pty.write.
import type { IncomingMessage } from 'http'
import { parse as parseCookie } from 'cookie'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from '../config.js'
import { sessionManager, ptyAgent } from '../services.js'

export function createPtyWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  // Heartbeat — same approach as the /agent/stream WSS, since the same iOS
  // Safari NAT timeouts kill these connections silently.
  const HEARTBEAT_MS = 25_000
  const alive = new WeakSet<WebSocket>()
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue }
      alive.delete(ws)
      try { ws.ping() } catch { /* gone */ }
    }
  }, HEARTBEAT_MS)
  interval.unref?.()
  wss.on('close', () => clearInterval(interval))

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, spawnId: string) => {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))

    const session = ptyAgent.getSession(spawnId)
    if (!session) {
      ws.close(4404, 'pty_not_found')
      return
    }
    if (session.isClosed) {
      ws.close(4410, 'pty_closed')
      return
    }

    // Replay scrollback so a late connection (page reload, second tab) sees
    // the existing terminal state. Cap is enforced inside the session itself
    // (MAX_BACKLOG_BYTES).
    for (const buf of session.backlog) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true })
    }

    const onData = (data: Buffer): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true })
    }
    session.subscribers.add(onData)

    ws.on('message', (raw: Buffer | ArrayBuffer | Array<Buffer>, isBinary: boolean) => {
      // Control plane: JSON text frames for resize / flush. User keystrokes
      // arrive as binary buffers (xterm's onData() stream) — write them
      // straight through.
      if (!isBinary) {
        const text = raw.toString()
        if (text.startsWith('{')) {
          try {
            const ctrl = JSON.parse(text) as Record<string, unknown>
            if (ctrl.type === 'resize' && typeof ctrl.cols === 'number' && typeof ctrl.rows === 'number') {
              try { session.pty.resize(Math.max(2, ctrl.cols | 0), Math.max(2, ctrl.rows | 0)) } catch { /* PTY gone */ }
              return
            }
            if (ctrl.type === 'flush_queue') {
              // Reserved for the "user typing cancels queued orchestrator
              // turns" path. The orchestrator's per-terminal childQueues
              // serialize one turn at a time today; canceling them mid-write
              // is a follow-up. For v1 we just acknowledge.
              ptyAgent.flushQueuedFor(spawnId)
              return
            }
          } catch { /* fall through and write as raw text */ }
        }
        session.pty.write(text)
        return
      }
      const buf = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer)
      session.pty.write(buf.toString('utf8'))
    })

    ws.on('close', () => {
      session.subscribers.delete(onData)
    })
    ws.on('error', () => {
      session.subscribers.delete(onData)
    })
  })

  return wss
}

const PTY_PATH_PREFIX = '/agent/pty/'

export function handlePtyUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
): void {
  const url = req.url ?? ''
  if (!url.startsWith(PTY_PATH_PREFIX)) {
    socket.destroy()
    return
  }
  // Auth before upgrade — refuse the WS handshake outright when the cookie
  // doesn't carry a valid session. Same pattern as createAgentWss().
  if (config.requireAuth) {
    const cookies = parseCookie(req.headers.cookie ?? '')
    const token = cookies['session']
    const ok = token ? !!sessionManager.verify(token) : false
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
  }
  const spawnId = url.slice(PTY_PATH_PREFIX.length).split('?')[0]
  if (!spawnId) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, spawnId)
  })
}
