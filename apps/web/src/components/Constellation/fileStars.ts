// Spec §3.6 — files ride orbital bands INSIDE their directory's ring, banded by
// type: code inner, config mid, docs outer (ratios from the r=172 reference).
import type { FileStar } from './StarSystem.js'
import { FILE_TYPE_COLORS, extToFileType, type FileType, type FsNode } from '../../types/constellation.js'
import { labelCapacity, uniqueLabels } from './layout/labels.js'

export type Band = 'code' | 'config' | 'docs'

// Each band is a LANE — a radial range [minR, maxR] (as fractions of the ring
// radius) that its file diamonds occupy AND that their labels are forbidden to
// bleed past. Labels at the band centerline can extend horizontally at most
// 2 × min(centerR − minR, maxR − centerR) × ringR before they'd cross into the
// neighbouring lane (or the directory rim).
//
//   0 ─── orb ─── [code  lane] ─── [config lane] ─── [docs lane] ─── rim ─── 1.0
//                  0.10–0.44       0.45–0.66          0.67–0.89    (orbiters @ 1.0)
export type BandLane = { centerR: number; minR: number; maxR: number }
export const BAND_LANE: Record<Band, BandLane> = {
  code:   { centerR: 0.32, minR: 0.10, maxR: 0.44 },
  config: { centerR: 0.56, minR: 0.45, maxR: 0.66 },
  docs:   { centerR: 0.78, minR: 0.67, maxR: 0.89 },
}
// Outermost radial position labels can occupy without bleeding into the
// directory rim — orbiters live at 1.0r, so their labels' inward extent is
// bounded here.
export const RIM_LANE_INNER = 0.89

// Back-compat shim: existing consumers (SVG band rings, file tethers, 3D galaxy
// dot positions) just want the band centerline.
export const BAND_RATIO: Record<Band, number> = {
  code:   BAND_LANE.code.centerR,
  config: BAND_LANE.config.centerR,
  docs:   BAND_LANE.docs.centerR,
}
export const BAND_COLOR: Record<Band, string> = { code: '#c9ff2e', config: '#ff6a1a', docs: '#33ffe0' }

// How far horizontally a label at this band can extend before it leaves its
// lane (in pixels, given a ring radius). Used as the maxWidthPx cap for
// labelCapacity so labels stay in their orbital range.
export function laneHalfWidthPx(band: Band, ringR: number): number {
  const l = BAND_LANE[band]
  return Math.min(l.centerR - l.minR, l.maxR - l.centerR) * ringR
}

function bandOf(ft: FileType): Band {
  if (ft === 'docs') return 'docs'
  if (ft === 'config' || ft === 'data') return 'config'
  return 'code'
}

export function dotColor(node?: FsNode): string {
  if (!node?.dominantType) return 'rgba(243,238,226,.55)'
  return FILE_TYPE_COLORS[node.dominantType] ?? 'rgba(243,238,226,.55)'
}

const BAND_CAP = 8

// Smaller = closer to the bottom of the ring (90° in screen coords)
function distFromDown(deg: number): number {
  const d = Math.abs(((deg - 90) % 360 + 360) % 360)
  return Math.min(d, 360 - d)
}

// `reservedLabels` are non-file names rendered on the same ring (dir orbiters
// and the parent dir's own name) that file labels must remain distinct from —
// otherwise a file and a sibling dir can both display "rta-blueprint-component"
// and the user can't tell which dot is which.
export function buildFileStars(
  node: FsNode,
  r: number,
  reservedLabels: ReadonlyArray<string> = [],
): Array<FileStar> {
  const files = node.files ?? []
  if (!files.length) return []
  const seed = node.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)

  const byBand = new Map<Band, Array<FileStar>>()
  for (const f of files) {
    const band = bandOf(extToFileType(f.name.split('.').pop() ?? ''))
    const list = byBand.get(band) ?? []
    if (list.length >= BAND_CAP) continue
    list.push({ n: f.name, path: f.path, tracked: f.tracked, band, a: 0, rr: r * BAND_RATIO[band] })
    byBand.set(band, list)
  }

  // Cross-band unique labels: comparison must cover EVERY file on the ring or
  // a single-file code band and a single-file docs band can both collapse to
  // their first token ("rta", "rta") through independent fitInCap calls — the
  // user has been screenshotting this exact failure. Use the tightest band's
  // cap as the soft target so even the worst-case lane respects the budget.
  // The dir-orbiter names + parent name are reserved so file labels stay
  // distinct from them too.
  const allFiles: Array<FileStar> = []
  for (const list of byBand.values()) allFiles.push(...list)
  const caps = [...byBand.entries()].map(([band, list]) =>
    labelCapacity(list.length, list[0].rr, laneHalfWidthPx(band, r) * 2),
  )
  const softCap = caps.length > 0 ? Math.min(...caps) : undefined
  const ringUnique = uniqueLabels(allFiles.map(f => f.n), softCap, reservedLabels)
  const uniqByPath = new Map(allFiles.map((f, i) => [f.path, ringUnique[i]]))

  const out: Array<FileStar> = []
  for (const [band, list] of byBand) {
    // Stagger band start angles so files on different bands don't stack radially
    const offset = (seed % 60) + (band === 'config' ? 24 : band === 'docs' ? 48 : 0)
    const slots  = list.map((_, i) => (i / list.length) * 360 + offset)
    // Labels hang BELOW the glyph: at the ring bottom they fall into open space,
    // at the top they'd cover the ring — so the longest names take the slots
    // nearest the bottom, the shortest float to the top.
    const byDown = [...slots].sort((a, b) => distFromDown(a) - distFromDown(b))
    const sorted = [...list].sort((a, b) => b.n.length - a.n.length)
    sorted.forEach((f, i) => {
      f.a = byDown[i]
      // Files on the upper half of the band flip their label ABOVE the diamond
      // so the name extends OUTWARD (into open sky) instead of inward across
      // the ring's contents.
      f.labelAbove = Math.sin((f.a * Math.PI) / 180) < -0.15
      f.display    = uniqByPath.get(f.path) ?? f.n
      out.push(f)
    })
  }
  return out
}
