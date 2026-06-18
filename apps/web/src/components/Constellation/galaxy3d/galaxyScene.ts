// The agent-centric 3D galaxy (port of the Agent Galaxy design template),
// driven by REAL app state instead of demo data: buildGalaxyScene() exposes
// sync() which diffs the open-system tree into ring groups, plus setters for
// the agent's pipeline state and commute target. Conventions preserved from
// the template: rings size to contents, subdir dots ride the rim, files are
// flat diamonds on type bands, quiet rings reveal labels on hover-bloom, the
// attended ring pulses, file windows tether to their diamond per frame.
import * as THREE from 'three'
import { COL, dashedRing, diamond, disposeTree, dust, glowDot, label, tether } from './ax3d.js'
import { buildAgentOrb, type AgentOrbState } from './agentOrb3d.js'

export type GalaxyOrbiter = { name: string; color: number }
export type GalaxyFile = { name: string; path: string; color: number; rr: number; a: number }
// Pre-computed particle positions for the probability-cloud ribbon around a
// ring. The React layer builds these (seeded off node.id) so positions stay
// stable across renders; the scene just streams them into a Points buffer.
export type GalaxyCloud3D = { x: number; y: number; z: number; color: number; size: number }

export type GalaxySystem = {
  dirId: string
  parentId?: string
  name: string
  sub?: string
  color: number
  r: number
  closing: boolean
  attended: boolean
  hot: boolean
  pos: [number, number, number]
  tilt: number
  orbiters: Array<GalaxyOrbiter>
  files: Array<GalaxyFile>
  cloud: Array<GalaxyCloud3D>
  // Dominant file-type color for the translucent torus that visualises the
  // cloud's body. Particles sit inside this halo.
  cloudTint: number
}

// Screen-space endpoint of an open file window (the window's inner edge).
// The dashed tether's source point is the owning dir's ring center (no more
// on-rim diamonds), so the dirId travels with the end-point to skip a
// per-frame search through every system's file list.
export type FileTetherEnd = { dirId: string; path: string; x: number; y: number; color: string }

// A DOM element to anchor to a ring's projected screen center each frame.
// The element should be `position:absolute; left:0; top:0`; the scene mutates
// its `transform` to `translate(Xpx, Ypx)`. A dashed tether is drawn in the
// SVG overlay from the ring center to (X, Y).
export type RingAnchor = { dirId: string; el: HTMLElement; offsetY: number }

export type ContextPick =
  | { kind: 'agent' }
  | { kind: 'dir'; dirId: string }
  | { kind: 'subdir'; dirId: string; name: string }
  | { kind: 'file'; dirId: string; path: string }

export type GalaxyCallbacks = {
  onFocusSystem: (dirId: string) => void
  onOpenSubdir: (name: string, fromDirId: string) => void
  onFileClick: (path: string, dirId: string) => void
  // Left-click on a dir core opens the file picker for that dir. Coords are
  // viewport-relative; the React layer converts against its container rect
  // (same convention as onContextPick).
  onFiles?: (dirId: string, clientX: number, clientY: number) => void
  onOrbTap: () => void
  onFollow?: (follow: boolean, focus: string) => void
  // Right-click without drag — clientX/clientY are viewport-relative so the
  // React layer can convert against its own container rect (it already does
  // this for 2D ring/orbiter context menus).
  onContextPick?: (pick: ContextPick, clientX: number, clientY: number) => void
}

export type GalaxyApi = {
  sync: (systems: Array<GalaxySystem>) => void
  setAgentState: (s: AgentOrbState) => void
  // dirId the agent attends (null = root). Commutes along a low arc.
  setAgentTarget: (dirId: string | null) => void
  setFileTethers: (ends: Array<FileTetherEnd>) => void
  // Register DOM elements to anchor at projected ring centers (plus offsetY)
  // each frame. Pass the full list every call; the scene diffs internally.
  setRingAnchors: (anchors: Array<RingAnchor>) => void
  dispose: () => void
}

type Pick = ContextPick

type OrbiterRec = { group: THREE.Group; lbl: THREE.Sprite; a0: number }
type FileRec    = { group: THREE.Group; lbl: THREE.Sprite; path: string; rr: number; a0: number }

type Sys = {
  data: GalaxySystem
  group: THREE.Group
  rim: THREE.Line
  core: THREE.Sprite
  coreSize: number
  rimOp: number
  hoverProxy: THREE.Mesh
  nameLabel: THREE.Sprite
  subLabel: THREE.Sprite | null
  orbKey: string
  orbiters: Array<OrbiterRec>
  fileKey: string
  files: Array<FileRec>
  cloudKey: string
  cloud: THREE.Points | null
  cloudBody: THREE.Mesh | null   // translucent torus halo behind the particles
  posGoal: THREE.Vector3
  scale: number
  scaleGoal: number
  bloom: number
  bloomGoal: number
  parentTether: THREE.Line | null
}

// Hover proxy is the invisible sphere that triggers a ring's bloom. Sized
// well outside the bloomed orbiter radius (max 1.32×r) so the cursor can
// follow a popped-out orbiter without exiting the hover zone — otherwise the
// ring un-blooms, the orbiter snaps back inside, the cursor is back in zone,
// and you get an oscillation that's nearly impossible to click through.
const HOVER_PROXY_SCALE = 1.7

const ease = (p: number): number => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
const orbKeyOf  = (s: GalaxySystem): string => s.orbiters.map(o => `${o.name}:${o.color}`).join('|')
const fileKeyOf = (s: GalaxySystem): string => s.files.map(f => `${f.path}:${f.rr.toFixed(1)}:${f.a.toFixed(1)}`).join('|')
// Cloud signature collapses to length + ring radius + tint — particles are
// seeded by the React layer so identity within a given (dirId, r, tint) is
// implicit. A tint change (file mix shifted) rebuilds the halo and points.
const cloudKeyOf = (s: GalaxySystem): string => `${s.cloud.length}:${s.r.toFixed(1)}:${s.cloudTint}`

export function buildGalaxyScene(el: HTMLElement, cb: GalaxyCallbacks): GalaxyApi {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(el.clientWidth, el.clientHeight)
  renderer.domElement.style.cssText = 'position:absolute;inset:0;cursor:grab;'
  el.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x08080a, 0.00025)
  const camera = new THREE.PerspectiveCamera(46, el.clientWidth / Math.max(1, el.clientHeight), 1, 6000)
  scene.add(dust(380, 1700))

  // ── SVG overlay: dashed tethers from file diamonds to docked windows ──────
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
  el.appendChild(overlay)
  let tetherEnds: Array<FileTetherEnd> = []
  let tetherLines: Array<SVGLineElement> = []

  // ── Systems ────────────────────────────────────────────────────────────────
  const sysMap = new Map<string, Sys>()

  const buildOrbiters = (s: Sys): void => {
    for (const o of s.orbiters) { s.group.remove(o.group); disposeTree(o.group) }
    s.orbiters = s.data.orbiters.map((o, i) => {
      const g = new THREE.Group()
      const glyph = glowDot(o.color, 12)
      glyph.userData.pick = { kind: 'subdir', dirId: s.data.dirId, name: o.name } satisfies Pick
      const lbl = label(o.name, { size: 8, dim: true })
      lbl.position.y = -12
      lbl.visible = false
      g.add(glyph, lbl)
      s.group.add(g)
      return { group: g, lbl, a0: (i / Math.max(1, s.data.orbiters.length)) * Math.PI * 2 }
    })
    s.orbKey = orbKeyOf(s.data)
  }

  const buildFiles = (s: Sys): void => {
    for (const f of s.files) { s.group.remove(f.group); disposeTree(f.group) }
    s.files = s.data.files.map(f => {
      const g = new THREE.Group()
      const glyph = diamond(f.color, 13)
      glyph.userData.pick = { kind: 'file', dirId: s.data.dirId, path: f.path } satisfies Pick
      const lbl = label(f.name, { size: 7.5, dim: true })
      lbl.position.y = -13
      lbl.visible = false
      g.add(glyph, lbl)
      s.group.add(g)
      return { group: g, lbl, path: f.path, rr: f.rr, a0: (f.a * Math.PI) / 180 }
    })
    s.fileKey = fileKeyOf(s.data)
  }

  const buildRim = (s: Sys): void => {
    if (s.rim.parent) { s.group.remove(s.rim); disposeTree(s.rim) }
    s.rim = dashedRing(s.data.r, s.data.color, s.rimOp)
    s.group.add(s.rim)
    s.hoverProxy.scale.setScalar(s.data.r * HOVER_PROXY_SCALE)
    s.nameLabel.position.y = -(s.data.r + 18)
    if (s.subLabel) s.subLabel.position.y = -(s.data.r + 32)
  }

  // Probability-cloud body: a translucent additive torus mesh tinted by the
  // dir's dominant file type, sitting where the ring's interior previously
  // held diamonds. Particles ride inside it. Rebuilt only when the cloud
  // signature (length + radius + tint) changes — same dir at same size and
  // mix won't churn.
  const buildCloud = (s: Sys): void => {
    if (s.cloud) { s.group.remove(s.cloud); disposeTree(s.cloud) }
    if (s.cloudBody) { s.group.remove(s.cloudBody); disposeTree(s.cloudBody) }
    s.cloud = null
    s.cloudBody = null
    s.cloudKey = cloudKeyOf(s.data)
    if (s.data.r <= 0) return

    // Torus halo. Major radius hugs BAND_FRAC, minor radius gives the visible
    // ribbon thickness. AdditiveBlending + low opacity + depthWrite:false
    // makes overlapping rings stack into a soft glow instead of opaque blobs.
    const majorR = s.data.r * 0.55
    const minorR = s.data.r * 0.18
    const torusGeom = new THREE.TorusGeometry(majorR, minorR, 14, 80)
    // The ring lies in the xz-plane (y = 0); default TorusGeometry is in the
    // xy-plane, so rotate to match the particle distribution.
    torusGeom.rotateX(Math.PI / 2)
    const torusMat = new THREE.MeshBasicMaterial({
      color: s.data.cloudTint,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    s.cloudBody = new THREE.Mesh(torusGeom, torusMat)
    s.cloudBody.userData.pick = { kind: 'dir', dirId: s.data.dirId } satisfies Pick
    s.group.add(s.cloudBody)

    if (s.data.cloud.length === 0) return
    const n = s.data.cloud.length
    const positions = new Float32Array(n * 3)
    const colors    = new Float32Array(n * 3)
    let avgSize = 0
    const col = new THREE.Color()
    for (let i = 0; i < n; i++) {
      const p = s.data.cloud[i]
      positions[i * 3]     = p.x
      positions[i * 3 + 1] = p.y
      positions[i * 3 + 2] = p.z
      col.setHex(p.color)
      colors[i * 3]     = col.r
      colors[i * 3 + 1] = col.g
      colors[i * 3 + 2] = col.b
      avgSize += p.size
    }
    avgSize /= n
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      size: avgSize,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    s.cloud = new THREE.Points(geom, mat)
    s.group.add(s.cloud)
  }

  const buildLabels = (s: Sys): void => {
    if (s.nameLabel.parent) { s.group.remove(s.nameLabel); disposeTree(s.nameLabel) }
    s.nameLabel = label(s.data.name, { size: 10.5 })
    s.nameLabel.position.y = -(s.data.r + 18)
    s.group.add(s.nameLabel)
    if (s.subLabel?.parent) { s.group.remove(s.subLabel); disposeTree(s.subLabel) }
    s.subLabel = null
    if (s.data.sub) {
      s.subLabel = label(s.data.sub, { size: 7.5, dim: true })
      s.subLabel.position.y = -(s.data.r + 32)
      s.group.add(s.subLabel)
    }
  }

  const addSystem = (d: GalaxySystem): Sys => {
    const group = new THREE.Group()
    const parent = d.parentId ? sysMap.get(d.parentId) : undefined
    // grow out of the parent's current position; root appears in place
    group.position.copy(parent ? parent.group.position : new THREE.Vector3(...d.pos))
    group.rotation.x = d.tilt

    const isRoot = !d.parentId
    const coreSize = isRoot ? 24 : 18
    const rimOp = isRoot ? 0.34 : 0.3
    const core = glowDot(d.color, coreSize)
    core.userData.pick = { kind: 'dir', dirId: d.dirId } satisfies Pick
    group.add(core)

    const hoverProxy = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    hoverProxy.scale.setScalar(d.r * HOVER_PROXY_SCALE)
    hoverProxy.userData.dirId = d.dirId
    group.add(hoverProxy)

    const s: Sys = {
      data: d, group,
      rim: dashedRing(d.r, d.color, rimOp),
      core, coreSize, rimOp, hoverProxy,
      nameLabel: label(d.name, { size: 10.5 }),
      subLabel: null,
      orbKey: '', orbiters: [],
      fileKey: '', files: [],
      cloudKey: '', cloud: null, cloudBody: null,
      posGoal: new THREE.Vector3(...d.pos),
      scale: 0.05, scaleGoal: 1,
      bloom: 1, bloomGoal: 1,
      parentTether: null,
    }
    group.add(s.rim)
    buildLabels(s)
    buildOrbiters(s)
    buildFiles(s)
    buildCloud(s)

    if (parent) {
      s.parentTether = tether(parent.group.position, group.position, COL.cream, 0.3)
      scene.add(s.parentTether)
    }
    scene.add(group)
    sysMap.set(d.dirId, s)
    return s
  }

  const removeSystem = (id: string): void => {
    const s = sysMap.get(id)
    if (!s) return
    if (s.parentTether) { scene.remove(s.parentTether); disposeTree(s.parentTether) }
    scene.remove(s.group)
    disposeTree(s.group)
    sysMap.delete(id)
  }

  const sync = (systems: Array<GalaxySystem>): void => {
    const live = new Set(systems.map(s => s.dirId))
    for (const id of [...sysMap.keys()]) if (!live.has(id)) removeSystem(id)

    // parents first so children can spawn from them
    const ordered = [...systems].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0))
    for (const d of ordered) {
      const s = sysMap.get(d.dirId) ?? addSystem(d)
      const prev = s.data
      s.data = d
      s.posGoal.set(...d.pos)
      s.group.rotation.x = d.tilt
      s.scaleGoal = d.closing ? 0.001 : 1
      if (prev.r !== d.r || prev.color !== d.color) buildRim(s)
      if (prev.name !== d.name || prev.sub !== d.sub || prev.r !== d.r) buildLabels(s)
      if (orbKeyOf(d) !== s.orbKey) buildOrbiters(s)
      if (fileKeyOf(d) !== s.fileKey) buildFiles(s)
      if (cloudKeyOf(d) !== s.cloudKey) buildCloud(s)
      // late tether: parent may have appeared after this system
      if (!s.parentTether && d.parentId && sysMap.has(d.parentId)) {
        s.parentTether = tether(sysMap.get(d.parentId)!.group.position, s.group.position, COL.cream, 0.3)
        scene.add(s.parentTether)
      }
    }
  }

  // ── The agent (singular, commutes the tethers) ─────────────────────────────
  const orb = buildAgentOrb(20)
  const agentAnchor = new THREE.Vector3(0, 46, 0)
  orb.group.position.copy(agentAnchor)
  const agentHit = new THREE.Mesh(
    new THREE.SphereGeometry(34, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  agentHit.userData.pick = { kind: 'agent' } satisfies Pick
  orb.group.add(agentHit)
  scene.add(orb.group)

  let agentTargetId: string | null = null
  let moveFrom = agentAnchor.clone()
  let moveP = 1
  const targetPoint = (): THREE.Vector3 => {
    const s = agentTargetId ? sysMap.get(agentTargetId) : undefined
    const base = s ? s.group.position : new THREE.Vector3(0, 0, 0)
    return new THREE.Vector3(base.x, base.y + 46, base.z)
  }
  const setAgentTarget = (dirId: string | null): void => {
    if (dirId === agentTargetId) return
    agentTargetId = dirId
    moveFrom = agentAnchor.clone()
    moveP = 0
  }

  // ── Camera rig — orbit the pivot; follow the agent until broken off ───────
  const st = { theta: -0.7, phi: 0.34, r: 520 }
  const camTarget = orb.group.position.clone()
  const camGoal = camTarget.clone()
  let follow = true
  const setFollow = (b: boolean, name = 'free'): void => {
    follow = b
    cb.onFollow?.(b, b ? 'agent' : name)
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  const cv = renderer.domElement
  const ray = new THREE.Raycaster()
  let btn = -1, lx = 0, ly = 0, moved = false

  const ndc = (e: PointerEvent): THREE.Vector2 => {
    const r = cv.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    )
  }
  const pickables = (): Array<THREE.Object3D> => {
    const out: Array<THREE.Object3D> = [agentHit]
    for (const s of sysMap.values()) {
      out.push(s.core)
      if (s.cloudBody) out.push(s.cloudBody)
      for (const o of s.orbiters) out.push(o.group.children[0])
      for (const f of s.files) out.push(f.group.children[0])
    }
    return out
  }
  const hoverProxies = (): Array<THREE.Object3D> => [...sysMap.values()].map(s => s.hoverProxy)

  const onContextMenu = (e: Event): void => e.preventDefault()
  const onPointerDown = (e: PointerEvent): void => {
    btn = e.button; lx = e.clientX; ly = e.clientY; moved = false
    cv.setPointerCapture(e.pointerId)
    cv.style.cursor = 'grabbing'
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (btn < 0) {
      // hover: quiet rings reveal their names + bloom
      ray.setFromCamera(ndc(e), camera)
      const h = ray.intersectObjects(hoverProxies(), false)[0]
      const hovered = h ? (h.object.userData.dirId as string) : null
      for (const s of sysMap.values()) {
        const on = s.data.dirId === hovered
        s.bloomGoal = on ? (s.data.r > 90 ? 1.16 : 1.32) : 1
        for (const o of s.orbiters) o.lbl.visible = on
        for (const f of s.files) f.lbl.visible = on
      }
      cv.style.cursor = hovered ? 'pointer' : 'grab'
      return
    }
    const dx = e.clientX - lx, dy = e.clientY - ly
    if (Math.hypot(dx, dy) > 4) moved = true
    if (btn === 0) {
      st.theta -= dx * 0.005
      st.phi = Math.max(-1.2, Math.min(1.25, st.phi + dy * 0.004))
    } else if (btn === 2) {
      // break off the agent, pan the pivot freely
      if (follow) setFollow(false)
      const k = st.r / 700
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
      camGoal.addScaledVector(right, -dx * k).addScaledVector(up, dy * k)
    }
    lx = e.clientX; ly = e.clientY
  }
  const onPointerUp = (e: PointerEvent): void => {
    cv.style.cursor = 'grab'
    const wasBtn = btn
    btn = -1
    if (moved) return
    ray.setFromCamera(ndc(e), camera)
    // Right-click without drag → emit a context pick. Picks specific glyphs
    // first (orbiter, file, core); falls back to the ring-area hover proxy so
    // clicking the rim's empty interior still surfaces a 'dir' menu.
    if (wasBtn === 2) {
      if (!cb.onContextPick) return
      const specific = ray.intersectObjects(pickables(), false).find(h => h.object.userData.pick)
      if (specific) {
        cb.onContextPick(specific.object.userData.pick as Pick, e.clientX, e.clientY)
        return
      }
      const ring = ray.intersectObjects(hoverProxies(), false)[0]
      if (ring) {
        cb.onContextPick({ kind: 'dir', dirId: ring.object.userData.dirId as string }, e.clientX, e.clientY)
      }
      return
    }
    if (wasBtn !== 0) return
    const hit = ray.intersectObjects(pickables(), false).find(h => h.object.userData.pick)
    if (!hit) return
    const p = hit.object.userData.pick as Pick
    if (p.kind === 'agent') {
      setFollow(true)
      cb.onOrbTap()
    } else if (p.kind === 'dir') {
      const s = sysMap.get(p.dirId)
      if (s) { setFollow(false, s.data.name); camGoal.copy(s.group.position) }
      cb.onFocusSystem(p.dirId)
      // Same gesture also opens the file picker — files now live in the
      // dropdown instead of as on-rim diamonds.
      cb.onFiles?.(p.dirId, e.clientX, e.clientY)
    } else if (p.kind === 'subdir') {
      cb.onOpenSubdir(p.name, p.dirId)
    } else {
      cb.onFileClick(p.path, p.dirId)
    }
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    st.r = Math.max(120, Math.min(1600, st.r + e.deltaY * 0.7))
  }
  cv.addEventListener('contextmenu', onContextMenu)
  cv.addEventListener('pointerdown', onPointerDown)
  cv.addEventListener('pointermove', onPointerMove)
  cv.addEventListener('pointerup', onPointerUp)
  cv.addEventListener('wheel', onWheel, { passive: false })

  // ── File-window tethers ────────────────────────────────────────────────────
  const setFileTethers = (ends: Array<FileTetherEnd>): void => {
    tetherEnds = ends
    while (tetherLines.length > ends.length) tetherLines.pop()!.remove()
    while (tetherLines.length < ends.length) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('stroke-width', '1.2')
      line.setAttribute('stroke-dasharray', '3 6')
      line.setAttribute('opacity', '0.6')
      overlay.appendChild(line)
      tetherLines.push(line)
    }
  }

  // ── Ring anchors: per-frame position + tether for terminal windows ────────
  let ringAnchors: Array<RingAnchor> = []
  let ringTetherLines: Array<SVGLineElement> = []
  const setRingAnchors = (anchors: Array<RingAnchor>): void => {
    ringAnchors = anchors
    while (ringTetherLines.length > anchors.length) ringTetherLines.pop()!.remove()
    while (ringTetherLines.length < anchors.length) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('stroke', '#c9d1d9')
      line.setAttribute('stroke-width', '1.2')
      line.setAttribute('stroke-dasharray', '3 6')
      line.setAttribute('opacity', '0.45')
      overlay.appendChild(line)
      ringTetherLines.push(line)
    }
  }

  const ringProjV = new THREE.Vector3()
  // At this camera distance the wrapper renders at 1× (its "natural" size,
  // matching the 2D window). Closer → bigger, further → smaller, clamped so a
  // window never collapses to unreadability or becomes oversized at extreme
  // close-up. Matches the initial camera orbital radius (st.r = 520).
  const ANCHOR_REF_DIST = 520
  const ANCHOR_MIN_SCALE = 0.35
  const ANCHOR_MAX_SCALE = 1.6
  const ringWorldPos = new THREE.Vector3()
  const updateRingAnchors = (): void => {
    const w = el.clientWidth, h = el.clientHeight
    ringAnchors.forEach((a, i) => {
      const s = sysMap.get(a.dirId)
      const line = ringTetherLines[i]
      if (!s) {
        a.el.style.display = 'none'
        if (line) line.style.display = 'none'
        return
      }
      s.group.getWorldPosition(ringWorldPos)
      ringProjV.copy(ringWorldPos).project(camera)
      if (ringProjV.z > 1) {
        a.el.style.display = 'none'
        if (line) line.style.display = 'none'
        return
      }
      // Perspective scale: as the camera zooms away the ring shrinks on screen;
      // shrink the DOM window with it so it stays proportional. Apply scale and
      // translate together — translate is in screen px (post-scale, since
      // transforms compose right-to-left on the matrix).
      const dist  = camera.position.distanceTo(ringWorldPos)
      const scale = Math.max(ANCHOR_MIN_SCALE, Math.min(ANCHOR_MAX_SCALE, ANCHOR_REF_DIST / dist))
      const sx = (ringProjV.x * 0.5 + 0.5) * w
      const sy = (-ringProjV.y * 0.5 + 0.5) * h
      const wx = sx
      const wy = sy + a.offsetY * scale
      a.el.style.display = ''
      a.el.style.transform = `translate(${wx}px, ${wy}px) scale(${scale})`
      line.style.display = ''
      line.setAttribute('x1', String(sx))
      line.setAttribute('y1', String(sy))
      line.setAttribute('x2', String(wx))
      line.setAttribute('y2', String(wy))
    })
  }

  const projV = new THREE.Vector3()
  const updateFileTethers = (): void => {
    const w = el.clientWidth, h = el.clientHeight
    tetherEnds.forEach((end, i) => {
      const line = tetherLines[i]
      const sys = sysMap.get(end.dirId)
      if (!sys) { line.style.display = 'none'; return }
      sys.group.getWorldPosition(projV).project(camera)
      if (projV.z > 1) { line.style.display = 'none'; return }
      line.style.display = ''
      line.setAttribute('stroke', end.color)
      line.setAttribute('x1', String((projV.x * 0.5 + 0.5) * w))
      line.setAttribute('y1', String((-projV.y * 0.5 + 0.5) * h))
      line.setAttribute('x2', String(end.x))
      line.setAttribute('y2', String(end.y))
    })
  }

  // ── Loop (rAF + watchdog for throttled tabs) ───────────────────────────────
  const clock = new THREE.Clock()
  let raf = 0, dead = false, lastBeat = performance.now()

  const step = (): void => {
    const dt = Math.min(0.1, clock.getDelta())
    const t = clock.elapsedTime

    // agent commute — low arc along the tether, then track the target
    const tp = targetPoint()
    if (moveP < 1) {
      moveP = Math.min(1, moveP + dt / 2.2)
      const e2 = ease(moveP)
      agentAnchor.lerpVectors(moveFrom, tp, e2)
      agentAnchor.y += Math.sin(e2 * Math.PI) * 26
    } else {
      agentAnchor.lerp(tp, Math.min(1, dt * 6))
    }
    orb.group.position.set(agentAnchor.x, agentAnchor.y + Math.sin(t * 1.1) * 5, agentAnchor.z)
    orb.tick(t, dt)

    let si = 0
    for (const s of sysMap.values()) {
      s.scale += (s.scaleGoal - s.scale) * Math.min(1, dt * 4)
      s.group.scale.setScalar(Math.max(0.001, s.scale))
      s.group.position.lerp(s.posGoal, Math.min(1, dt * 3))
      s.bloom += (s.bloomGoal - s.bloom) * Math.min(1, dt * 8)
      s.rim.scale.set(s.bloom, 1, s.bloom)

      const br = s.data.r * s.bloom
      s.orbiters.forEach(o => {
        const a = o.a0 + t * (0.1 + si * 0.02)
        o.group.position.set(Math.cos(a) * br, 0, Math.sin(a) * br)
      })
      s.files.forEach(f => {
        const a = f.a0 + t * 0.08
        f.group.position.set(Math.cos(a) * f.rr, 0, Math.sin(a) * f.rr)
      })

      const rimMat = s.rim.material as THREE.LineDashedMaterial
      if (s.data.attended) {
        const k = 1 + Math.sin(t * 4.5) * 0.3
        s.core.scale.set(s.coreSize * k, s.coreSize * k, 1)
        rimMat.opacity = s.rimOp * (1.1 + Math.sin(t * 4.5) * 0.55)
      } else {
        s.core.scale.set(s.coreSize, s.coreSize, 1)
        rimMat.opacity = s.rimOp
      }

      if (s.parentTether) {
        const parent = s.data.parentId ? sysMap.get(s.data.parentId) : undefined
        if (parent) {
          ;(s.parentTether.userData.update as (a: THREE.Vector3, b: THREE.Vector3) => void)(
            parent.group.position, s.group.position,
          )
          const tm = s.parentTether.material as THREE.LineDashedMaterial
          const hot = s.data.hot && parent.data.hot
          tm.color.setHex(hot ? COL.lime : COL.cream)
          tm.opacity = (hot ? 0.5 : 0.3) * s.scale
        }
      }
      si++
    }

    if (follow) camGoal.copy(orb.group.position)
    camTarget.lerp(camGoal, 1 - Math.exp(-dt * 4.5))
    camera.position.set(
      camTarget.x + Math.sin(st.theta) * Math.cos(st.phi) * st.r,
      camTarget.y + Math.sin(st.phi) * st.r,
      camTarget.z + Math.cos(st.theta) * Math.cos(st.phi) * st.r,
    )
    camera.lookAt(camTarget)
    renderer.render(scene, camera)
    updateFileTethers()
    updateRingAnchors()
  }

  const loop = (): void => {
    if (dead) return
    lastBeat = performance.now()
    step()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  const watchdog = setInterval(() => {
    if (dead) { clearInterval(watchdog); return }
    if (performance.now() - lastBeat > 500) step()
  }, 80)

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth, h = el.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  })
  ro.observe(el)

  cb.onFollow?.(true, 'agent')

  return {
    sync,
    setAgentState: (s: AgentOrbState): void => orb.setState(s),
    setAgentTarget,
    setFileTethers,
    setRingAnchors,
    dispose: (): void => {
      dead = true
      cancelAnimationFrame(raf)
      clearInterval(watchdog)
      ro.disconnect()
      cv.removeEventListener('contextmenu', onContextMenu)
      cv.removeEventListener('pointerdown', onPointerDown)
      cv.removeEventListener('pointermove', onPointerMove)
      cv.removeEventListener('pointerup', onPointerUp)
      cv.removeEventListener('wheel', onWheel)
      disposeTree(scene)
      renderer.dispose()
      cv.remove()
      overlay.remove()
    },
  }
}
