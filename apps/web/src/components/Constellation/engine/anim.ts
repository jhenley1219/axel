// Spec §3 — every animatable quantity is lerp(from, to, k) with cubic ease-in-out.
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export const wrap = (x: number, total: number): number => ((x % total) + total) % total
