// The Axle agent in 3D: a CRT-TV sphere. ShaderMaterial with fluid multi-colour
// churn (lime/orange/pink/cyan), rolling scanlines, broadcast static, fresnel
// rim, and glitch bands that slice the silhouette — the 2D orb's displacement-
// filter vibe, in volume. States drive churn speed + glitch amount and map 1:1
// onto the real voice pipeline (OrbState), plus an 'error' freakout.
import * as THREE from 'three'
import { COL } from './ax3d.js'
import type { OrbState } from '../../Voice/VoiceOrb.js'

export type AgentOrbState = OrbState | 'error'

const VERT = `
  uniform float uTime, uChurn, uGlitch, uSize;
  varying vec3 vNv; varying vec3 vV; varying vec3 vP;
  float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453123); }
  float vnoise(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float n000=hash(i), n100=hash(i+vec3(1,0,0)), n010=hash(i+vec3(0,1,0)), n110=hash(i+vec3(1,1,0));
    float n001=hash(i+vec3(0,0,1)), n101=hash(i+vec3(1,0,1)), n011=hash(i+vec3(0,1,1)), n111=hash(i+vec3(1,1,1));
    return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
               mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
  }
  void main(){
    vec3 p = position;
    /* fluid wobble — the sphere is never a perfect sphere */
    float w = vnoise(normalize(position)*2.4 + vec3(0.0, -uTime*0.45*uChurn, uTime*0.3));
    p += normal * (w - 0.5) * uSize * 0.22 * uChurn;
    /* CRT glitch: horizontal slice bands jump sideways */
    float band = floor((p.y/uSize + 1.2) * 9.0);
    float fr = floor(uTime*16.0);
    float on = step(1.0 - uGlitch*0.6, hash(vec3(band, fr, 3.0)));
    p.x += (hash(vec3(band, fr, 7.0)) - 0.5) * uSize * 0.55 * on * uGlitch;
    p.z += (hash(vec3(band, fr, 11.0)) - 0.5) * uSize * 0.3 * on * uGlitch;
    vP = p;
    vNv = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`

const FRAG = `
  precision highp float;
  uniform float uTime, uChurn, uGlitch, uSize;
  varying vec3 vNv; varying vec3 vV; varying vec3 vP;
  float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453123); }
  float vnoise(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float n000=hash(i), n100=hash(i+vec3(1,0,0)), n010=hash(i+vec3(0,1,0)), n110=hash(i+vec3(1,1,0));
    float n001=hash(i+vec3(0,0,1)), n101=hash(i+vec3(1,0,1)), n011=hash(i+vec3(0,1,1)), n111=hash(i+vec3(1,1,1));
    return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
               mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
  }
  float fbm(vec3 p){ return vnoise(p)*0.6 + vnoise(p*2.3+11.0)*0.4; }
  void main(){
    vec3 LIME = vec3(0.788, 1.0, 0.18);
    vec3 ORNG = vec3(1.0, 0.416, 0.102);
    vec3 PINK = vec3(1.0, 0.184, 0.525);
    vec3 CYAN = vec3(0.2, 1.0, 0.878);
    vec3 INK  = vec3(0.05, 0.05, 0.06);

    /* fluid colour field — drifting blobs of the four brand hues */
    vec3 q = normalize(vP) * 1.7;
    float t = uTime * 0.35 * uChurn;
    float f1 = fbm(q + vec3(t, -t*0.7, t*0.4));
    float f2 = fbm(q*1.4 + vec3(-t*0.8, t*0.5, 9.0));
    vec3 col = INK;
    col = mix(col, CYAN, smoothstep(0.42, 0.75, f1));
    col = mix(col, PINK, smoothstep(0.5, 0.85, f2));
    col = mix(col, ORNG, smoothstep(0.55, 0.9, fbm(q*1.1 + vec3(t*0.6, t*0.9, -t*0.5))));
    col = mix(col, LIME, smoothstep(0.58, 0.95, fbm(q*0.9 - vec3(t*0.5, -t*0.6, t*0.8))));

    /* fresnel rim — phosphor edge */
    float fres = pow(1.0 - abs(dot(normalize(vV), normalize(vNv))), 2.2);
    col += LIME * fres * 0.7;

    /* rolling scanlines */
    float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 2.4 - uTime*8.0);
    col *= scan;

    /* broadcast static */
    float stat = hash(vec3(floor(gl_FragCoord.xy*0.85), floor(uTime*26.0))) - 0.5;
    col += stat * (0.1 + uGlitch*0.3);

    /* glitch chroma break: bands swap channels */
    float band = floor((vP.y/uSize + 1.2) * 9.0);
    float on = step(1.0 - uGlitch*0.5, hash(vec3(band, floor(uTime*16.0), 5.0)));
    col = mix(col, col.brg, on * uGlitch);

    gl_FragColor = vec4(col, 0.96);
  }`

// Dashed circle on the XY plane (orb accessory rings face the camera-ish)
function ringLine(r: number, color: number, opacity: number, dash = 3, gap = 5): THREE.Line {
  const pts: Array<THREE.Vector3> = []
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0))
  }
  const l = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity }),
  )
  l.computeLineDistances()
  return l
}

const haloCache = new Map<number, THREE.CanvasTexture>()
function radialTex(hex: number): THREE.CanvasTexture {
  const hit = haloCache.get(hex)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  const col = '#' + hex.toString(16).padStart(6, '0')
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62)
  g.addColorStop(0, col)
  g.addColorStop(0.4, col + 'bb')
  g.addColorStop(1, col + '00')
  x.fillStyle = g
  x.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  haloCache.set(hex, t)
  return t
}

// churn = colour-field speed · glitch = band displacement amount
const PARAMS: Record<AgentOrbState, { churn: number; glitch: number }> = {
  idle:         { churn: 1.0, glitch: 0.08 },
  listening:    { churn: 1.5, glitch: 0.14 },
  transcribing: { churn: 1.9, glitch: 0.2 },
  thinking:     { churn: 2.5, glitch: 0.22 },
  responding:   { churn: 1.7, glitch: 0.14 },
  error:        { churn: 2.1, glitch: 1.0 },
}

export type AgentOrb = {
  group: THREE.Group
  tick: (t: number, dt?: number) => void
  setState: (s: AgentOrbState) => void
  getState: () => AgentOrbState
}

export function buildAgentOrb(size = 22): AgentOrb {
  const group = new THREE.Group()

  const uniforms = {
    uTime: { value: 0 }, uChurn: { value: 1 }, uGlitch: { value: 0.08 }, uSize: { value: size },
  }
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size, 56, 40),
    new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true }),
  )
  group.add(sphere)

  // faint multi-hue glow, small — an aura, not a green ball
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTex(COL.lime), transparent: true, depthWrite: false, opacity: 0.22,
  }))
  halo.scale.set(size * 3.1, size * 3.1, 1)
  group.add(halo)

  // thinking ring
  const thinkRing = ringLine(size * 1.7, COL.cyan, 0.75)
  thinkRing.visible = false
  group.add(thinkRing)

  // sonar rings (listening)
  const sonar = [COL.lime, COL.orange, COL.pink].map((col, i) => {
    const r = ringLine(size * 1.1, col, 0.8, 200, 0.01)
    r.visible = false
    r.userData.ph = i / 3
    group.add(r)
    return r
  })

  let state: AgentOrbState = 'idle'

  const tick = (t: number, dt = 0.016): void => {
    const p = PARAMS[state] ?? PARAMS.idle
    uniforms.uTime.value = t
    uniforms.uChurn.value += (p.churn - uniforms.uChurn.value) * Math.min(1, dt * 5)
    uniforms.uGlitch.value += (p.glitch - uniforms.uGlitch.value) * Math.min(1, dt * 7)

    const pulse = state === 'responding'
      ? 1 + Math.sin(t * 5.4) * 0.07
      : 1 + Math.sin(t * (state === 'listening' ? 2.8 : 1.1)) * 0.025
    sphere.scale.set(pulse, pulse, pulse)
    halo.material.color.setHex(
      state === 'error' ? COL.pink :
      state === 'responding' ? COL.orange :
      state === 'transcribing' ? COL.cyan : COL.lime)
    halo.material.opacity = state === 'responding' ? 0.3 + Math.sin(t * 5.4) * 0.08 : 0.22

    thinkRing.visible = state === 'thinking'
    if (thinkRing.visible) {
      thinkRing.rotation.z = t * 1.4
      thinkRing.rotation.x = Math.sin(t * 0.8) * 0.5
    }

    const listening = state === 'listening'
    for (const r of sonar) {
      r.visible = listening
      if (listening) {
        const pp = (t * 0.55 + (r.userData.ph as number)) % 1
        const k = 1 + pp * 1.6
        r.scale.set(k, k, 1)
        ;(r.material as THREE.LineDashedMaterial).opacity = 0.8 * (1 - pp)
      }
    }

    if (state === 'error') group.position.x += (Math.random() - 0.5) * 1.4
  }

  return {
    group,
    tick,
    setState: (s: AgentOrbState): void => { state = s },
    getState: (): AgentOrbState => state,
  }
}
