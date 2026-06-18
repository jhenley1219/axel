// Right-click menu for constellation elements. Positioned at a
// container-relative point; closes on outside pointerdown or Escape.
import React, { useEffect, useRef } from 'react'

export type ContextMenuItem = { label: string; onClick: () => void }

type Props = {
  x: number
  y: number
  title?: string
  items: Array<ContextMenuItem>
  onClose: () => void
}

export function ContextMenu({ x, y, title, items, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {title && <div className="ctx-title">{title}</div>}
      {items.map(item => (
        <button
          key={item.label}
          className="ctx-item"
          onClick={() => { item.onClick(); onClose() }}
        >{item.label}</button>
      ))}
    </div>
  )
}
