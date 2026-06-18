// Spec §1-§2 — re-centering rule + branch-weight drift.
// Pure: open-systems tree shape in, center-based {cx, cy, r} keyframes out.
import { fanAngles } from './fanAngles.js'
import { branchWeight, openChildrenOf } from './branchWeight.js'
import { angleBetween, polar, type Circle, type Pt } from './geo.js'

type TreeNode = { dirId: string; parentSystemId?: string }
export type Stage = { w: number; h: number; top: number; bottom: number }

export type LayoutFrame = {
  systems: Map<string, Circle>
  gc: Pt
  drift: Pt          // root offset from gc — (0,0) when branches are balanced
  scale: number
}

// Reference canvas 1200×900 (spec §1) — calibrated defaults, scaled to viewport
const REF_W = 1200
const REF_H = 900
// Spec §1.5 — ring radius from content count; sparse dirs draw tiny
const R_MIN = 13
const R_MAX = 116
const R_STEP = 6.5
const ROOT_DY = [-30, -60, -120, -30, -10, -10]
const FAN_GAP_ROOT = 120
const FAN_GAP_NEST = 64
const SIBLING_PAD  = 26
const DRIFT_GAIN   = 0.85

// Rings bloom on hover/tap (constellationStyles .olayer-scale — sticky on
// touch): the orbit layer scales 2.0× on small rings / 1.38× on large, and
// orbiter labels hang below the dots. Spacing must clear that reach, not just
// the resting rim, or an opened child sits on the parent's bloomed orbit.
export const SMALL_R = 56
const BLOOM_SM  = 2.0
const BLOOM_LG  = 1.38
const LABEL_PAD = 26

function bloomReach(r: number): number {
  return r * ((r <= SMALL_R ? BLOOM_SM : BLOOM_LG) - 1) + LABEL_PAD
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// Scale on the full viewport (the 1200×900 reference includes label margins);
// clampToStage keeps centers inside the safe area afterwards.
function stageScale(stage: Stage): number {
  return clamp(Math.min(stage.w / REF_W, stage.h / REF_H), 0.45, 1.15)
}

// count = orbiters (subdirs) + files riding the ring (spec §1.5)
export function ringRadius(count: number, s: number): number {
  return Math.round(Math.min(R_MAX, R_MIN + count * R_STEP)) * s
}

// Spec §2 — light branches shrink (~42 vs base 54), heavy inflate slightly
function weightFactor(w: number, mean: number): number {
  return clamp(Math.sqrt(w / mean), 0.75, 1.15)
}

// Children fan on a circle big enough that rings clear the parent's bloomed
// orbit AND adjacent siblings don't overlap even when one of them blooms
// (only one ring hovers at a time, so reach is a max, not a sum).
function fanDistance(parentR: number, childRs: Array<number>, n: number, s: number, nested: boolean): number {
  const maxR  = Math.max(...childRs, 0)
  const gap   = (nested ? FAN_GAP_NEST : FAN_GAP_ROOT) * s
  const bloom = Math.max(bloomReach(parentR), bloomReach(maxR))
  const base  = parentR + maxR + bloom + gap
  if (n < 2) return base
  const stepRad = ((n === 2 ? 60 : 360 / n) * Math.PI) / 180
  const chordD  = (2 * maxR + bloomReach(maxR) + SIBLING_PAD * s) / (2 * Math.sin(stepRad / 2))
  return Math.max(base, chordD)
}

type CountOf = (id: string) => number

// Spec §1.6 — every open parent applies the fan rule independently; the
// canonical fan (primary direction = 90°/down) rotates to point away from
// the grandparent so the tree keeps growing outward.
function placeFan(
  parent: TreeNode, parentC: Circle, from: Pt,
  open: Array<TreeNode>, s: number, countOf: CountOf, out: Map<string, Circle>,
): void {
  const kids = openChildrenOf(parent.dirId, open)
  if (!kids.length) return
  const outward = angleBetween(from, parentC)
  const angles  = fanAngles(kids.length).map(a => outward + a - 90)
  const childRs = kids.map(k => ringRadius(countOf(k.dirId), s))
  const dist    = fanDistance(parentC.r, childRs, kids.length, s, true)
  kids.forEach((kid, i) => {
    const p = polar(parentC.cx, parentC.cy, dist, angles[i])
    const c = { cx: p.x, cy: p.y, r: childRs[i] }
    out.set(kid.dirId, c)
    placeFan(kid, c, { x: parentC.cx, y: parentC.cy }, open, s, countOf, out)
  })
}

function placeAll(
  rootId: string, rootCenter: Pt, open: Array<TreeNode>,
  s: number, factors: Array<number>, countOf: CountOf, out: Map<string, Circle>,
): void {
  const branches = openChildrenOf(rootId, open)
  const n      = branches.length
  const rootC  = { cx: rootCenter.x, cy: rootCenter.y, r: ringRadius(countOf(rootId), s) }
  out.set(rootId, rootC)
  const angles  = fanAngles(n)
  const childRs = branches.map((b, i) => ringRadius(countOf(b.dirId), s) * (factors[i] ?? 1))
  const dist    = fanDistance(rootC.r, childRs, n, s, false)
  branches.forEach((b, i) => {
    const p = polar(rootC.cx, rootC.cy, dist * (factors[i] ?? 1), angles[i])
    const c = { cx: p.x, cy: p.y, r: childRs[i] }
    out.set(b.dirId, c)
    placeFan(b, c, rootCenter, open, s, countOf, out)
  })
}

// Spec §2 drift — weighted centroid of all open systems; root slides opposite
function driftFrom(gc: Pt, systems: Map<string, Circle>, weights: Map<string, number>, stage: Stage): Pt {
  let wx = 0, wy = 0, total = 0
  for (const [id, c] of systems) {
    const w = weights.get(id) ?? 0
    wx += c.cx * w; wy += c.cy * w; total += w
  }
  if (!total) return { x: 0, y: 0 }
  const max = 0.24 * Math.min(stage.w, stage.bottom - stage.top)
  return {
    x: clamp((gc.x - wx / total) * DRIFT_GAIN, -max, max),
    y: clamp((gc.y - wy / total) * DRIFT_GAIN, -max, max),
  }
}

// Hard no-overlap guarantee: whatever the fan heuristics decided, no two rings
// may intersect. Push offending pairs apart along their center line (the root
// stays anchored); a few relaxation rounds settle chains.
function separate(systems: Map<string, Circle>, rootId: string, s: number): void {
  const ids = [...systems.keys()]
  for (let round = 0; round < 8; round++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = systems.get(ids[i])!, b = systems.get(ids[j])!
        const min = a.r + b.r + SIBLING_PAD * s
        const dx = b.cx - a.cx, dy = b.cy - a.cy
        const d  = Math.hypot(dx, dy)
        if (d >= min) continue
        const ux = d > 0.01 ? dx / d : 0
        const uy = d > 0.01 ? dy / d : 1
        const push = min - d
        if (ids[i] === rootId)      { b.cx += ux * push;      b.cy += uy * push }
        else if (ids[j] === rootId) { a.cx -= ux * push;      a.cy -= uy * push }
        else {
          a.cx -= ux * push / 2; a.cy -= uy * push / 2
          b.cx += ux * push / 2; b.cy += uy * push / 2
        }
        moved = true
      }
    }
    if (!moved) break
  }
}

// When the tree outgrows the stage (deep chains in short viewports), per-circle
// clamping piles rings on top of each other. Instead shrink the whole layout
// uniformly about the band center so relative geometry survives.
function fitToStage(systems: Map<string, Circle>, gc: Pt, stage: Stage): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const c of systems.values()) {
    minX = Math.min(minX, c.cx - c.r - 16); maxX = Math.max(maxX, c.cx + c.r + 16)
    minY = Math.min(minY, c.cy - c.r - 8);  maxY = Math.max(maxY, c.cy + c.r + 8)
  }
  const fit = Math.min(1, stage.w / (maxX - minX), (stage.bottom - stage.top) / (maxY - minY))
  if (fit >= 1) return
  const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2
  for (const c of systems.values()) {
    c.cx = gc.x + (c.cx - bcx) * fit
    c.cy = gc.y + (c.cy - bcy) * fit
    c.r *= fit
  }
}

function clampToStage(systems: Map<string, Circle>, stage: Stage): void {
  for (const c of systems.values()) {
    c.cx = clamp(c.cx, c.r + 16, stage.w - c.r - 16)
    c.cy = clamp(c.cy, stage.top + c.r + 8, stage.bottom - c.r - 8)
  }
}

export function computeLayout(
  open: Array<TreeNode>, rootId: string, stage: Stage,
  ringCounts?: Map<string, number>,
): LayoutFrame {
  const s  = stageScale(stage)
  const gc = { x: stage.w / 2, y: stage.top + (stage.bottom - stage.top) / 2 }
  const systems = new Map<string, Circle>()
  if (!stage.w || !open.some(t => t.dirId === rootId)) {
    return { systems, gc, drift: { x: 0, y: 0 }, scale: s }
  }
  const countOf: CountOf = id => ringCounts?.get(id) ?? 0

  const branches = openChildrenOf(rootId, open)
  const n        = branches.length
  const weights  = branches.map(b => branchWeight(b.dirId, open))
  const mean     = weights.length ? weights.reduce((a, w) => a + w, 0) / weights.length : 1
  const factors  = weights.map(w => weightFactor(w, mean))
  const baseY    = gc.y + (n <= 5 ? ROOT_DY[n] : ROOT_DY[5]) * s

  // Pass 1: balanced placement → centroid → drift. Pass 2: re-place around drifted root.
  placeAll(rootId, { x: gc.x, y: baseY }, open, s, factors, countOf, systems)

  let drift = { x: 0, y: 0 }
  const unbalanced = weights.length > 1 && Math.max(...weights) !== Math.min(...weights)
  if (unbalanced) {
    const sysWeights = new Map<string, number>()
    for (const t of open) {
      if (t.dirId !== rootId) sysWeights.set(t.dirId, branchWeight(t.dirId, open))
    }
    drift = driftFrom(gc, systems, sysWeights, stage)
    systems.clear()
    placeAll(rootId, { x: gc.x + drift.x, y: baseY + drift.y }, open, s, factors, countOf, systems)
  }

  separate(systems, rootId, s)

  // Spec §1 n=1 — the lone branch hangs straight down, so a fixed root nudge
  // leaves the column bottom-heavy (child crowds the orb). Center the whole
  // occupied column in the stage band instead.
  if (n === 1) {
    let top = Infinity, bot = -Infinity
    for (const c of systems.values()) {
      top = Math.min(top, c.cy - c.r)
      bot = Math.max(bot, c.cy + c.r)
    }
    const dy = gc.y - (top + bot) / 2
    for (const c of systems.values()) c.cy += dy
  }

  fitToStage(systems, gc, stage)
  clampToStage(systems, stage)
  return { systems, gc, drift, scale: s }
}
