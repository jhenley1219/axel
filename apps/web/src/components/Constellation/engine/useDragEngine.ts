// Per-element drag + resize engine. Declare once at the top of your component
// tree; pass the engine down to any draggable/resizable child via props.
// Both drag and resize use pointer capture so interaction stays live when the
// pointer leaves the element.
import type React from 'react'
import { useRef, useState } from 'react'

type Pt      = { x: number; y: number }
type WinSize = { w: number; h: number }

// Compass directions: corners resize both axes, edges resize one.
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type ActiveDrag   = { id: string; startPtr: Pt; startOffset: Pt }
type ActiveResize = { id: string; startPtr: Pt; baseSize: WinSize; baseOffset: Pt; dir: ResizeDir }

export type DragEngine = {
  // ── Position ──────────────────────────────────────────────────────────────
  dragOffset:  (id: string) => Pt
  onDragStart: (id: string, e: React.PointerEvent) => void
  onDragMove:  (e: React.PointerEvent) => void
  onDragEnd:   () => void
  clearOffset: (id: string) => void
  // ── Size ──────────────────────────────────────────────────────────────────
  // Returns the ABSOLUTE size if the user has resized this window; undefined
  // means "use the component's default dimensions".
  resizeFor:    (id: string) => WinSize | undefined
  // w and h are the window's current rendered dimensions — passed directly so
  // we don't have to crawl the DOM (the caller already knows them).
  onResizeStart: (id: string, e: React.PointerEvent, w: number, h: number, dir: ResizeDir) => void
  onResizeMove:  (e: React.PointerEvent) => void
  onResizeEnd:   () => void
  clearResize:   (id: string) => void
}

const MIN_W = 180
const MIN_H = 120

// TEMP: window-resize diagnostics — no-op unless src/debug/pointerLog.ts is
// installed (dev only). Remove with the debug module when done.
let lastDbgMove = 0
const dbg = (t: string, d?: Record<string, unknown>): void => {
  (window as { __axlog?: (t: string, d?: Record<string, unknown>) => void }).__axlog?.(t, d)
}

export function useDragEngine(): DragEngine {
  const [offsets, setOffsets] = useState(new Map<string, Pt>())
  const [sizes,   setSizes]   = useState(new Map<string, WinSize>())

  const activeDrag   = useRef<ActiveDrag   | null>(null)
  const activeResize = useRef<ActiveResize | null>(null)

  // ── Drag ──────────────────────────────────────────────────────────────────
  const dragOffset = (id: string): Pt => offsets.get(id) ?? { x: 0, y: 0 }

  const onDragStart = (id: string, e: React.PointerEvent): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const cur = offsets.get(id) ?? { x: 0, y: 0 }
    activeDrag.current = { id, startPtr: { x: e.clientX, y: e.clientY }, startOffset: cur }
  }

  const onDragMove = (e: React.PointerEvent): void => {
    const d = activeDrag.current; if (!d) return
    const dx = e.clientX - d.startPtr.x
    const dy = e.clientY - d.startPtr.y
    setOffsets(prev => {
      const next = new Map(prev)
      next.set(d.id, { x: d.startOffset.x + dx, y: d.startOffset.y + dy })
      return next
    })
  }

  const onDragEnd = (): void => { activeDrag.current = null }

  const clearOffset = (id: string): void => {
    setOffsets(prev => {
      if (!prev.has(id)) return prev
      const n = new Map(prev); n.delete(id); return n
    })
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  const resizeFor = (id: string): WinSize | undefined => sizes.get(id)

  const onResizeStart = (id: string, e: React.PointerEvent, w: number, h: number, dir: ResizeDir): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const baseSize   = sizes.get(id) ?? { w, h }
    const baseOffset = offsets.get(id) ?? { x: 0, y: 0 }
    activeResize.current = { id, startPtr: { x: e.clientX, y: e.clientY }, baseSize, baseOffset, dir }
    dbg('resizeStart', { id, dir, w: baseSize.w, h: baseSize.h })
  }

  const onResizeMove = (e: React.PointerEvent): void => {
    const d = activeResize.current; if (!d) return
    const dx = e.clientX - d.startPtr.x
    const dy = e.clientY - d.startPtr.y
    const { dir, baseSize, baseOffset } = d

    // Windows are center-anchored (translate(-50%,-50%)), so growing a side
    // by Δ must also shift the center by Δ/2 — that pins the opposite edge
    // and keeps the dragged edge glued to the pointer. Offsets derive from
    // the CLAMPED delta so the anchor holds even at min size.
    let w = baseSize.w, h = baseSize.h
    let ox = baseOffset.x, oy = baseOffset.y
    if (dir.includes('e')) { w = Math.max(MIN_W, baseSize.w + dx); ox = baseOffset.x + (w - baseSize.w) / 2 }
    if (dir.includes('w')) { w = Math.max(MIN_W, baseSize.w - dx); ox = baseOffset.x - (w - baseSize.w) / 2 }
    if (dir.includes('s')) { h = Math.max(MIN_H, baseSize.h + dy); oy = baseOffset.y + (h - baseSize.h) / 2 }
    if (dir.includes('n')) { h = Math.max(MIN_H, baseSize.h - dy); oy = baseOffset.y - (h - baseSize.h) / 2 }

    const now = Date.now()
    if (now - lastDbgMove > 150) { lastDbgMove = now; dbg('resizeMove', { id: d.id, dir, dx, dy, w, h }) }

    setSizes(prev => {
      const next = new Map(prev)
      next.set(d.id, { w, h })
      return next
    })
    setOffsets(prev => {
      const next = new Map(prev)
      next.set(d.id, { x: ox, y: oy })
      return next
    })
  }

  const onResizeEnd = (): void => {
    if (activeResize.current) dbg('resizeEnd', { id: activeResize.current.id })
    activeResize.current = null
  }

  const clearResize = (id: string): void => {
    setSizes(prev => {
      if (!prev.has(id)) return prev
      const n = new Map(prev); n.delete(id); return n
    })
  }

  return {
    dragOffset, onDragStart, onDragMove, onDragEnd, clearOffset,
    resizeFor, onResizeStart, onResizeMove, onResizeEnd, clearResize,
  }
}
