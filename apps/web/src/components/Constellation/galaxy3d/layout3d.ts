// Pure 3D placement for open systems: root at origin, children of each system
// fanned outward from their parent — root children on a full circle, deeper
// children spread around the direction their parent grew in. Deterministic
// from tree structure (sibling order), no randomness.
import type { OpenSystem } from '../../../types/constellation.js'

export type Placement3D = { pos: [number, number, number]; tilt: number }

const GAP = 150          // clearance between parent rim and child rim
const FAN_STEP = 0.9     // rad between siblings fanned off a non-root parent
const TILTS = [0.35, -0.3, 0.5, 0.6, -0.45]

export function computeLayout3D(
  open: Array<OpenSystem>,
  rootId: string,
  rOf: (dirId: string) => number,
): Map<string, Placement3D> {
  const out = new Map<string, Placement3D>()
  if (!open.some(s => s.dirId === rootId)) return out
  out.set(rootId, { pos: [0, 0, 0], tilt: 0 })

  const outAngle = new Map<string, number>([[rootId, -Math.PI / 2]])
  const depthOf = new Map<string, number>([[rootId, 0]])
  const queue = [rootId]

  while (queue.length) {
    const pid = queue.shift()!
    const parent = out.get(pid)!
    const kids = open.filter(s => s.parentSystemId === pid)
    const depth = depthOf.get(pid)!
    const pr = rOf(pid)

    kids.forEach((k, i) => {
      const kr = rOf(k.dirId)
      const a = pid === rootId
        ? (i / kids.length) * Math.PI * 2 - Math.PI / 2
        : outAngle.get(pid)! + (i - (kids.length - 1) / 2) * FAN_STEP
      const dist = pr + kr + GAP
      const y = parent.pos[1] + (i % 2 === 0 ? 1 : -1) * (34 + depth * 14)
      out.set(k.dirId, {
        pos: [
          parent.pos[0] + Math.cos(a) * dist,
          y,
          parent.pos[2] + Math.sin(a) * dist,
        ],
        tilt: TILTS[(depth + i) % TILTS.length],
      })
      outAngle.set(k.dirId, a)
      depthOf.set(k.dirId, depth + 1)
      queue.push(k.dirId)
    })
  }
  return out
}
