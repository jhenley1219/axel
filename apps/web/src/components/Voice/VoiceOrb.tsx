import { useEffect, useRef } from 'react'

export type OrbState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'responding'

// Map our internal states to the designer's state names
const STATE_MAP: Record<OrbState, string> = {
  idle:         'static',
  listening:    'listening',
  transcribing: 'thinking',
  thinking:     'thinking',
  responding:   'speaking',
}

// ── One-time DOM injection (SVG filters + CSS) ────────────────────────────────
function injectAxleOrb() {
  if (typeof document === 'undefined' || document.getElementById('ax-orb-styles')) return

  // SVG displacement filters
  const svgHolder = document.createElement('div')
  svgHolder.innerHTML = `
  <svg width="0" height="0" style="position:absolute;pointer-events:none" aria-hidden="true">
   <defs>
    <filter id="ax-fx-soft" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.010 0.024" numOctaves="2" seed="2" result="n"/>
      <feOffset in="n" dy="0" result="m"><animate attributeName="dy" values="0;-180" dur="9s" repeatCount="indefinite"/></feOffset>
      <feDisplacementMap in="SourceGraphic" in2="m" scale="9" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="ax-fx-wave" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.030" numOctaves="2" seed="5" result="n"/>
      <feOffset in="n" dy="0" result="m"><animate attributeName="dy" values="0;-200" dur="5.5s" repeatCount="indefinite"/></feOffset>
      <feDisplacementMap in="SourceGraphic" in2="m" scale="14" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="ax-fx-churn" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.045" numOctaves="2" seed="9" result="n">
        <animate attributeName="baseFrequency" values="0.018 0.045;0.026 0.060;0.018 0.045" dur="3.6s" repeatCount="indefinite"/>
      </feTurbulence>
      <feOffset in="n" dx="0" dy="0" result="m">
        <animate attributeName="dx" values="0;90;0;-90;0" dur="4s" repeatCount="indefinite"/>
        <animate attributeName="dy" values="0;-140" dur="3.4s" repeatCount="indefinite"/>
      </feOffset>
      <feDisplacementMap in="SourceGraphic" in2="m" scale="18" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="ax-fx-break" x="-80%" y="-80%" width="260%" height="260%" color-interpolation-filters="sRGB">
      <feTurbulence type="turbulence" baseFrequency="0.045 0.13" numOctaves="1" seed="8" result="n">
        <animate attributeName="seed" values="8;3;15;6;11;1" dur="0.42s" calcMode="discrete" repeatCount="indefinite"/>
      </feTurbulence>
      <feComponentTransfer in="n" result="nq">
        <feFuncR type="discrete" tableValues="0 .35 .7 .15 1 .5"/>
        <feFuncG type="discrete" tableValues="0 .6 1 .25 .8"/>
      </feComponentTransfer>
      <feDisplacementMap in="SourceGraphic" in2="nq" scale="30" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feColorMatrix in="d" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
      <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
      <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
      <feOffset in="r" dx="6" dy="-1" result="ro"><animate attributeName="dx" values="6;-8;10;-4;7" dur="0.3s" calcMode="discrete" repeatCount="indefinite"/></feOffset>
      <feOffset in="b" dx="-6" dy="1" result="bo"><animate attributeName="dx" values="-6;9;-10;5;-7" dur="0.3s" calcMode="discrete" repeatCount="indefinite"/></feOffset>
      <feBlend in="ro" in2="g" mode="screen" result="rg"/>
      <feBlend in="rg" in2="bo" mode="screen"/>
    </filter>
   </defs>
  </svg>`
  document.body.appendChild(svgHolder.firstElementChild!)

  const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`

  const css = `
  .ax-orb{position:relative;display:block;
    --lime:#c9ff2e;--lime2:#7bd000;--pink:#ff2f86;--pink2:#ff1f63;
    --cyan:#33ffe0;--cyan2:#00cdd6;--orange:#ff6a1a;--ink:#0c0c0e;--cream:#f3eee2;
    isolation:isolate;}
  .ax-orb *{box-sizing:border-box;}
  .ax-glow{position:absolute;inset:-22%;border-radius:50%;z-index:0;
    background:radial-gradient(circle at 50% 50%, rgba(201,255,46,.55), rgba(255,47,134,.28) 42%, transparent 68%);
    filter:blur(14px);animation:ax-glowpulse 4.2s ease-in-out infinite;}
  @keyframes ax-glowpulse{0%,100%{opacity:.7;transform:scale(.98)}50%{opacity:1;transform:scale(1.06)}}
  .ax-ripple{position:absolute;inset:0;z-index:1;border-radius:50%;display:none;}
  .ax-ripple span{position:absolute;inset:0;border-radius:50%;border:2px solid var(--lime);opacity:0;}
  .ax-orb[data-state="listening"] .ax-ripple,
  .ax-orb[data-state="speaking"] .ax-ripple{display:block;}
  .ax-orb[data-state="listening"] .ax-ripple span{animation:ax-sonar 2.1s cubic-bezier(.2,.6,.3,1) infinite;}
  .ax-orb[data-state="listening"] .ax-ripple span:nth-child(2){animation-delay:.7s;border-color:var(--orange);}
  .ax-orb[data-state="listening"] .ax-ripple span:nth-child(3){animation-delay:1.4s;border-color:var(--pink);}
  .ax-orb[data-state="speaking"] .ax-ripple span{animation:ax-sonar 1.15s steps(1,end) infinite;}
  .ax-orb[data-state="speaking"] .ax-ripple span:nth-child(2){animation:ax-sonar 1.15s cubic-bezier(.2,.6,.3,1) infinite .38s;border-color:var(--orange);}
  .ax-orb[data-state="speaking"] .ax-ripple span:nth-child(3){animation:ax-sonar 1.15s cubic-bezier(.2,.6,.3,1) infinite .76s;border-color:var(--pink);}
  @keyframes ax-sonar{0%{transform:scale(.86);opacity:.9}80%{opacity:0}100%{transform:scale(1.5);opacity:0}}
  .ax-fx{position:absolute;inset:0;z-index:2;}
  .ax-orb[data-state="static"]    .ax-fx{filter:url(#ax-fx-soft);}
  .ax-orb[data-state="listening"] .ax-fx{filter:url(#ax-fx-wave);}
  .ax-orb[data-state="speaking"]  .ax-fx{filter:url(#ax-fx-wave);}
  .ax-orb[data-state="thinking"]  .ax-fx{filter:url(#ax-fx-churn);}
  .ax-orb[data-state="error"]     .ax-fx{filter:url(#ax-fx-break);}
  .ax-ring{position:absolute;inset:-9%;border-radius:50%;display:none;border:2px dashed var(--cyan);opacity:0;}
  .ax-orb[data-state="thinking"] .ax-ring{display:block;animation:ax-spin 3.4s linear infinite, ax-ringfade .9s ease-in forwards;}
  @keyframes ax-spin{to{transform:rotate(360deg)}}
  @keyframes ax-ringfade{from{opacity:0}to{opacity:.7}}
  .ax-body{position:absolute;inset:-5%;border-radius:50%;
    -webkit-mask:radial-gradient(circle at 50% 50%, #000 48%, rgba(0,0,0,.55) 64%, transparent 78%);
            mask:radial-gradient(circle at 50% 50%, #000 48%, rgba(0,0,0,.55) 64%, transparent 78%);
    animation:ax-breathe 5s ease-in-out infinite;}
  @keyframes ax-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
  .ax-blob{position:absolute;border-radius:50%;mix-blend-mode:screen;
    filter:blur(var(--ax-blur,9px));will-change:transform;}
  .ax-blob.lime  {inset:13% 30% 30% 11%;background:radial-gradient(circle, var(--lime),  rgba(201,255,46,0) 66%);animation:ax-drift1 7s  ease-in-out infinite;}
  .ax-blob.orange{inset:11% 13% 35% 35%;background:radial-gradient(circle, var(--orange),rgba(255,106,26,0) 66%);animation:ax-drift2 9s  ease-in-out infinite;}
  .ax-blob.pink  {inset:35% 15% 11% 30%;background:radial-gradient(circle, var(--pink),  rgba(255,47,134,0) 66%);animation:ax-drift3 11s ease-in-out infinite;}
  .ax-blob.cyan  {inset:30% 35% 15% 13%;background:radial-gradient(circle, var(--cyan),  rgba(51,255,224,0) 66%);animation:ax-drift4 13s ease-in-out infinite;}
  @keyframes ax-drift1{0%,100%{transform:translate(-6%,-4%) scale(1)}  33%{transform:translate(13%,10%) scale(1.2)} 66%{transform:translate(7%,-9%) scale(.9)}}
  @keyframes ax-drift2{0%,100%{transform:translate(5%,6%) scale(1.05)} 33%{transform:translate(-11%,-6%) scale(.88)}66%{transform:translate(-4%,11%) scale(1.18)}}
  @keyframes ax-drift3{0%,100%{transform:translate(4%,-6%) scale(.95)} 33%{transform:translate(-9%,9%) scale(1.22)} 66%{transform:translate(11%,4%) scale(1)}}
  @keyframes ax-drift4{0%,100%{transform:translate(-5%,5%) scale(1.1)} 33%{transform:translate(10%,-9%) scale(.92)} 66%{transform:translate(-11%,-4%) scale(1.14)}}
  .ax-holo{position:absolute;inset:0;border-radius:50%;mix-blend-mode:overlay;opacity:.35;pointer-events:none;
    background:linear-gradient(115deg,transparent 22%,rgba(255,47,134,.9) 34%,rgba(51,255,224,.9) 46%,rgba(201,255,46,.9) 56%,transparent 70%);
    background-size:260% 260%;animation:ax-holosweep 5.5s linear infinite;}
  @keyframes ax-holosweep{0%{background-position:0% 50%}100%{background-position:260% 50%}}
  .ax-scan{position:absolute;inset:0;border-radius:50%;mix-blend-mode:overlay;opacity:.5;pointer-events:none;
    background:repeating-linear-gradient(0deg, rgba(0,0,0,.55) 0 1px, transparent 1px 3px);
    animation:ax-scanroll 6s linear infinite;}
  @keyframes ax-scanroll{to{background-position:0 60px}}
  .ax-grain{position:absolute;inset:-30%;border-radius:50%;background-image:${GRAIN};background-size:160px 160px;
    mix-blend-mode:soft-light;opacity:.85;pointer-events:none;animation:ax-grainshift .6s steps(2) infinite;}
  @keyframes ax-grainshift{0%{transform:translate(0,0)}50%{transform:translate(-7px,5px)}100%{transform:translate(4px,-6px)}}
  .ax-blocks{position:absolute;inset:0;display:none;}
  .ax-orb[data-state="thinking"] .ax-blocks{display:block;}
  .ax-blocks i{position:absolute;display:block;background:var(--cream);mix-blend-mode:overlay;opacity:0;}
  .ax-blocks i:nth-child(1){left:30%;top:38%;width:16%;height:5%;animation:ax-flick 1.1s steps(1) infinite;}
  .ax-blocks i:nth-child(2){left:52%;top:30%;width:9%;height:5%;animation:ax-flick .8s steps(1) infinite .2s;}
  .ax-blocks i:nth-child(3){left:40%;top:58%;width:22%;height:5%;animation:ax-flick 1.4s steps(1) infinite .5s;}
  .ax-blocks i:nth-child(4){left:58%;top:64%;width:11%;height:5%;animation:ax-flick .95s steps(1) infinite .35s;}
  @keyframes ax-flick{0%,72%,100%{opacity:0}74%,86%{opacity:.85}}
  .ax-wave{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;}
  .ax-orb[data-state="listening"] .ax-wave,
  .ax-orb[data-state="speaking"] .ax-wave{display:block;}
  .ax-mosaic{position:absolute;inset:0;border-radius:50%;display:none;mix-blend-mode:hard-light;opacity:.5;pointer-events:none;
    background:repeating-linear-gradient(90deg, rgba(255,47,134,.7) 0 6px, transparent 6px 12px, rgba(51,255,224,.7) 12px 18px, transparent 18px 26px);
    animation:ax-mosaicshift .2s steps(3) infinite;}
  .ax-orb[data-state="error"] .ax-mosaic{display:block;}
  @keyframes ax-mosaicshift{0%{transform:translateX(0)}100%{transform:translateX(26px)}}
  .ax-orb[data-state="error"] .ax-body{animation:ax-colorbreak .5s steps(1) infinite;}
  @keyframes ax-colorbreak{0%,72%{filter:none}10%{filter:hue-rotate(150deg) saturate(2.2)}28%{filter:invert(.85) hue-rotate(80deg)}46%{filter:hue-rotate(-90deg) contrast(2.4)}60%{filter:saturate(3) brightness(1.3)}}
  .ax-orb[data-state="listening"] .ax-body{animation:ax-breathe 2.2s ease-in-out infinite;}
  .ax-orb[data-state="listening"] .ax-glow{animation:ax-glowpulse 2.2s ease-in-out infinite;
    background:radial-gradient(circle at 50% 50%, rgba(201,255,46,.7), rgba(255,106,26,.3) 44%, transparent 70%);}
  .ax-orb[data-state="thinking"] .ax-scan{animation:ax-scanroll 1.6s linear infinite;}
  .ax-orb[data-state="speaking"] .ax-body{animation:ax-bob 1.15s ease-in-out infinite;}
  @keyframes ax-bob{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
  .ax-orb[data-state="speaking"] .ax-glow{background:radial-gradient(circle at 50% 50%, rgba(255,106,26,.6), rgba(255,47,134,.35) 44%, transparent 70%);}
  .ax-orb[data-state="error"]{animation:ax-shake .26s steps(2) infinite;}
  .ax-orb[data-state="error"] .ax-glow{background:radial-gradient(circle at 50% 50%, rgba(255,31,99,.75), rgba(255,47,134,.4) 45%, transparent 70%);animation:ax-glowpulse 1.1s steps(2) infinite;}
  @keyframes ax-shake{0%{transform:translate(0,0)}25%{transform:translate(-3px,1px)}50%{transform:translate(2px,-2px)}75%{transform:translate(-2px,-1px)}100%{transform:translate(3px,2px)}}
  .ax-orb[data-finish="riso"] .ax-grain{opacity:1;mix-blend-mode:multiply;}
  .ax-orb[data-finish="riso"] .ax-holo{display:none;}
  .ax-orb[data-finish="riso"] .ax-glow{filter:blur(22px);opacity:.5;}
  .ax-orb[data-finish="sticker"] .ax-body{-webkit-mask:radial-gradient(circle at 50% 50%, #000 60%, transparent 74%);mask:radial-gradient(circle at 50% 50%, #000 60%, transparent 74%);}
  .ax-orb[data-finish="sticker"] .ax-blob{filter:blur(calc(var(--ax-blur,9px)*.55));}
  .ax-orb[data-finish="sticker"] .ax-grain{opacity:.3;}
  .ax-orb[data-finish="sticker"] .ax-glow{background:radial-gradient(circle at 50% 50%, rgba(243,238,226,.45), rgba(201,255,46,.3) 40%, transparent 66%);}
  .ax-orb[data-finish="holo"] .ax-holo{opacity:.9;mix-blend-mode:color-dodge;animation-duration:3.6s;}
  .ax-orb[data-finish="holo"] .ax-grain{opacity:.4;}
  `

  const s = document.createElement('style')
  s.id = 'ax-orb-styles'
  s.textContent = css
  document.head.appendChild(s)
}

type Props = {
  orbState: OrbState
  onTap: () => void
  size?: number
  finish?: 'signature' | 'riso' | 'sticker' | 'holo'
  seed?: number
}

export function VoiceOrb({ orbState, onTap, size = 220, finish = 'signature', seed = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const designState = STATE_MAP[orbState]

  // Inject styles once on mount
  useEffect(() => { injectAxleOrb() }, [])

  // Canvas waveform animation for listening/speaking states
  useEffect(() => {
    const reactive = designState === 'listening' || designState === 'speaking'
    const cv = canvasRef.current
    if (!cv || !reactive) return

    const ctx = cv.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = size * dpr
    cv.height = size * dpr
    ctx.scale(dpr, dpr)
    const cx = size / 2, cy = size / 2
    let raf: number
    const t0 = performance.now()

    const sig = (a: number, t: number) =>
      Math.sin(a * 3 + t * 2.1 + seed) * 0.5 +
      Math.sin(a * 5 - t * 3.3 + seed * 1.7) * 0.3 +
      Math.sin(a * 8 + t * 5.1 + seed * 0.7) * 0.2

    const drawListening = (t: number) => {
      const R = size * 0.355, amp = size * 0.045
      ctx.clearRect(0, 0, size, size)
      ctx.lineWidth = Math.max(1.5, size * 0.012)
      ctx.strokeStyle = '#c9ff2e'
      ctx.shadowColor = '#c9ff2e'
      ctx.shadowBlur = size * 0.05
      ctx.beginPath()
      const N = 96
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2
        const q = Math.round(a * 9) / 9
        const r = R + sig(q, t) * amp * (0.7 + 0.3 * Math.sin(t * 1.3))
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
    }

    const drawSpeaking = (t: number) => {
      const W = size * 0.62, x0 = cx - W / 2, baseY = cy
      const word = Math.max(0, Math.sin(t * 2.0)) * (0.5 + 0.5 * Math.sin(t * 7.3 + seed))
      const amp = size * 0.16 * (0.25 + word)
      ctx.clearRect(0, 0, size, size)
      ctx.lineWidth = Math.max(1.8, size * 0.014)
      ctx.lineCap = 'round'
      ctx.strokeStyle = '#f3eee2'
      ctx.shadowColor = '#ff6a1a'
      ctx.shadowBlur = size * 0.06
      ctx.beginPath()
      const N = 80
      for (let i = 0; i <= N; i++) {
        const p = i / N, x = x0 + p * W, win = Math.sin(p * Math.PI)
        const y = baseY + Math.sin(p * 22 + t * 9) * amp * win * (0.6 + 0.4 * sig(p * 6, t))
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.stroke()
    }

    const loop = (now: number) => {
      const t = (now - t0) / 1000
      designState === 'listening' ? drawListening(t) : drawSpeaking(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [designState, size, seed])

  return (
    <div
      className="ax-orb"
      data-state={designState}
      data-finish={finish}
      onClick={onTap}
      style={{ width: size, height: size, '--ax-blur': `${size * 0.05}px`, cursor: 'pointer', flexShrink: 0 } as React.CSSProperties}
    >
      <div className="ax-glow" />
      <div className="ax-ripple"><span /><span /><span /></div>
      <div className="ax-fx">
        <div className="ax-ring" />
        <div className="ax-body">
          <div className="ax-blob cyan" />
          <div className="ax-blob pink" />
          <div className="ax-blob orange" />
          <div className="ax-blob lime" />
          <div className="ax-holo" />
          <div className="ax-scan" />
          <div className="ax-grain" />
          <div className="ax-blocks"><i /><i /><i /><i /></div>
          <div className="ax-mosaic" />
          <canvas ref={canvasRef} className="ax-wave" />
        </div>
      </div>
    </div>
  )
}
