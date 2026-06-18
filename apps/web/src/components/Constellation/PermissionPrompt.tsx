// Allow/deny card for one pending tool-permission request. Rendered inside a
// SessionWin (per-dir terminal) and in the main-session overlay.
//
// Queue peek (Lee & See 2004, Parasuraman & Riley 1997): when several prompts
// are waiting, the "+N more" badge expands into a list so the user can see
// what's stacking up before committing to the head — trust calibration is
// load-bearing on knowing what you're agreeing to next, not just now.
import React, { useState } from 'react'
import type { PermissionRequest } from '../../hooks/useVoiceInterface.js'

type Props = {
  req: PermissionRequest
  queue?: Array<PermissionRequest>   // requests waiting BEHIND `req` (excludes head)
  onRespond: (id: string, behavior: 'allow' | 'deny') => void
}

// One-line summary of what the tool wants to do — command for Bash,
// path for file tools, else compact JSON.
function preview(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const v = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern
    if (typeof v === 'string') return v
    try { return JSON.stringify(input) } catch { return '' }
  }
  return String(input)
}

export function PermissionPrompt({ req, queue, onRespond }: Props): React.ReactElement {
  const detail = preview(req.input)
  const more = queue ?? []
  const [peek, setPeek] = useState(false)
  return (
    <div className="perm-prompt" onPointerDown={e => e.stopPropagation()}>
      <div className="perm-head">allow <b>{req.toolName}</b>?</div>
      {detail && <div className="perm-detail" title={detail}>{detail}</div>}
      <div className="perm-actions">
        <button className="perm-btn allow" onClick={() => onRespond(req.id, 'allow')}>Allow</button>
        <button className="perm-btn deny" onClick={() => onRespond(req.id, 'deny')}>Deny</button>
      </div>
      {more.length > 0 && (
        <button
          className="perm-more"
          aria-expanded={peek}
          onClick={() => setPeek(p => !p)}
        >
          {peek ? '▾' : '▸'} +{more.length} more pending
        </button>
      )}
      {peek && more.length > 0 && (
        <ul className="perm-queue">
          {more.map(r => (
            <li key={r.id} title={preview(r.input)}>
              <span className="perm-q-tool">{r.toolName}</span>
              <span className="perm-q-detail">{preview(r.input)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
