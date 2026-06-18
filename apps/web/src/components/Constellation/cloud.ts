// Probability-cloud particle layout for a directory's ring interior.
//
// When the file diamonds moved into the FilePicker dropdown, the ring's
// interior went empty. To keep the ring feeling alive (and to encode at a
// glance what kind of files live inside without naming them), we fill it with
// a soft scatter of particles — a 2D annulus or a 3D ribbon-torus, dense at a
// "band radius" and falling off with a Gaussian. Color is sampled from the
// dir's file-type histogram, so a code-heavy dir glows lime and a config-heavy
// dir glows orange. Empty dirs get a faint cream atmosphere so even an empty
// ring isn't dead-looking.
//
// All positions and colors come from a SEEDED PRNG (mulberry32, seeded off
// node.id) so the same dir always renders the same scatter pattern — no
// per-frame jitter. Particle count scales with file count but is clamped.
import { FILE_TYPE_COLORS, extToFileType, type FsNode } from '../../types/constellation.js'

export type CloudParticle2D = {
  x: number   // offset from ring center, px
  y: number   // offset from ring center, px
  c: string   // CSS color
  op: number  // alpha 0..1
  s: number   // diameter px
}

export type CloudParticle3D = {
  x: number
  y: number
  z: number
  color: number  // 0xRRGGBB
  size: number
}

const CLOUD_FLOOR  = 8
const CLOUD_2D_CEIL = 60
const CLOUD_3D_CEIL = 140

// Particles cluster around this fraction of the ring radius. The annulus
// occupies roughly [BAND - 2·SIGMA, BAND + 2·SIGMA] in the radial dimension.
const BAND_FRAC = 0.55
const SIGMA_FRAC = 0.18
const RADIAL_MIN = 0.18
const RADIAL_MAX = 0.88

// 3D torus cross-section: how thick the ribbon is, as a fraction of ring r.
const CROSS_SIGMA_FRAC = 0.12

// Faint default when the dir has no files yet.
const AMBIENT_COLOR = 'rgba(243,238,226,.55)'
const AMBIENT_HEX   = 0xf3eee2
const AMBIENT_TINT  = '#f3eee2'

// ── mulberry32, seeded by xmur3 over a string ─────────────────────────────
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// Box-Muller, returns N(0,1)
function gaussian(rand: () => number): number {
  let u = 0, v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function rngFor(seedKey: string): () => number {
  const h = xmur3(seedKey)
  return mulberry32(h())
}

// Build a weighted color palette from the dir's actual files. Each file
// contributes one entry of its type's color; sampling uniformly from this
// list then naturally biases toward whichever type dominates.
function buildPalette(node: FsNode): Array<string> {
  const files = node.files ?? []
  if (files.length === 0) return [AMBIENT_COLOR]
  const out: Array<string> = []
  for (const f of files) {
    const ft = extToFileType(f.name.split('.').pop() ?? '')
    out.push(FILE_TYPE_COLORS[ft])
  }
  return out
}

function buildPaletteHex(node: FsNode): Array<number> {
  const palette = buildPalette(node)
  return palette.map(c => {
    if (c.startsWith('#')) return parseInt(c.slice(1), 16)
    return AMBIENT_HEX
  })
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// Dominant tint for the ring's atmospheric body — the file type that occurs
// most in this dir. The ribbon (2D radial gradient + 3D translucent torus)
// uses this color so a config-heavy dir glows orange, code-heavy lime, etc.
// Empty dirs fall back to a soft cream — visible but unassuming.
export function cloudTint(node: FsNode): string {
  const files = node.files ?? []
  if (files.length === 0) return AMBIENT_TINT
  const counts: Partial<Record<string, number>> = {}
  for (const f of files) {
    const ft = extToFileType(f.name.split('.').pop() ?? '')
    counts[ft] = (counts[ft] ?? 0) + 1
  }
  let best = '' as keyof typeof FILE_TYPE_COLORS | ''
  let bestN = -1
  for (const [k, n] of Object.entries(counts)) {
    if ((n ?? 0) > bestN) { bestN = n ?? 0; best = k as keyof typeof FILE_TYPE_COLORS }
  }
  return best ? FILE_TYPE_COLORS[best] : AMBIENT_TINT
}

export function cloudTintHex(node: FsNode): number {
  const c = cloudTint(node)
  if (c.startsWith('#')) return parseInt(c.slice(1), 16)
  return AMBIENT_HEX
}

function cloudCount(fileCount: number, ceil: number): number {
  // Empty dirs still get the floor so the ring has *some* atmosphere; busy
  // dirs saturate at the ceiling so a 500-file dir doesn't drag the GPU.
  return clamp(Math.round(CLOUD_FLOOR + fileCount * 1.5), CLOUD_FLOOR, ceil)
}

// ── 2D: flat annulus inside the ring ──────────────────────────────────────
export function buildCloud2D(node: FsNode, r: number): Array<CloudParticle2D> {
  if (r <= 0) return []
  const rand    = rngFor(`2d:${node.id}`)
  const palette = buildPalette(node)
  const n       = cloudCount(node.files?.length ?? 0, CLOUD_2D_CEIL)
  const out: Array<CloudParticle2D> = []
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2
    // Gaussian around the band radius, clamped so particles stay inside the
    // ring interior (never on the rim, never on the central seed).
    const radial = clamp(BAND_FRAC + gaussian(rand) * SIGMA_FRAC, RADIAL_MIN, RADIAL_MAX) * r
    const x = Math.cos(ang) * radial
    const y = Math.sin(ang) * radial
    const c = palette[Math.floor(rand() * palette.length)]
    // Opacity peaks at the band center and tapers toward the edges, so the
    // ring reads as a soft glow rather than a flat dot field.
    const distFromBand = Math.abs(radial / r - BAND_FRAC) / SIGMA_FRAC
    const op = clamp(0.55 - distFromBand * 0.18, 0.12, 0.7)
    const s  = 1.4 + rand() * 1.6
    out.push({ x, y, c, op, s })
  }
  return out
}

// ── 3D: ribbon torus around the ring circumference ────────────────────────
// The ring lies in the xz-plane (y = 0) in the 3D scene; particles ride that
// plane with a Gaussian cross-sectional spread that gives the torus its
// "ribbon" feel — thin vertically, slightly fuzzy radially.
export function buildCloud3D(node: FsNode, r: number): Array<CloudParticle3D> {
  if (r <= 0) return []
  const rand    = rngFor(`3d:${node.id}`)
  const palette = buildPaletteHex(node)
  const n       = cloudCount(node.files?.length ?? 0, CLOUD_3D_CEIL)
  const out: Array<CloudParticle3D> = []
  for (let i = 0; i < n; i++) {
    const ang  = rand() * Math.PI * 2
    const drR  = gaussian(rand) * CROSS_SIGMA_FRAC * r
    const dyR  = gaussian(rand) * CROSS_SIGMA_FRAC * 0.6 * r  // thinner vertically
    const baseR = BAND_FRAC * r + drR
    const x = Math.cos(ang) * baseR
    const z = Math.sin(ang) * baseR
    const y = dyR
    const color = palette[Math.floor(rand() * palette.length)]
    const size  = 2.2 + rand() * 1.4
    out.push({ x, y, z, color, size })
  }
  return out
}
