// One pinned chip at the constellation's top z-layer that shows the full name
// of whichever file diamond or directory dot the cursor is over. Decouples
// hover-text-visibility from the rest-state truncation engine (labels.ts) so
// readability never depends on the geometry around a particular ring.
//
// Architecture:
//   <LabelOverlayProvider> — context + portal slot (mounted once in the view)
//   useLabelOverlay()       — { show, hide } API exposed to hoverable items
//   <LabelOverlayChip>      — the actual chip (rendered to document.body)
//
// Items call show({ text, anchorX, anchorY, placement, color }) on pointer
// enter and hide() on leave. anchorX/anchorY are viewport coordinates from
// getBoundingClientRect, so the chip sits beside the live (bloomed) glyph,
// not its at-rest position.
import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type OverlayLabel = {
  text: string
  anchorX: number               // viewport x — typically rect.left + rect.width/2
  anchorY: number               // viewport y — rect.top for above, rect.bottom for below
  color?: string                // accent for the chip border / glyph dot
  placement?: 'above' | 'below' // which side of the anchor to grow toward
}

type OverlayApi = {
  show: (label: OverlayLabel) => void
  hide: () => void
}

const Ctx = createContext<OverlayApi>({ show: () => {}, hide: () => {} })

export function useLabelOverlay(): OverlayApi {
  return useContext(Ctx)
}

export function LabelOverlayProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [active, setActive] = useState<OverlayLabel | null>(null)

  const show = useCallback((label: OverlayLabel) => setActive(label), [])
  const hide = useCallback(() => setActive(prev => (prev ? null : prev)), [])

  // Clear on Escape — keeps a stale chip from sticking when focus jumps away
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setActive(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <Ctx.Provider value={{ show, hide }}>
      {children}
      {active && typeof document !== 'undefined' &&
        createPortal(<LabelOverlayChip label={active} />, document.body)}
    </Ctx.Provider>
  )
}

function LabelOverlayChip({ label }: { label: OverlayLabel }): React.ReactElement {
  const above = label.placement === 'above'
  const style: React.CSSProperties = {
    left: label.anchorX,
    top:  label.anchorY,
    borderColor: label.color ?? undefined,
  }
  return (
    <div
      className={`label-overlay ${above ? 'above' : 'below'}`}
      style={style}
      aria-hidden="true"
    >
      {label.color && <span className="label-overlay-dot" style={{ background: label.color }} />}
      <span className="label-overlay-text">{label.text}</span>
    </div>
  )
}
