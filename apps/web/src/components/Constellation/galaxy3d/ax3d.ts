// 3D primitives for the galaxy view — the brand palette and the sprite/line
// vocabulary the design templates call window.AX3D (dashed rings, tethers,
// glow dots, flat diamonds, canvas labels, dust). Pure three.js, no app state.
import * as THREE from 'three'

export const COL = {
  lime:   0xc9ff2e,
  orange: 0xff6a1a,
  pink:   0xff2f86,
  cyan:   0x33ffe0,
  purp:   0x9b8cff,
  grn:    0x7adf9b,
  cream:  0xf3eee2,
} as const

// CSS color (hex or rgb/rgba string, as dotColor/BAND_COLOR emit) → three hex
export function cssColor(css: string): number {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css)
  if (m) return (Math.round(+m[1]) << 16) | (Math.round(+m[2]) << 8) | Math.round(+m[3])
  return new THREE.Color(css).getHex()
}

const hexStr = (hex: number): string => '#' + hex.toString(16).padStart(6, '0')

// ── Dashed ring on the XZ plane (the directory rim, lying flat in space) ────
export function dashedRing(r: number, color: number, opacity: number, dash = 4, gap = 6): THREE.Line {
  const pts: Array<THREE.Vector3> = []
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))
  }
  const l = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity }),
  )
  l.computeLineDistances()
  return l
}

// ── Dashed tether between two points; endpoints updatable per frame ─────────
export function tether(a: THREE.Vector3, b: THREE.Vector3, color: number, opacity: number, dash = 4, gap = 7): THREE.Line {
  const l = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]),
    new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity }),
  )
  l.computeLineDistances()
  l.userData.update = (na: THREE.Vector3, nb: THREE.Vector3): void => {
    const pos = l.geometry.getAttribute('position') as THREE.BufferAttribute
    pos.setXYZ(0, na.x, na.y, na.z)
    pos.setXYZ(1, nb.x, nb.y, nb.z)
    pos.needsUpdate = true
    l.computeLineDistances()
  }
  return l
}

// ── Radial-glow dot sprite (dir cores, subdir orbiters) ─────────────────────
const glowCache = new Map<number, THREE.CanvasTexture>()
function radialTex(hex: number): THREE.CanvasTexture {
  const hit = glowCache.get(hex)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  const col = hexStr(hex)
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62)
  g.addColorStop(0, col)
  g.addColorStop(0.4, col + 'bb')
  g.addColorStop(1, col + '00')
  x.fillStyle = g
  x.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  glowCache.set(hex, t)
  return t
}

export function glowDot(hex: number, size: number): THREE.Sprite {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex(hex), transparent: true, depthWrite: false }))
  sp.scale.set(size, size, 1)
  return sp
}

// ── Flat diamond sprite — the .fstar file glyph in space ────────────────────
const diamondCache = new Map<number, THREE.CanvasTexture>()
function diamondTex(hex: number): THREE.CanvasTexture {
  const hit = diamondCache.get(hex)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const x = c.getContext('2d')!
  const col = hexStr(hex)
  x.shadowColor = col
  x.shadowBlur = 10
  x.fillStyle = col
  x.save()
  x.translate(32, 32)
  x.rotate(Math.PI / 4)
  x.fillRect(-11, -11, 22, 22)
  x.restore()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  diamondCache.set(hex, t)
  return t
}

export function diamond(hex: number, size = 13): THREE.Sprite {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: diamondTex(hex), transparent: true, depthWrite: false }))
  sp.scale.set(size, size, 1)
  return sp
}

// ── Canvas text label sprite ────────────────────────────────────────────────
export function label(text: string, opts: { size?: number; dim?: boolean } = {}): THREE.Sprite {
  const size = opts.size ?? 10
  const k = 3 // oversample for crispness
  const font = `${size * k}px "Space Mono", monospace`
  const c = document.createElement('canvas')
  let x = c.getContext('2d')!
  x.font = font
  c.width = Math.ceil(x.measureText(text).width) + 8 * k
  c.height = Math.ceil(size * k * 1.6)
  x = c.getContext('2d')!
  x.font = font
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.fillStyle = opts.dim ? 'rgba(243,238,226,.55)' : '#f3eee2'
  x.fillText(text, c.width / 2, c.height / 2)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.minFilter = THREE.LinearFilter
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }))
  sp.scale.set(c.width / k, c.height / k, 1)
  return sp
}

// ── Background dust field ───────────────────────────────────────────────────
export function dust(count = 340, spread = 1600): THREE.Points {
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < pos.length; i++) pos[i] = (Math.random() - 0.5) * spread
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color: COL.cream, size: 1.6, transparent: true, opacity: 0.35, sizeAttenuation: false,
  }))
}

// Free GPU resources for an object tree (textures in the caches are shared and
// kept — only geometries and materials are per-instance)
export function disposeTree(root: THREE.Object3D): void {
  root.traverse(o => {
    const mesh = o as Partial<THREE.Mesh>
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = (o as Partial<THREE.Mesh>).material
    if (Array.isArray(mat)) mat.forEach(m => m.dispose())
    else if (mat) mat.dispose()
  })
}
