// Per-directory terminal window. Hosts one or more terminal sessions as tabs
// (each an independent agent conversation); a tab can be split out into its
// own standalone window. Shows the active session's last lines, a draggable/
// resizable chrome, a prompt bar, and a mini-orb button to queue AI attention.
import React, { useEffect, useRef, useState } from 'react'
import type { Session } from '../../types/constellation.js'
import type { PermissionRequest, QuestionRequest } from '../../hooks/useVoiceInterface.js'
import type { DragEngine } from './engine/useDragEngine.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { PtyView } from './PtyView.js'
import { QuestionPrompt } from './QuestionPrompt.js'
import { Window } from './Window.js'

// Window dimensions — shared so the off-screen clamp in ConstellationScene
// bounds against the same box this renders. Tabbed: header+tabs+body+prompt
// (see the height breakdown by the <Window> below). Detached single: 150px.
export const SWIN_TAB_W = 240
export const SWIN_TAB_H = 179
export const SWIN_DETACH_W = 220
export const SWIN_DETACH_H = 150

type Props = {
  id: string
  sessions: Array<Session>      // tabs, creation order; detached windows get exactly one
  active: Session
  x: number
  y: number
  focus: boolean
  drag: DragEngine
  detached?: boolean            // standalone split-out window — no tab strip
  permTabIds?: Set<string>      // sessions with a pending permission prompt
  onSend: (term: string, text: string) => void
  onQueueFocus: () => void
  queued: boolean
  onSelectTab: (sess: Session) => void
  onNewTab: () => void
  onDetach: (sessId: string) => void   // tabbed: split out; detached: re-attach
  onCloseTab: (sessId: string) => void
  permissions?: Array<PermissionRequest>
  onPermission?: (id: string, behavior: 'allow' | 'deny') => void
  questions?: Array<QuestionRequest>
  onQuestion?: (id: string, choice: number | 'cancel') => void
  raiseLevel?: number
  onRaise?: () => void
}

function tabLabel(sess: Session, index: number): string {
  return sess.term === 'main' ? 'main' : String(index + 1)
}

export function SessionWin({
  id, sessions, active, x, y, focus, drag, detached,
  permTabIds, onSend, onQueueFocus, queued,
  onSelectTab, onNewTab, onDetach, onCloseTab,
  permissions, onPermission, questions, onQuestion, raiseLevel, onRaise,
}: Props): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [input, setInput] = useState('')

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [active.lines])

  const submit = (): void => {
    const t = input.trim(); if (!t) return
    setInput('')
    onSend(active.term, t)
  }

  const dirName = active.targetPath.split('/').filter(Boolean).pop() ?? active.targetPath

  const tab = (
    <>
      {(!focus || detached) && (
        <span className="win-name">
          {dirName}
          {detached && active.term !== 'main' && ` · ${active.term.slice(0, 6)}`}
        </span>
      )}
      {active.verb && active.verb !== 'chat' && (
        <span className="win-verb">
          {active.verb === 'working' && <span className="sp" />}
          {active.verb}
        </span>
      )}
      {detached && (
        <>
          <button
            className="swin-btn"
            title="Re-attach to the directory window"
            aria-label="Re-attach terminal"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => onDetach(active.id)}
          >⇱</button>
          <button
            className="swin-btn"
            title="Close terminal"
            aria-label="Close terminal"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => onCloseTab(active.id)}
          >×</button>
        </>
      )}
    </>
  )

  // Tabbed: header(~40) + tabs(~29) + body(~72) + prompt(~38) ≈ 179px.
  // Detached single: original 150px. Explicit height enables win-flex + resize.
  return (
    <Window
      id={id} x={x} y={y}
      width={detached ? SWIN_DETACH_W : SWIN_TAB_W}
      height={detached ? SWIN_DETACH_H : SWIN_TAB_H}
      focus={focus} drag={drag} tabContent={tab}
      raiseLevel={raiseLevel} onRaise={onRaise}
    >
      {!detached && (
        <div className="swin-tabs" onPointerDown={e => e.stopPropagation()}>
          <div className="fwin-tabs">
            {sessions.map((s, i) => (
              <span
                key={s.id}
                className={`ftab${s.id === active.id ? ' on' : ''}`}
                onClick={() => onSelectTab(s)}
              >
                {tabLabel(s, i)}
                {s.id !== active.id && permTabIds?.has(s.id) && <em className="ftab-perm" />}
                {s.id !== active.id && s.verb === 'working' && <em className="ftab-busy" />}
                <button
                  className="ftab-x"
                  aria-label={`Close terminal ${tabLabel(s, i)}`}
                  onClick={e => { e.stopPropagation(); onCloseTab(s.id) }}
                >✕</button>
              </span>
            ))}
            <span className="ftab add" role="button" aria-label="New terminal" onClick={onNewTab}>+</span>
          </div>
          <button
            className="swin-btn"
            title="Split this terminal into its own window"
            aria-label="Detach terminal"
            onClick={() => onDetach(active.id)}
          >⧉</button>
        </div>
      )}

      {/* When the server has reported a pty_ready for this terminal, swap the
          line-buffer for a real xterm view bound to /agent/pty/<spawnId>.
          Falls back to the legacy line render until the PTY is ready (covers
          the brief gap between target_start and pty_ready, and the legacy
          ClaudeCodeAgent runtime). */}
      {active.spawnId ? (
        <div className="win-body win-body-pty" ref={bodyRef}>
          <PtyView spawnId={active.spawnId} />
        </div>
      ) : (
        <div className="win-body" ref={bodyRef}>
          {active.lines.slice(-6).map((l, i) => (
            <div key={i} className={`gl g-${l.who}`}>{l.t}</div>
          ))}
        </div>
      )}

      {/* Pending tool approval — one at a time; the rest queue behind it */}
      {permissions && permissions.length > 0 && onPermission && (
        <PermissionPrompt req={permissions[0]} queue={permissions.slice(1)} onRespond={onPermission} />
      )}

      {/* Pending multiple-choice question — agent paused waiting for the user */}
      {questions && questions.length > 0 && onQuestion && (
        <QuestionPrompt req={questions[0]} moreCount={questions.length - 1} onRespond={onQuestion} />
      )}

      {/* Prompt bar — input + mini-orb queue button + send */}
      <div className="win-prompt">
        <input
          className="win-prompt-in"
          name="ax-prompt"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-form-type="other"
          placeholder="ask axle…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          // Prevent tab-bar drag from triggering on input click
          onPointerDown={e => e.stopPropagation()}
        />
        <button
          className={`win-orb-btn${queued ? ' queued' : ''}`}
          onClick={onQueueFocus}
          title={queued ? 'Queued for AI' : 'Ask AI about this session'}
          aria-label="Queue AI attention"
        />
        <button
          className="win-send-btn"
          onClick={submit}
          aria-label="Send"
        >↵</button>
      </div>
    </Window>
  )
}
