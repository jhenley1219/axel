// Spec §1 — degrees; screen coords (y grows downward), 0° = +x (right), 90° = down.
// 1 hangs below, 2 flank below, 3 triangle, 4 corners, 5 five-point star, 6+ even.
export function fanAngles(n: number): Array<number> {
  if (n === 1) return [90]
  if (n === 2) return [60, 120]
  if (n === 3) return [90, 210, 330]
  if (n === 4) return [45, 135, 225, 315]
  if (n === 5) return [90, 162, 234, 306, 18]
  return Array.from({ length: n }, (_, k) => 90 + k * (360 / n))
}
