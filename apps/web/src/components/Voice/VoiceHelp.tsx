// "Things you can say" reference card. Voice intents are otherwise invisible
// affordances (Norman): the orb tap is the only signifier of voice, and the
// rest — permission allow/deny, transcript reading, length choice — is hidden
// in the recognition layer. This card surfaces them so users can discover the
// vocabulary without having to read source.
import React from 'react'

type Props = { open: boolean; onClose: () => void }

const SECTIONS: Array<{ title: string; rows: Array<{ say: string; does: string }> }> = [
  {
    title: 'Talk to Axle',
    rows: [
      { say: 'tap the orb', does: 'start listening' },
      { say: 'tap the orb while speaking', does: 'interrupt (or just talk over me)' },
    ],
  },
  {
    title: 'Tool permissions',
    rows: [
      { say: '"yes" / "yeah" / "ok" / "allow"', does: 'approve the request' },
      { say: '"no" / "nope" / "deny" / "cancel"', does: 'reject the request' },
    ],
  },
  {
    title: 'Background terminals',
    rows: [
      { say: '"read the transcript"', does: 'hear the latest finished terminal' },
      { say: '"read the transcripts"', does: 'hear short summaries of every finished terminal' },
      { say: '"what did it say"', does: 'same as "read the transcript"' },
    ],
  },
  {
    title: 'When Axle asks back',
    rows: [
      { say: '"full" / "short"', does: 'pick transcript length' },
      { say: 'a directory name', does: 'pick which transcript to read' },
      { say: '"cancel" / "never mind"', does: 'drop the pending question' },
    ],
  },
]

export function VoiceHelp({ open, onClose }: Props): React.ReactElement | null {
  if (!open) return null
  return (
    <div className="vhelp-scrim" onClick={onClose}>
      <aside className="vhelp" onClick={e => e.stopPropagation()}>
        <header className="vhelp-head">
          <span className="vhelp-title">Things you can say</span>
          <button className="vhelp-x" aria-label="Close help" onClick={onClose}>×</button>
        </header>
        <div className="vhelp-body">
          {SECTIONS.map(sec => (
            <section key={sec.title} className="vhelp-sec">
              <h4>{sec.title}</h4>
              <dl>
                {sec.rows.map((r, i) => (
                  <React.Fragment key={i}>
                    <dt>{r.say}</dt>
                    <dd>{r.does}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}
