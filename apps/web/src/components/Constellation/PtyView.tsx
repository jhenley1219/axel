// Mounts an xterm.js view bound to /agent/pty/<spawnId>. Renders the real
// `claude` interactive TUI — full ANSI, box drawing, slash commands — inside
// the SessionWin body. Keystrokes from the terminal go straight to the PTY's
// stdin; PTY stdout flows back via WebSocket and is fed into xterm.write().
import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const PTY_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

type Props = {
  spawnId: string
  // Optional callback fired when the user submits a prompt directly into
  // the terminal (Enter while at the input box). The parent (SessionWin /
  // orchestrator wire) can use this to flush queued orchestrator turns for
  // this PTY — per the "manual handling cancels queued work" rule.
  onUserSubmit?: () => void
}

export function PtyView({ spawnId, onUserSubmit }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef  = useRef<FitAddon | null>(null)
  const wsRef   = useRef<WebSocket | null>(null)
  const submitRef = useRef(onUserSubmit)
  useEffect(() => { submitRef.current = onUserSubmit }, [onUserSubmit])

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.15,
      cursorBlink: true,
      // claude's TUI uses true-color background fills — match the SessionWin
      // chrome so the box doesn't show a black gutter when the TUI shrinks.
      theme: { background: '#0a0a12', foreground: '#e6e6f0' },
      allowProposedApi: true,
      scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current  = fit

    const url = `${PTY_PROTOCOL}//${window.location.host}/agent/pty/${encodeURIComponent(spawnId)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
      if (typeof ev.data === 'string') {
        term.write(ev.data)
        return
      }
      term.write(new Uint8Array(ev.data))
    }
    ws.onopen = () => {
      // Report current size so claude redraws at the right cols/rows.
      try {
        const { cols, rows } = term
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      } catch { /* fit may not have measured yet */ }
    }
    ws.onclose = () => {
      try { term.write('\r\n\x1b[90m[pty disconnected — close & reopen this terminal]\x1b[0m\r\n') } catch { /* gone */ }
    }

    // Keystrokes → PTY. Detect Enter (CR/LF) so we can fire onUserSubmit.
    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
      // Fire-and-forget heuristic — any CR submits the current input box.
      // Multiple submits per typed line is fine: subscribers de-dup.
      if (data.includes('\r') || data.includes('\n')) submitRef.current?.()
    })

    // Keep the PTY's cols/rows in sync with the rendered cell grid. The
    // SessionWin is resizable; refit on the window-level resize and on each
    // body mutation we can cheaply observe.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch { /* element gone */ }
    })
    ro.observe(hostRef.current)

    return () => {
      ro.disconnect()
      try { ws.close() } catch { /* gone */ }
      try { term.dispose() } catch { /* gone */ }
      termRef.current = null
      fitRef.current  = null
      wsRef.current   = null
    }
  }, [spawnId])

  return <div ref={hostRef} className="pty-host" style={{ width: '100%', height: '100%' }} />
}
