// Countdown timer popup. Reads server-mirrored timer state, ticks the display
// off Date.now() locally (so reconnects are free and no per-tick wire traffic),
// dispatches actions via the WS `app_action` control message.

import React, { useEffect, useState } from 'react'
import type { TimerState } from '@axel/agent'

type Props = {
  state: TimerState | null
  onDispatch: (action: string, payload?: Record<string, unknown>) => void
  onClose: () => void
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function remainingMs(state: TimerState): number {
  const elapsed = state.paused && state.pausedAt !== undefined
    ? state.pausedAt - state.startedAt
    : Date.now() - state.startedAt
  return Math.max(0, state.durationMs - elapsed)
}

export function TimerApp({ state, onDispatch, onClose }: Props): React.ReactElement {
  // Tick once per second while the timer is running (and not paused). Pure
  // display refresh — the canonical state lives on the server.
  const [, force] = useState(0)
  useEffect(() => {
    if (!state || state.paused) return
    const id = setInterval(() => force(n => n + 1), 250)
    return () => clearInterval(id)
  }, [state])

  const [minutesInput, setMinutesInput] = useState('25')

  if (!state) {
    return (
      <div className="app-pop">
        <div className="app-pop-head">
          <span className="app-pop-title">Timer</span>
          <button className="app-pop-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="app-pop-body">
          <div className="tm-face tm-idle">00:00</div>
          <div className="tm-controls">
            <input
              type="number"
              className="tm-input"
              min={1}
              max={1440}
              value={minutesInput}
              onChange={e => setMinutesInput(e.target.value)}
              aria-label="Minutes"
            />
            <button
              className="app-btn app-btn-primary"
              onClick={() => {
                const m = Number(minutesInput)
                if (m > 0 && m <= 1440) onDispatch('start', { minutes: m })
              }}
            >start</button>
          </div>
        </div>
      </div>
    )
  }

  const rem = remainingMs(state)
  const done = rem <= 0
  const pct = Math.min(1, Math.max(0, 1 - rem / state.durationMs))
  return (
    <div className="app-pop">
      <div className="app-pop-head">
        <span className="app-pop-title">Timer</span>
        <button className="app-pop-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="app-pop-body">
        <div className={`tm-face${state.paused ? ' tm-paused' : ''}${done ? ' tm-done' : ''}`}>{fmt(rem)}</div>
        <div className="tm-bar" aria-hidden="true">
          <div className="tm-bar-fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <div className="tm-controls">
          {!state.paused && !done && <button className="app-btn" onClick={() => onDispatch('pause')}>pause</button>}
          { state.paused && !done && <button className="app-btn app-btn-primary" onClick={() => onDispatch('resume')}>resume</button>}
          <button className="app-btn" onClick={() => onDispatch('cancel')}>{done ? 'reset' : 'cancel'}</button>
        </div>
      </div>
    </div>
  )
}
