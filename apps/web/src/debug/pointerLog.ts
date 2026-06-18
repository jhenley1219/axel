// TEMP diagnostic instrumentation for window-resize debugging — REMOVE when done.
// Streams pointer events, hovered-element + cursor info, resize-engine events
// (via window.__axlog), JS errors, and 1s window/frame geometry snapshots to
// the vite dev server's /__uilog sink (appends to /tmp/axel-uilog.jsonl).

type Entry = Record<string, unknown>
type AxLog = (t: string, d?: Record<string, unknown>) => void

const FLUSH_MS = 400
const MOVE_MS  = 120

const describe = (el: Element | null): string => {
  if (!el) return 'NONE'
  const cls = el.getAttribute('class') ?? ''
  return `${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`
}

const rect = (el: Element): Array<number> => {
  const b = el.getBoundingClientRect()
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
}

export function installPointerLog(): void {
  const sess = Math.random().toString(36).slice(2, 8)
  let queue: Array<Entry> = []
  const log = (e: Entry): void => { queue.push({ ...e, ts: Date.now() }) }
  ;(window as { __axlog?: AxLog }).__axlog = (t, d) => log({ t, ...d })

  const flush = (): void => {
    if (!queue.length) return
    const body = JSON.stringify({ sess, entries: queue })
    queue = []
    fetch('/__uilog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .catch(() => {})
  }
  setInterval(flush, FLUSH_MS)
  window.addEventListener('pagehide', flush)

  log({ t: 'start', ua: navigator.userAgent, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio })

  // Hover trace: where the pointer is, what's under it, what cursor that shows
  let lastMove = 0
  document.addEventListener('pointermove', e => {
    const now = Date.now()
    if (now - lastMove < MOVE_MS) return
    lastMove = now
    const el = document.elementFromPoint(e.clientX, e.clientY)
    log({
      t: 'move', x: Math.round(e.clientX), y: Math.round(e.clientY), pt: e.pointerType,
      el: describe(el), cursor: el ? getComputedStyle(el).cursor : '',
    })
  }, { capture: true, passive: true })

  for (const type of ['pointerdown', 'pointerup', 'pointercancel'] as const) {
    document.addEventListener(type, e => {
      log({
        t: type, x: Math.round(e.clientX), y: Math.round(e.clientY),
        pt: e.pointerType, btn: e.button, target: describe(e.target as Element),
      })
    }, { capture: true })
  }
  document.addEventListener('lostpointercapture', e => {
    log({ t: 'lostcapture', target: describe(e.target as Element) })
  }, { capture: true })

  window.addEventListener('error', e => log({ t: 'jserror', msg: e.message, src: `${e.filename}:${e.lineno}` }))
  window.addEventListener('unhandledrejection', e => log({ t: 'rejection', msg: String(e.reason) }))

  // Geometry snapshot: are windows/frames/handles mounted, and do they align?
  setInterval(() => {
    const wins   = [...document.querySelectorAll('.win')]
    const frames = [...document.querySelectorAll('.win-frame')]
    log({
      t: 'snap',
      wins: wins.length, frames: frames.length,
      rz: document.querySelectorAll('.rz').length,
      winRects:   wins.map(rect),
      frameRects: frames.map(rect),
    })
  }, 1000)
}
