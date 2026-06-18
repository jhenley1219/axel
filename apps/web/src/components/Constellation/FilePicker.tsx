// Scrollable file list anchored to a star system. Replaces the on-rim file
// diamonds: a directory's files all live here instead of competing for band
// slots, so even huge dirs stay legible. Each row is color-coded by file type
// via FILE_TYPE_COLORS — the only piece of the band semantics that survives.
// Closes on outside pointerdown or Escape (same contract as ContextMenu).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileEntry } from '@axel/core'
import { FILE_TYPE_COLORS, extToFileType } from '../../types/constellation.js'

type Props = {
  x: number
  y: number
  title?: string
  files: Array<FileEntry>
  openFilePaths?: Set<string>
  dirtyFilePaths?: Set<string>
  onPick: (file: FileEntry, ev: React.MouseEvent | React.KeyboardEvent) => void
  onClose: () => void
}

// Files are sorted: open first (so the user can find what's already on-screen),
// then dirty, then alphabetical. Search is only shown for big dirs where
// scrolling alone would be a hassle.
const SEARCH_THRESHOLD = 30

function typeColor(name: string): string {
  return FILE_TYPE_COLORS[extToFileType(name.split('.').pop() ?? '')]
}

export function FilePicker({
  x, y, title, files, openFilePaths, dirtyFilePaths, onPick, onClose,
}: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')

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

  const sorted = useMemo(() => {
    const open = openFilePaths ?? new Set<string>()
    const dirty = dirtyFilePaths ?? new Set<string>()
    return [...files].sort((a, b) => {
      const ao = open.has(a.path) ? 0 : 1
      const bo = open.has(b.path) ? 0 : 1
      if (ao !== bo) return ao - bo
      const ad = dirty.has(a.path) ? 0 : 1
      const bd = dirty.has(b.path) ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name)
    })
  }, [files, openFilePaths, dirtyFilePaths])

  const filtered = useMemo(() => {
    if (!query) return sorted
    const q = query.toLowerCase()
    return sorted.filter(f => f.name.toLowerCase().includes(q))
  }, [sorted, query])

  const showSearch = files.length >= SEARCH_THRESHOLD

  // Portal to document.body so the picker escapes ConstellationScene's
  // `.gc` stacking context (created by its position:fixed). Without this,
  // settings/expand panels and the hover label overlay paint over the
  // picker no matter how high its z-index is set.
  return createPortal(
    <div className="file-picker" ref={ref} style={{ left: x, top: y }}>
      {title && <div className="ctx-title">{title}</div>}
      {showSearch && (
        <input
          className="file-picker-search"
          type="text"
          autoFocus
          placeholder="filter…"
          value={query}
          onChange={ev => setQuery(ev.target.value)}
          onClick={ev => ev.stopPropagation()}
        />
      )}
      <div className="file-picker-list">
        {filtered.length === 0 && (
          <div className="file-picker-empty">no files</div>
        )}
        {filtered.map(f => {
          const c     = typeColor(f.name)
          const open  = openFilePaths?.has(f.path) ?? false
          const dirty = dirtyFilePaths?.has(f.path) ?? false
          const cls   = `file-picker-row${open ? ' open' : ''}${!f.tracked ? ' untracked' : ''}`
          return (
            <button
              key={f.path}
              className={cls}
              onClick={ev => { ev.stopPropagation(); onPick(f, ev); onClose() }}
              onKeyDown={ev => { if (ev.key === 'Enter') { onPick(f, ev); onClose() } }}
            >
              <i className="file-picker-swatch" style={{ background: c, boxShadow: `0 0 5px ${c}aa` }} />
              <span className="file-picker-name">{f.name}</span>
              {dirty && <em className="file-picker-dirty" />}
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
