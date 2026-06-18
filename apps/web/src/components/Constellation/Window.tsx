// Shared chrome for all floating windows in the constellation.
// · Drag via pointer capture on the tab bar
// · Resize frame rendered as a SIBLING of .win (outside its overflow:hidden
//   clip zone) so border-radius never eats the pointer-event area
import React from 'react'
import type { DragEngine, ResizeDir } from './engine/useDragEngine.js'

const RESIZE_DIRS: Array<ResizeDir> = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

type WindowProps = {
  id: string
  x: number           // center x — .win CSS uses translate(-50%,-50%)
  y: number           // center y
  width?: number
  height?: number     // required for resize handle to show
  focus?: boolean
  extraClass?: string
  drag?: DragEngine
  tabContent: React.ReactNode
  children: React.ReactNode
  // Raise-on-click: parent assigns 0 (default) up to N (most recently clicked).
  // We add it to the base z-index for both the window and its resize frame so
  // a click on any covered window brings it (and its handles) above the others.
  raiseLevel?: number
  onRaise?: () => void
}

export function Window({
  id, x, y, width, height, focus, extraClass, drag, tabContent, children,
  raiseLevel = 0, onRaise,
}: WindowProps): React.ReactElement {
  const dOff = drag?.dragOffset(id) ?? { x: 0, y: 0 }
  const sz   = drag?.resizeFor(id)

  const finalW = sz?.w ?? width
  const finalH = sz?.h ?? height

  const isFlexH = finalH !== undefined
  const cls = [
    'win',
    focus     ? 'focus'   : '',
    extraClass ?? '',
    isFlexH   ? 'win-flex' : '',
  ].filter(Boolean).join(' ')

  // Base z-index for .win is 5 and .win-frame is 26 (see constellationStyles).
  // Raise level shifts both in lockstep so handles stay above their own window
  // but never poke above context menus (cap raiseLevel at 10 from the caller).
  const style: React.CSSProperties = {
    left: x + dOff.x,
    top:  y + dOff.y,
    zIndex: 5 + raiseLevel,
    ...(finalW !== undefined ? { width:  finalW } : {}),
    ...(finalH !== undefined ? { height: finalH } : {}),
  }

  // Resize frame: sibling of .win, centered on the same point, slightly
  // larger than the window so its 8 handles straddle the border. Being
  // outside .win means overflow:hidden + border-radius can never clip them.
  // Each handle carries its own directional cursor (corners diagonal,
  // edges single-axis).
  let frame: React.ReactElement | null = null
  if (drag && finalW !== undefined && finalH !== undefined) {
    frame = (
      <div
        className="win-frame"
        style={{ left: x + dOff.x, top: y + dOff.y, width: finalW + 12, height: finalH + 12, zIndex: 26 + raiseLevel }}
        onPointerDownCapture={onRaise ? () => onRaise() : undefined}
      >
        {RESIZE_DIRS.map(dir => (
          <div
            key={dir}
            className={`rz rz-${dir}`}
            onPointerDown={e => drag.onResizeStart(id, e, finalW, finalH, dir)}
            onPointerMove={e => drag.onResizeMove(e)}
            onPointerUp={() => drag.onResizeEnd()}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <div
        className={cls}
        style={style}
        // Capture-phase so the raise fires before children's pointerdown
        // handlers stopPropagation (the tab does this for drag start).
        onPointerDownCapture={onRaise ? () => onRaise() : undefined}
      >
        <div
          className="win-tab"
          onPointerDown={drag ? e => drag.onDragStart(id, e) : undefined}
          onPointerMove={drag ? e => drag.onDragMove(e) : undefined}
          onPointerUp={drag ? () => drag.onDragEnd() : undefined}
        >
          <span className="win-dot" />
          {tabContent}
        </div>

        {children}
      </div>

      {frame}
    </>
  )
}
