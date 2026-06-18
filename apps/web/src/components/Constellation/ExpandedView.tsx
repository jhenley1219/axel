// Fullscreen overlay for the main chat — the source of truth for everything
// going on. Two modes: 'chat' shows the full main-session history with the
// prompt bar; 'dashboard' shows one tile per live agent session (plus the main
// session), each with its full transcript and its own dir-scoped input.
import React, { useEffect, useRef, useState } from 'react'
import type { Message } from '../../hooks/messages.js'
import type { Session } from '../../types/constellation.js'
import type { PermissionRequest } from '../../hooks/useVoiceInterface.js'
import { PermissionPrompt } from './PermissionPrompt.js'

export type ExpandMode = 'none' | 'chat' | 'dashboard'

type Props = {
  mode: ExpandMode
  onModeChange: (mode: ExpandMode) => void
  messages: Array<Message>
  chatInput: string
  setChatInput: (v: string) => void
  onSendChat: () => void
  sessions: Map<string, Session>
  onSessionSend: (systemId: string, term: string, text: string) => void
  // Root-agent permission prompts — rendered inline in the main chat/dashboard
  // tile so the user sees them as part of the conversation, not a floating
  // card. Per-dir prompts live inside their own SessionWin.
  mainPermissions: Array<PermissionRequest>
  onPermission: (id: string, behavior: 'allow' | 'deny') => void
}

function useAutoScroll(dep: unknown): React.MutableRefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [dep])
  return ref
}

function SessionTile({ session, onSend }: { session: Session; onSend: (text: string) => void }): React.ReactElement {
  const bodyRef = useAutoScroll(session.lines)
  const [input, setInput] = useState('')

  const submit = (): void => {
    const t = input.trim(); if (!t) return
    setInput('')
    onSend(t)
  }

  return (
    <div className="ax-dash-tile">
      <div className="win-tab">
        <span className="win-dot" />
        <span className="win-name" title={session.targetPath}>
          {session.targetPath.split('/').filter(Boolean).pop() ?? session.targetPath}
          {session.term !== 'main' && ` · ${session.term.slice(0, 8)}`}
        </span>
        {session.verb && session.verb !== 'chat' && (
          <span className="win-verb">
            {session.verb === 'working' && <span className="sp" />}
            {session.verb}
          </span>
        )}
      </div>
      <div className="ax-dash-body" ref={bodyRef}>
        {session.lines.map((l, i) => (
          <div key={i} className={`gl g-${l.who}`}>{l.t}</div>
        ))}
      </div>
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
        />
        <button className="win-send-btn" onClick={submit} aria-label="Send">↵</button>
      </div>
    </div>
  )
}

export function ExpandedView({
  mode, onModeChange,
  messages, chatInput, setChatInput, onSendChat,
  sessions, onSessionSend,
  mainPermissions, onPermission,
}: Props): React.ReactElement | null {
  const open = mode !== 'none'
  // Auto-scroll on new permissions too, so an arriving prompt isn't off-screen.
  const chatRef = useAutoScroll([messages, mainPermissions])
  const mainRef = useAutoScroll([messages, mainPermissions])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onModeChange('none') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onModeChange])

  if (!open) return null

  const sessionList = [...sessions.values()]

  return (
    <>
      <div className="ax-expand-scrim" onClick={() => onModeChange('none')} />
      <div className="ax-expand">
        <div className="ax-expand-head">
          <span className="ax-expand-title">{mode === 'chat' ? 'CHAT' : 'AGENTS'}</span>
          <button
            className={`ax-settings-btn${mode === 'chat' ? ' primary' : ''}`}
            onClick={() => onModeChange('chat')}
          >chat</button>
          <button
            className={`ax-settings-btn${mode === 'dashboard' ? ' primary' : ''}`}
            onClick={() => onModeChange('dashboard')}
          >agents</button>
          <button className="ax-settings-close" onClick={() => onModeChange('none')} aria-label="Close">✕</button>
        </div>

        {mode === 'chat' ? (
          <>
            <div className="ax-expand-chat" ref={chatRef}>
              {messages.length === 0 && (
                <div className="ax-expand-empty">no messages yet — type below or tap the orb to talk</div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`m ${m.role === 'user' ? 'user' : 'axle'}`}>
                  <strong>{m.role === 'user' ? 'you' : 'axle'}</strong>
                  {m.text}
                </div>
              ))}
              {mainPermissions.map(req => (
                <div key={req.id} className="m axle">
                  <PermissionPrompt req={req} onRespond={onPermission} />
                </div>
              ))}
            </div>
            <div className="ax-expand-foot">
              <div className="gdock-in">
                <span className="you">you</span>
                <input
                  className="ph"
                  name="ax-prompt"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                  autoFocus
                  placeholder="type a prompt or tap the orb to talk…"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendChat() } }}
                />
                <button className="snd" onClick={onSendChat}>↵</button>
              </div>
            </div>
          </>
        ) : (
          <div className="ax-dash">
            <div className="ax-dash-tile main">
              <div className="win-tab">
                <span className="win-dot" />
                <span className="win-name">axle · main</span>
              </div>
              <div className="ax-dash-body" ref={mainRef}>
                {messages.map((m, i) => (
                  <div key={i} className={`gl ${m.role === 'user' ? 'g-you' : 'g-axle'}`}>{m.text}</div>
                ))}
                {mainPermissions.map(req => (
                  <div key={req.id} className="gl g-axle">
                    <PermissionPrompt req={req} onRespond={onPermission} />
                  </div>
                ))}
              </div>
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
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSendChat() } }}
                />
                <button className="win-send-btn" onClick={onSendChat} aria-label="Send">↵</button>
              </div>
            </div>

            {sessionList.map(s => (
              <SessionTile key={s.id} session={s} onSend={text => onSessionSend(s.systemId, s.term, text)} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
