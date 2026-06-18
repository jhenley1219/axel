// Spec §0 — every node is stored by its CENTER {cx, cy} and radius r.
export type Circle = { cx: number; cy: number; r: number }
export type Pt     = { x: number; y: number }

export function polar(cx: number, cy: number, r: number, deg: number): Pt {
  const a = (deg * Math.PI) / 180
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
}

// Spec §0 — tethers connect rim-to-rim, never center-to-center
export function tetherEnds(a: Circle, b: Circle): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.cx - a.cx, dy = b.cy - a.cy
  const d  = Math.hypot(dx, dy) || 1
  const ux = dx / d, uy = dy / d
  return {
    x1: a.cx + ux * a.r, y1: a.cy + uy * a.r,
    x2: b.cx - ux * b.r, y2: b.cy - uy * b.r,
  }
}

export function angleBetween(a: Pt | Circle, b: Pt | Circle): number {
  const ax = 'cx' in a ? a.cx : a.x, ay = 'cy' in a ? a.cy : a.y
  const bx = 'cx' in b ? b.cx : b.x, by = 'cy' in b ? b.cy : b.y
  return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
}
