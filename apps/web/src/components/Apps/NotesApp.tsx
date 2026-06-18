// Shared scratchpad popup. Local draft state debounces user input before
// pushing it to the server via `write` — so an agent's incoming `write_notes`
// (from a tool call) doesn't fight the cursor every keystroke. When the
// server-side content changes externally and the user isn't actively typing,
// we sync the textarea to the new value.

import React, { useEffect, useRef, useState } from 'react'
import type { NotesState } from '@axel/agent'

type Props = {
  state: NotesState
  onDispatch: (action: string, payload?: Record<string, unknown>) => void
  onClose: () => void
}

const DEBOUNCE_MS = 400

export function NotesApp({ state, onDispatch, onClose }: Props): React.ReactElement {
  const [draft, setDraft] = useState(state.content)
  const lastServerContentRef = useRef(state.content)
  const typingRef = useRef(false)

  // If the server pushed a new value AND the user isn't actively typing
  // (i.e. they're idle and an external write came in from the agent), sync
  // the draft. Otherwise hold what the user typed.
  useEffect(() => {
    if (state.content === lastServerContentRef.current) return
    lastServerContentRef.current = state.content
    if (!typingRef.current) setDraft(state.content)
  }, [state.content])

  // Debounced flush of the draft to the server.
  useEffect(() => {
    if (draft === lastServerContentRef.current) return
    typingRef.current = true
    const id = setTimeout(() => {
      typingRef.current = false
      onDispatch('write', { content: draft })
      lastServerContentRef.current = draft
    }, DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft, onDispatch])

  return (
    <div className="app-pop app-pop-wide">
      <div className="app-pop-head">
        <span className="app-pop-title">Notes</span>
        <button className="app-pop-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="app-pop-body">
        <textarea
          className="nt-area"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="A scratchpad shared with the agent — write here or ask the agent to."
          spellCheck={false}
        />
        <div className="nt-controls">
          <span className="nt-meta">{draft.length} chars</span>
          <button className="app-btn" onClick={() => { setDraft(''); onDispatch('clear') }}>clear</button>
        </div>
      </div>
    </div>
  )
}
