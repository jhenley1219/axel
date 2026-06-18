// One star system: a dotted ring whose un-opened subdirs ride ON the rim as
// colored dots (spec §0). Renders as a blend (spec §3): the resting "seed" dot
// fades out as open-ness `o` rises while the ring fades in — so the engine's
// {cx, cy, r, o} tween reads as a ball detaching, traveling, and inflating.
//
// Files no longer ride orbital bands inside the ring — they live in a
// FilePicker dropdown opened by a left-click on the rim. The interior is empty
// space; only the seed dot and the rim survive there.
import React from 'react'
import { polar } from './layout/geo.js'
import { SMALL_R } from './layout/computeLayout.js'
import { useLabelOverlay, type OverlayLabel } from './LabelOverlay.js'
import type { Band } from './fileStars.js'
import type { CloudParticle2D } from './cloud.js'

// `display` is the post-truncation label text — computed upstream by the
// anti-collision pass so the same name renders the same width everywhere.
// `r` is the orbiter's distance from the system center; defaults to the
// system's own radius when omitted so single-ring callers stay unchanged.
export type Orbiter  = { n: string; c: string; a: number; r?: number; display?: string }

// Record of a file's render position + identity. The 2D constellation no
// longer renders these as on-rim diamonds (files moved into FilePicker); the
// shape survives because the 3D galaxy view still uses it to place file dots
// inside its rings, and ConstellationView's openFiles bookkeeping records
// band/a alongside name/path.
export type FileStar = {
  n: string; path: string; a: number; rr: number; band: Band
  tracked: boolean; labelAbove?: boolean; display?: string
}

type Props = {
  x: number
  y: number
  r: number
  o: number          // open-ness 0→1 — 0 = resting dot, 1 = full ring
  v: number          // visibility — product of ancestor open-ness
  dotColor: string   // seed-dot color while traveling (dominant file type)
  path: string
  sub?: string
  labelTop?: boolean
  hideLabel?: boolean
  orbiters?: Array<Orbiter>
  // Additional inner-ring radii (inner→outer, excluding the outermost ring
  // which is `r` itself). Drives extra dashed .rim circles inside the system
  // when orbiter count overflows a single ring.
  innerRingRadii?: Array<number>
  cloud?: Array<CloudParticle2D>
  cloudTint?: string   // CSS color for the ribbon body's radial-gradient annulus
  // Sub-agent queue indicator: a small pulsing badge near the rim when this
  // dir has pending requests waiting for the user. Color matches the dir's
  // file-cloud tint so the user can tell at a glance which sender it is.
  queuePending?: number
  queueColor?: string
  onOrbiterClick?: (name: string, ev: React.MouseEvent | React.KeyboardEvent) => void
  onOrbiterContext?: (name: string, ev: React.MouseEvent) => void
  onFocus?: (ev?: React.MouseEvent) => void
  onRingContext?: (ev: React.MouseEvent) => void
  onClose?: () => void
  children?: React.ReactNode
}

export function StarSystem({
  x, y, r, o, v, dotColor,
  path, sub, labelTop = false, hideLabel = false,
  orbiters = [], innerRingRadii = [], cloud = [], cloudTint,
  queuePending = 0, queueColor,
  onOrbiterClick, onOrbiterContext, onFocus, onRingContext, onClose, children,
}: Props): React.ReactElement {
  const D = r * 2
  const cls = ['syst', r <= SMALL_R ? 'syst-sm' : ''].filter(Boolean).join(' ')
  const ringOpacity = v * o
  const dotOpacity  = v * (1 - o * 0.9)

  // Portal-mounted hover chip — guaranteed top-of-stack visibility regardless
  // of ring geometry, band crowding, or which sibling system is rendered on top.
  const overlay = useLabelOverlay()
  const showLabel = (el: HTMLElement, text: string, color: string, above: boolean): void => {
    const rect = el.getBoundingClientRect()
    const anchorY = above ? rect.top : rect.bottom
    const payload: OverlayLabel = {
      text,
      anchorX: rect.left + rect.width / 2,
      anchorY,
      color,
      placement: above ? 'above' : 'below',
    }
    overlay.show(payload)
  }

  return (
    <div className={cls} style={{ left: x, top: y, width: D, height: D }}>
      {/* Transparent catcher that extends the hover zone past the rim so the
          bloom doesn't oscillate when a dot moves outward from under the cursor */}
      <div className="hover-pad" aria-hidden="true" />
      <div className="sys-body" style={{ opacity: ringOpacity }}>
        {/* Ribbon body — a translucent annulus, tinted by the dir's dominant
            file type, that visually outlines the click target. Sits BEHIND
            the rim so the dashed rim still reads clearly on top of it. */}
        {cloudTint && (
          <div
            className="cloud-ring"
            aria-hidden="true"
            style={{ ['--cloud-tint' as string]: cloudTint }}
          />
        )}
        <div
          className="rim"
          onClick={onFocus}
          onContextMenu={onRingContext ? ev => { ev.preventDefault(); ev.stopPropagation(); onRingContext(ev) } : undefined}
        />

        {/* Additional dashed rings for multi-ring systems. Sized in pixels and
            centered in the system box so they sit concentric inside the outer
            rim. Same click-to-focus / right-click handlers as the outer rim. */}
        {innerRingRadii.map((rr, i) => (
          <div
            key={`rim-${i}`}
            className="rim rim-inner"
            style={{ inset: 'auto', left: r - rr, top: r - rr, width: rr * 2, height: rr * 2 }}
            onClick={onFocus}
            onContextMenu={onRingContext ? ev => { ev.preventDefault(); ev.stopPropagation(); onRingContext(ev) } : undefined}
          />
        ))}

        {/* Probability-cloud particles — scattered inside the ribbon,
            color-weighted by the dir's file-type distribution. Inert
            (pointer-events: none) so the rim still catches clicks. */}
        {cloud.length > 0 && (
          <div className="cloud-layer" aria-hidden="true">
            {cloud.map((p, i) => (
              <i key={i} className="cloud-p" style={{
                left: r + p.x, top: r + p.y,
                width: p.s, height: p.s,
                background: p.c, opacity: p.op,
                boxShadow: `0 0 ${Math.max(2, p.s * 2)}px ${p.c}`,
              }} />
            ))}
          </div>
        )}

        {/* Orbiting dots ON the rim — .olayer spins via the engine's --orbit-rot;
            .olayer-scale expands the orbit on hover */}
        {orbiters.length > 0 && (
          <div className="olayer-scale">
            <div className="olayer">
              {orbiters.map(orb => {
                const p = polar(r, r, orb.r ?? r, orb.a)
                return (
                  <div
                    key={orb.n}
                    className="orbiter"
                    style={{ left: p.x, top: p.y }}
                    onClick={ev => onOrbiterClick?.(orb.n, ev)}
                    onContextMenu={onOrbiterContext ? ev => { ev.preventDefault(); ev.stopPropagation(); onOrbiterContext(orb.n, ev) } : undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${orb.n}`}
                    onKeyDown={ev => { if (ev.key === 'Enter') onOrbiterClick?.(orb.n, ev) }}
                    onPointerEnter={ev => showLabel(ev.currentTarget, orb.n, orb.c, false)}
                    onPointerLeave={overlay.hide}
                    onFocus={ev => showLabel(ev.currentTarget, orb.n, orb.c, false)}
                    onBlur={overlay.hide}
                  >
                    {/* .ctr counter-rotates so the label stays upright */}
                    <div className="ctr" title={orb.n}>
                      <i style={{ background: orb.c, boxShadow: `0 0 10px ${orb.c}` }} />
                      <span className="t">{orb.display ?? orb.n}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!hideLabel && (
          <div className="spath" style={{ left: r, top: labelTop ? -34 : D + 12 }}>
            <div className="p">{path}</div>
            {sub && <div className="s">{sub}</div>}
          </div>
        )}
      </div>

      {/* The resting/traveling seed dot — visible while o is low (spec §3) */}
      <div
        className="sys-seed"
        style={{ left: r, top: r, opacity: dotOpacity, background: dotColor, boxShadow: `0 0 10px ${dotColor}` }}
      />

      {onClose && (
        <button
          className="syst-close"
          style={{ left: D, top: 0 }}
          onClick={e => { e.stopPropagation(); onClose() }}
          aria-label={`Close ${path}`}
        >×</button>
      )}

      {queuePending > 0 && (
        <div
          className="syst-queue-badge"
          style={{
            left: D, top: D,
            background: queueColor ?? '#ffd166',
            boxShadow: `0 0 10px ${queueColor ?? '#ffd166'}`,
            color: '#0a0e1a',
          }}
          aria-label={`${queuePending} pending request${queuePending === 1 ? '' : 's'} from ${path}`}
          title={`${queuePending} pending request${queuePending === 1 ? '' : 's'}`}
        >
          {queuePending}
        </div>
      )}

      {/* Orb placed at ring center (r, r) by the parent */}
      {children}
    </div>
  )
}
