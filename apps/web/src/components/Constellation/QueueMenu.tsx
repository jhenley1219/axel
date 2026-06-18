// Pending-attention queue surface. Two streams converge here:
//   1. unreadTranscripts — background terminals that finished but haven't
//      been read aloud to the user yet. Same data the voice "read the
//      transcript" intent drains; clicking an entry reads it out loud.
//   2. queueItems — sub-agent → root requests (proposal/question/confirmation)
//      that came in while the root agent was busy. Visible-but-passive: the
//      root agent claims and resolves them on its own; the menu just lets the
//      user SEE what's queued so the system isn't a black box.
// Discoverability fix: previously this state was only reachable via the voice
// catchphrase "read the transcript" and a count badge on each star — users
// couldn't tell the queue existed unless they remembered the magic words.
import React from 'react'

type UnreadTranscript = { target: string; term: string; key: string }

type QueueItem = {
  id: string
  fromTarget: string
  fromTerm?: string
  kind: 'proposal' | 'question' | 'confirmation'
  prompt: string
  options?: Array<string>
  claimed: boolean
}

type Props = {
  open: boolean
  onClose: () => void
  unreadTranscripts: Array<UnreadTranscript>
  queueItems: Array<QueueItem>
  onReadTranscript: (entry: UnreadTranscript) => void
}

// "rta-blueprint-api" → "rta blueprint api" for readability (also what TTS
// uses, so the menu label matches the voice when both fire).
function pretty(target: string): string {
  return target.replace(/[-_]/g, ' ')
}

export function QueueMenu({
  open, onClose, unreadTranscripts, queueItems, onReadTranscript,
}: Props): React.ReactElement | null {
  if (!open) return null
  const empty = unreadTranscripts.length === 0 && queueItems.length === 0
  return (
    <div className="vhelp-scrim" onClick={onClose}>
      <aside className="vhelp axq" onClick={e => e.stopPropagation()}>
        <header className="vhelp-head">
          <span className="vhelp-title">Queue</span>
          <button className="vhelp-x" aria-label="Close queue" onClick={onClose}>×</button>
        </header>
        <div className="vhelp-body">
          {empty && (
            <p className="axq-empty">Nothing waiting. Background terminals will show up here when they finish.</p>
          )}

          {unreadTranscripts.length > 0 && (
            <section className="vhelp-sec">
              <h4>Unread transcripts ({unreadTranscripts.length})</h4>
              <ul className="axq-list">
                {unreadTranscripts.map(entry => (
                  <li key={entry.key}>
                    <button
                      className="axq-item axq-trans"
                      onClick={() => { onReadTranscript(entry); onClose() }}
                      title="Read this transcript aloud"
                    >
                      <span className="axq-name">{pretty(entry.target)}</span>
                      {entry.term !== 'main' && <span className="axq-tag">{entry.term.slice(0, 6)}</span>}
                      <span className="axq-cta">read ▸</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {queueItems.length > 0 && (
            <section className="vhelp-sec">
              <h4>Sub-agent requests ({queueItems.length})</h4>
              <ul className="axq-list">
                {queueItems.map(item => (
                  <li key={item.id}>
                    <div className={`axq-item axq-req${item.claimed ? ' on' : ''}`}>
                      <div className="axq-row">
                        <span className="axq-kind">{item.kind}</span>
                        <span className="axq-name">{pretty(item.fromTarget)}</span>
                        {item.claimed && <span className="axq-cta">in progress…</span>}
                      </div>
                      <p className="axq-prompt">{item.prompt}</p>
                      {item.options && item.options.length > 0 && (
                        <ul className="axq-opts">
                          {item.options.map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}
