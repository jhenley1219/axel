// Multiple-choice prompt: the agent asked the user to pick among N options.
// Visual sibling of PermissionPrompt — same dock placement, same chrome — but
// renders one button per option plus a cancel button.
//
// Keyboard: each option is numbered (1, 2, 3…) so the user can hit the matching
// digit key to pick. Click and keyboard both go through `onRespond`.
import React, { useEffect } from 'react'
import type { QuestionRequest } from '../../hooks/useVoiceInterface.js'

type Props = {
  req: QuestionRequest
  moreCount?: number
  onRespond: (id: string, choice: number | 'cancel') => void
}

export function QuestionPrompt({ req, moreCount = 0, onRespond }: Props): React.ReactElement {
  // Digit-key shortcut: 1–9 picks the matching option. Bound while this prompt
  // is mounted; tear down on unmount so old prompts don't intercept keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Don't steal keys from focused text inputs (the chat dock, terminal
      // prompt, file editor) — they'd lose the digit they're typing.
      const tgt = e.target as HTMLElement | null
      const tag = tgt?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onRespond(req.id, 'cancel')
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1
        if (idx < req.options.length) {
          e.preventDefault()
          onRespond(req.id, idx)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, onRespond])

  return (
    <div className="q-prompt" onPointerDown={e => e.stopPropagation()}>
      <div className="q-head">{req.question}</div>
      <ul className="q-options">
        {req.options.map((opt, i) => (
          <li key={i}>
            <button
              className="q-opt-btn"
              onClick={() => onRespond(req.id, i)}
              aria-label={`Option ${i + 1}: ${opt}`}
            >
              <span className="q-opt-num">{i + 1}</span>
              <span className="q-opt-text">{opt}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="q-actions">
        <button className="q-cancel" onClick={() => onRespond(req.id, 'cancel')}>cancel</button>
        {moreCount > 0 && <span className="q-more">+{moreCount} more pending</span>}
      </div>
    </div>
  )
}
