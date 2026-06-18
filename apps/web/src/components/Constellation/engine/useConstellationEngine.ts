// Spec §3 — single rAF clock (wrapped, localStorage-persisted, clamped dt) that
// lerps every node property {cx, cy, r, o} between keyframes, spins the orbiter
// layers via one CSS variable, and commutes the AI orb along the active path.
import { useEffect, useMemo, useRef, useState } from 'react'
import { computeLayout, type LayoutFrame, type Stage } from '../layout/computeLayout.js'
import { polar, type Circle, type Pt } from '../layout/geo.js'
import { ease, lerp, wrap } from './anim.js'
import type { OpenSystem, OrbTarget } from '../../../types/constellation.js'

// Spec §3 — o: open-ness 0→1 (dot ↔ ring); v: ancestor visibility product
export type AnimState = Circle & { o: number; v: number }

type NodeKeys = Circle & { o: number }
type Tween    = { from: NodeKeys; cur: NodeKeys; to: NodeKeys; k: number; closing?: boolean }

const TRANS       = 1.3    // s per transition — spec §3.5
const ORB_TRAVEL  = 0.7    // s for an orb commute
const ROT_PERIOD  = 200    // s per orbiter revolution (slow enough that a hovered dot stays clickable)
const CLOCK_TOTAL = 86400  // wrap daily — a multiple of ROT_PERIOD keeps rotation seamless
const DT_CLAMP_MS = 80     // spec §3.5 — backgrounded tab doesn't jump
const CLOCK_KEY   = 'axle-constellation-clock'
const ROT_KEY     = 'axle-constellation-rot'
const DOT_R = 6            // resting-dot radius — spec §3.1

function loadClock(): number {
  const raw = Number(localStorage.getItem(CLOCK_KEY))
  return Number.isFinite(raw) ? wrap(raw, CLOCK_TOTAL) : 0
}

// Rotation phase 0→1 lives separately from the wall clock so we can FREEZE it
// while the user is hovering a ring without snapping when we resume.
function loadRotPhase(): number {
  const raw = Number(localStorage.getItem(ROT_KEY))
  return Number.isFinite(raw) ? ((raw % 1) + 1) % 1 : 0
}

function lerpNode(a: NodeKeys, b: NodeKeys, k: number): NodeKeys {
  return {
    cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k),
    r:  lerp(a.r,  b.r,  k), o:  lerp(a.o,  b.o,  k),
  }
}

function nearlyEqual(a: NodeKeys, b: NodeKeys): boolean {
  return Math.abs(a.cx - b.cx) < .5 && Math.abs(a.cy - b.cy) < .5
    && Math.abs(a.r - b.r) < .5 && Math.abs(a.o - b.o) < .01
}

type EngineOpts = {
  stage: Stage
  open: Array<OpenSystem>
  rootId: string
  orbTarget: OrbTarget
  // Per-system content count (subdirs + files) — rings size from it (spec §1.5)
  ringCounts: Map<string, number>
  // Home slot for a child's resting dot — angle (no rotation applied) AND
  // radius, since a parent may host multiple concentric rings. The lookup
  // takes the parent's current rendered radius so inner-ring slots resolve
  // to the right distance from center.
  dotHomeOf: (parentId: string, childId: string, parentR: number) => { angle: number; radius: number } | null
  // Exact screen point an open should grow from (captured on user click)
  enterFromOf: (dirId: string) => Pt | undefined
  onCloseDone: (dirId: string) => void
  onOrbArrive: (target: OrbTarget) => void
}

export function useConstellationEngine(opts: EngineOpts): {
  rendered: Map<string, AnimState>
  frame: LayoutFrame
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  orbHostRef: React.MutableRefObject<HTMLDivElement | null>
} {
  const { stage, open, rootId, orbTarget, ringCounts } = opts
  const [rendered, setRendered] = useState<Map<string, AnimState>>(new Map())

  const containerRef = useRef<HTMLDivElement | null>(null)
  const orbHostRef   = useRef<HTMLDivElement | null>(null)
  const tweensRef    = useRef<Map<string, Tween>>(new Map())
  const parentRef    = useRef<Map<string, string | undefined>>(new Map())
  const rotRef       = useRef(0)
  const rotPhaseRef  = useRef(loadRotPhase())
  const dirtyRef     = useRef(true)
  const orbRef       = useRef<{ from: Pt; cur: Pt; k: number; arrived: boolean } | null>(null)
  const optsRef      = useRef(opts)
  optsRef.current = opts

  const reduced = useMemo(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const frame = useMemo(
    () => computeLayout(open.filter(s => !s.closing), rootId, stage, ringCounts),
    [open, rootId, stage, ringCounts],
  )

  const frameRef = useRef(frame)
  frameRef.current = frame

  // Where a system's resting dot sits on its parent ring RIGHT NOW (rotation included).
  // Multi-ring: home radius comes from the child's placement, not parent.r — inner-ring
  // dots return to their inner-ring slot, not the outermost rim.
  const dotPointOf = (dirId: string): Pt | null => {
    const parentId = parentRef.current.get(dirId)
    if (!parentId) return null
    const parent = tweensRef.current.get(parentId)?.cur ?? frameRef.current.systems.get(parentId)
    if (!parent) return null
    const home  = optsRef.current.dotHomeOf(parentId, dirId, parent.r)
    if (!home) return null
    return polar(parent.cx, parent.cy, home.radius, home.angle + rotRef.current)
  }

  // ── Diff target keyframes into tweens whenever the layout or tree changes ──
  useEffect(() => {
    parentRef.current = new Map(open.map(s => [s.dirId, s.parentSystemId]))
    const tweens = tweensRef.current

    for (const [id, circle] of frame.systems) {
      const to = { ...circle, o: 1 }
      const tw = tweens.get(id)
      if (tw) {
        if (!nearlyEqual(tw.to, to)) {
          tweens.set(id, { from: tw.cur, cur: tw.cur, to, k: 0 })
        }
        continue
      }
      // Spec §3.1 — origin = the clicked/targeted resting dot on the parent rim
      const pt   = optsRef.current.enterFromOf(id) ?? dotPointOf(id)
      const from = pt
        ? { cx: pt.x, cy: pt.y, r: DOT_R, o: 0 }
        : { cx: circle.cx, cy: circle.cy, r: DOT_R, o: 0 }
      tweens.set(id, { from, cur: from, to, k: 0 })
    }

    // Spec §3.1 close — the same transition played backward, home to the rim dot
    for (const sys of open) {
      const tw = sys.closing ? tweens.get(sys.dirId) : undefined
      if (!tw || tw.closing) continue
      const pt = dotPointOf(sys.dirId)
      const to = pt
        ? { cx: pt.x, cy: pt.y, r: DOT_R, o: 0 }
        : { ...tw.cur, r: DOT_R, o: 0 }
      tweens.set(sys.dirId, { from: tw.cur, cur: tw.cur, to, k: 0, closing: true })
    }

    const live = new Set(open.map(s => s.dirId))
    for (const id of tweens.keys()) {
      if (!frame.systems.has(id) && !live.has(id)) tweens.delete(id)
    }
    dirtyRef.current = true
  }, [frame, open])

  // ── Orb retarget — new target = new commute from the current position ──────
  useEffect(() => {
    const from = orbRef.current?.cur ?? { x: frame.gc.x, y: frame.gc.y }
    orbRef.current = { from, cur: from, k: 0, arrived: false }
    dirtyRef.current = true
  }, [orbTarget])  // eslint-disable-line react-hooks/exhaustive-deps

  const orbTargetPoint = (): Pt => {
    const t   = optsRef.current.orbTarget
    const sys = (id: string): Pt => {
      const c = tweensRef.current.get(id)?.cur ?? frameRef.current.systems.get(id)
      return c ? { x: c.cx, y: c.cy } : frameRef.current.gc
    }
    if (t.type === 'system') return sys(t.systemId)
    if (t.type === 'dot')    return dotPointOf(t.dirId) ?? sys(t.systemId)
    return sys(optsRef.current.rootId)
  }
  const orbTargetPointRef = useRef(orbTargetPoint)
  orbTargetPointRef.current = orbTargetPoint

  // ── The single rAF loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const clock = { t: loadClock(), last: 0, lastSave: 0 }
    let raf = 0

    const step = (now: number): void => {
      raf = requestAnimationFrame(step)
      const dt = Math.min(now - (clock.last || now), DT_CLAMP_MS) / 1000
      clock.last = now
      clock.t = wrap(clock.t + dt, CLOCK_TOTAL)
      if (now - clock.lastSave > 1000) {
        clock.lastSave = now
        try {
          localStorage.setItem(CLOCK_KEY, String(clock.t))
          localStorage.setItem(ROT_KEY, String(rotPhaseRef.current))
        } catch { /* private mode */ }
      }

      // Orbiter rotation — one CSS variable spins every ring's dot layer in sync.
      // We freeze the phase while ANY ring is hovered so a spinning dot can't
      // glide out from under the cursor and collapse the bloom mid-click.
      if (!reduced) {
        const hovered = !!containerRef.current?.querySelector('.syst:hover')
        if (!hovered) rotPhaseRef.current = (rotPhaseRef.current + dt / ROT_PERIOD) % 1
        rotRef.current = rotPhaseRef.current * 360
        containerRef.current?.style.setProperty('--orbit-rot', `${rotRef.current}deg`)
      }

      // Advance tweens — reduced motion snaps straight to the settled keyframe
      const dk = reduced ? 1 : dt / TRANS
      let animating = false
      const finishedClosings: Array<string> = []
      for (const [id, tw] of tweensRef.current) {
        if (tw.k < 1) {
          tw.k = Math.min(tw.k + dk, 1)
          tw.cur = lerpNode(tw.from, tw.to, ease(tw.k))
          animating = true
          if (tw.k >= 1 && tw.closing) finishedClosings.push(id)
        }
      }

      // Orb commute — same lerp engine; `to` tracks systems while they re-arrange
      const orb = orbRef.current
      if (orb) {
        const to = orbTargetPointRef.current()
        if (orb.k < 1) {
          orb.k = Math.min(orb.k + (reduced ? 1 : dt / ORB_TRAVEL), 1)
          animating = true
        }
        const k = ease(orb.k)
        orb.cur = { x: lerp(orb.from.x, to.x, k), y: lerp(orb.from.y, to.y, k) }
        const el = orbHostRef.current
        if (el) { el.style.left = `${orb.cur.x}px`; el.style.top = `${orb.cur.y}px` }
        if (orb.k >= 1 && !orb.arrived) {
          orb.arrived = true
          optsRef.current.onOrbArrive(optsRef.current.orbTarget)
        }
      }

      if (animating || dirtyRef.current) {
        dirtyRef.current = false
        const out = new Map<string, AnimState>()
        const vOf = (id: string): number => {
          const parentId = parentRef.current.get(id)
          if (!parentId) return 1
          const p = tweensRef.current.get(parentId)
          return p ? p.cur.o * vOf(parentId) : 1
        }
        for (const [id, tw] of tweensRef.current) out.set(id, { ...tw.cur, v: vOf(id) })
        setRendered(out)
      }

      for (const id of finishedClosings) {
        tweensRef.current.delete(id)
        optsRef.current.onCloseDone(id)
      }
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [reduced])  // eslint-disable-line react-hooks/exhaustive-deps

  return { rendered, frame, containerRef, orbHostRef }
}
