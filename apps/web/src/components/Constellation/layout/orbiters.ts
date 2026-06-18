// Resting-dot slots on a ring. Slot angles are assigned over ALL child dirs so a
// dot keeps its home angle when siblings detach into their own systems.
//
// Multi-ring overflow: when the child count exceeds RING_MAX the orbiters
// split across concentric rings. The innermost ring fills first; each
// additional ring is added OUTWARD from there so a system grows visibly as
// it gains content. `outerR` (the system's rendered .r) is treated as the
// OUTERMOST ring radius so collision/stage logic stays unchanged — inner
// rings are inset from it.
import type { FsNode } from '../../../types/constellation.js'

const RING_MAX        = 10   // max orbiters per ring — chord-cap math keeps labels ≥ ~9 chars at typical r
const RING_SPACING_PX = 30   // radial gap between concentric rings (clear of label row + dot)

export type RingPlacement = { ringIndex: number; angle: number; radius: number }

export function visibleChildDirs(nodes: Map<string, FsNode>, dirId: string): Array<FsNode> {
  return (nodes.get(dirId)?.children ?? [])
    .map(id => nodes.get(id))
    .filter((n): n is FsNode => !!n && n.kind === 'dir')
}

// How many orbiters live on each ring. Index 0 is the innermost ring, the
// last entry is the outermost ring (at `outerR`).
export function ringPlan(count: number): Array<number> {
  if (count <= 0) return []
  const ringCount = Math.ceil(count / RING_MAX)
  const out: Array<number> = []
  let remaining = count
  for (let i = 0; i < ringCount; i++) {
    const here = Math.min(RING_MAX, remaining)
    out.push(here)
    remaining -= here
  }
  return out
}

// Radii of every ring in the system, inner→outer. `outerR` is the system's
// rendered radius (today's .r); inner rings step inward by RING_SPACING_PX.
export function ringRadii(count: number, outerR: number): Array<number> {
  const plan = ringPlan(count)
  return plan.map((_, i) => outerR - (plan.length - 1 - i) * RING_SPACING_PX)
}

// Per-orbiter slot — ring assignment, angular position, radius. Children are
// laid out in input order: indices 0..ringPlan[0]-1 go on the innermost ring,
// then the next ring outward, etc.
export function orbiterPlacements(count: number, outerR: number): Array<RingPlacement> {
  const plan  = ringPlan(count)
  const radii = ringRadii(count, outerR)
  const out: Array<RingPlacement> = []
  for (let r = 0; r < plan.length; r++) {
    const itemsHere = plan[r]
    for (let i = 0; i < itemsHere; i++) {
      const angle = -90 + 15 + (i / itemsHere) * 360
      out.push({ ringIndex: r, angle, radius: radii[r] })
    }
  }
  return out
}

// Evenly spaced, offset 15° from top so dots don't collide with the .spath label.
// Single-ring helper kept for callers that don't need radius info.
export function orbiterAngles(n: number): Array<number> {
  return Array.from({ length: n }, (_, i) => -90 + 15 + (i / n) * 360)
}

// Home slot for a child's resting dot on its parent ring — both angle and
// radius are needed now that a parent may host multiple concentric rings.
// `outerR` is the parent's rendered .r at the moment of the lookup.
export function restingDotHome(
  nodes: Map<string, FsNode>,
  parentId: string,
  childId: string,
  outerR: number,
): { angle: number; radius: number } | null {
  const dirs = visibleChildDirs(nodes, parentId)
  const idx  = dirs.findIndex(d => d.id === childId)
  if (idx < 0) return null
  const placements = orbiterPlacements(dirs.length, outerR)
  const p = placements[idx]
  return { angle: p.angle, radius: p.radius }
}
