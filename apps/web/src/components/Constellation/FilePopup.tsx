// Spec §3.6 — tabbed file editor window. One window per source ring, one tab
// per open file. All tabs stay mounted (drafts survive switching); only the
// active one is visible. Uses the shared Window chrome with drag support.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { diffLines } from './diffLines.js'
import type { DragEngine } from './engine/useDragEngine.js'
import { Window } from './Window.js'

export type TabFile = {
  path: string
  name: string
  // Set when the agent surfaced this file via its open_file tool — drives the
  // highlight overlay, prompt banner, and accept/reject suggestion footer.
  highlights?: Array<{ snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }>
  suggestion?: { find: string; replace: string; reason?: string }
  prompt?: string
}

type FilePopupProps = {
  id: string
  files: Array<TabFile>
  activePath: string
  x: number
  y: number
  w: number
  h: number
  dirtyPaths: Set<string>
  drag: DragEngine
  onSelectTab: (path: string) => void
  onCloseTab:  (path: string) => void
  onDirty:     (path: string, dirty: boolean) => void
}

export function FilePopup({
  id, files, activePath, x, y, w, h, dirtyPaths, drag, onSelectTab, onCloseTab, onDirty,
}: FilePopupProps): React.ReactElement {
  // Stop pointer propagation on tab clicks so they don't start a window drag.
  const tab = (
    <div className="fwin-tabs" role="tablist">
      {files.map(f => (
        <div
          key={f.path}
          className={`ftab${f.path === activePath ? ' on' : ''}`}
          role="tab"
          aria-selected={f.path === activePath}
          onClick={() => onSelectTab(f.path)}
          onPointerDown={e => e.stopPropagation()}
        >
          <span className="ftab-name">{f.name}</span>
          {dirtyPaths.has(f.path) && <em className="fdirty" />}
          <button
            className="ftab-x"
            onClick={e => { e.stopPropagation(); onCloseTab(f.path) }}
            aria-label={`Close ${f.name}`}
          >✕</button>
        </div>
      ))}
    </div>
  )

  return (
    <Window id={id} x={x} y={y} width={w} height={h} focus drag={drag} extraClass="fwin" tabContent={tab}>
      {files.map(f => (
        <div key={f.path} className="ftab-body" style={{ display: f.path === activePath ? 'flex' : 'none' }}>
          <FileTab
            path={f.path}
            highlights={f.highlights}
            suggestion={f.suggestion}
            prompt={f.prompt}
            onDirty={onDirty}
          />
        </div>
      ))}
    </Window>
  )
}

type Loaded = { content: string; tracked: boolean; head: string | null }

type FileTabProps = {
  path: string
  highlights?: TabFile['highlights']
  suggestion?: TabFile['suggestion']
  prompt?: string
  onDirty: (path: string, dirty: boolean) => void
}

// localStorage draft survives reloads / HMR / accidental tab closes. Cleared on
// successful server save. Hydrated on mount so the user gets back their work
// even after a crash. Keep keys namespaced so unrelated apps on the same origin
// don't collide.
const DRAFT_KEY = (path: string): string => `axel:draft:${path}`
const DRAFT_DEBOUNCE_MS = 400

function FileTab({ path, highlights, suggestion, prompt, onDirty }: FileTabProps): React.ReactElement {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error,  setError]  = useState<string | null>(null)
  const [draft,  setDraft]  = useState('')
  const [saved,  setSaved]  = useState('')
  // Agent-opened files start in read-only view mode so highlights are immediately
  // visible; user-clicked files keep the existing edit-first behavior.
  const hasAgentMeta = !!(highlights?.length || suggestion || prompt)
  const [mode,   setMode]   = useState<'edit' | 'diff' | 'view'>(hasAgentMeta ? 'view' : 'edit')
  // The suggestion footer dismisses on either accept (apply find/replace) or
  // reject (just close the strip). The agent isn't notified either way.
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)
  const [flash,  setFlash]  = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let alive = true
    fetch(`/api/fs/file?path=${encodeURIComponent(path)}`, { credentials: 'include' })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!alive) return
        if (!ok || !data.ok) { setError(data.error ?? 'read failed'); return }
        setLoaded({ content: data.content, tracked: data.tracked, head: data.head })
        // Prefer a localStorage draft over server content when it differs —
        // the user's in-flight edits beat a stale read. Same-content drafts
        // are stale leftovers from a previous save round; drop them.
        let stored: string | null = null
        try { stored = window.localStorage.getItem(DRAFT_KEY(path)) } catch { /* private mode */ }
        const initial = stored !== null && stored !== data.content ? stored : data.content
        setDraft(initial)
        setSaved(data.content)
      })
      .catch(() => alive && setError('read failed'))
    return () => { alive = false }
  }, [path])

  // Debounced draft persistence. Skip until the file has loaded so we don't
  // overwrite a recovered draft with the empty initial state.
  useEffect(() => {
    if (!loaded) return
    if (draft === saved) {
      // Clean state — clear any stored draft so a future reload sees a
      // pristine file, not a phantom "● modified".
      try { window.localStorage.removeItem(DRAFT_KEY(path)) } catch { /* ignore */ }
      return
    }
    const handle = setTimeout(() => {
      try { window.localStorage.setItem(DRAFT_KEY(path), draft) } catch { /* quota or private mode */ }
    }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [draft, saved, loaded, path])

  const dirty = loaded !== null && draft !== saved

  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty
  useEffect(() => {
    onDirtyRef.current(path, dirty)
    return () => onDirtyRef.current(path, false)
  }, [path, dirty])

  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // A fresh open_file from the agent (new suggestion identity) re-shows the
  // suggestion strip even if the user dismissed the previous one.
  useEffect(() => { setSuggestionDismissed(false) }, [suggestion])

  const save = useCallback(() => {
    fetch('/api/fs/file', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: draft }),
    })
      .then(r => r.json())
      .then((data: { ok: boolean }) => {
        if (!data.ok) { setError('save failed'); return }
        setSaved(draft)
        setFlash(true)
        clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(false), 1300)
      })
      .catch(() => setError('save failed'))
  }, [path, draft])

  const rows = useMemo(
    () => (mode === 'diff' && loaded?.head != null) ? diffLines(loaded.head, draft) : [],
    [mode, loaded, draft],
  )
  const diffClean = rows.length > 0 && rows.every(r => r.t === 'ctx')
  const lineCount = draft.split('\n').length
  const canDiff   = loaded?.tracked === true && loaded.head !== null

  // Apply the agent's suggestion to the working draft. Doesn't auto-save — the
  // user reviews the dirty state and presses save, just like a manual edit.
  // No-op if the find string isn't in the current draft (already applied, or
  // the draft drifted from what the agent saw).
  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return
    setDraft(prev => prev.includes(suggestion.find) ? prev.replace(suggestion.find, suggestion.replace) : prev)
    setSuggestionDismissed(true)
    setMode('edit')
  }, [suggestion])

  // Build highlight segments for view mode. Each highlight's snippet is matched
  // verbatim (no regex); overlapping matches keep the earlier one.
  const viewSegments = useMemo(() => {
    if (!highlights?.length) return null
    type Span = { start: number; end: number; reason?: string; kind?: 'warn' | 'error' | 'info' }
    const spans: Array<Span> = []
    for (const h of highlights) {
      if (!h.snippet) continue
      let from = 0
      while (true) {
        const idx = draft.indexOf(h.snippet, from)
        if (idx < 0) break
        spans.push({ start: idx, end: idx + h.snippet.length, reason: h.reason, kind: h.kind })
        from = idx + h.snippet.length
      }
    }
    spans.sort((a, b) => a.start - b.start)
    const merged: Array<Span> = []
    for (const s of spans) {
      const last = merged[merged.length - 1]
      if (!last || s.start >= last.end) merged.push(s)
    }
    const out: Array<{ text: string; mark?: Span }> = []
    let cursor = 0
    for (const s of merged) {
      if (s.start > cursor) out.push({ text: draft.slice(cursor, s.start) })
      out.push({ text: draft.slice(s.start, s.end), mark: s })
      cursor = s.end
    }
    if (cursor < draft.length) out.push({ text: draft.slice(cursor) })
    return out
  }, [draft, highlights])

  if (error)   return <div className="fdiff-clean">{error}</div>
  if (!loaded) return <div className="fdiff-clean">loading…</div>

  // Cycle: edit → (view if hasAgentMeta) → (diff if canDiff) → edit.
  const cycleMode = (): void => setMode(m => {
    if (m === 'edit') return hasAgentMeta ? 'view' : (canDiff ? 'diff' : 'edit')
    if (m === 'view') return canDiff ? 'diff' : 'edit'
    return 'edit'
  })
  const cycleLabel = (): string => {
    if (mode === 'edit') return hasAgentMeta ? '± view' : (canDiff ? '± git diff' : (loaded.tracked ? '± git diff' : '± untracked'))
    if (mode === 'view') return canDiff ? '± git diff' : '± editor'
    return '± editor'
  }

  return (
    <>
      {prompt && mode !== 'diff' && (
        <div className="fwin-banner" role="note">{prompt}</div>
      )}

      {mode === 'edit' && (
        <div className="fwin-body">
          <div className="fwin-gut" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <textarea
            className="fwin-ta"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            wrap="off"
            rows={lineCount + 1}
          />
        </div>
      )}

      {mode === 'view' && (
        <div className="fwin-view">
          <pre className="fwin-pre">
            {viewSegments
              ? viewSegments.map((seg, i) =>
                  seg.mark
                    ? <mark key={i} className={`fhi ${seg.mark.kind ?? 'info'}`} title={seg.mark.reason}>{seg.text}</mark>
                    : <React.Fragment key={i}>{seg.text}</React.Fragment>,
                )
              : draft}
          </pre>
        </div>
      )}

      {mode === 'diff' && (
        <div className="fdiff">
          {diffClean
            ? <div className="fdiff-clean">no changes vs HEAD — working tree clean</div>
            : rows.map((r, i) => (
                <div key={i} className={`row ${r.t}`}>
                  {r.t === 'add' ? '+ ' : r.t === 'del' ? '− ' : '  '}{r.s}
                </div>
              ))}
        </div>
      )}

      {suggestion && !suggestionDismissed && (
        <div className="fwin-sugg">
          <div className="fwin-sugg-body">
            {suggestion.reason && <div className="fwin-sugg-reason">{suggestion.reason}</div>}
            <div className="fwin-sugg-diff">
              <div className="fwin-sugg-row del">− {suggestion.find}</div>
              <div className="fwin-sugg-row add">+ {suggestion.replace}</div>
            </div>
          </div>
          <div className="fwin-sugg-actions">
            <button className="fbtn" onClick={() => setSuggestionDismissed(true)}>reject</button>
            <button className="fbtn primary" onClick={acceptSuggestion}>accept</button>
          </div>
        </div>
      )}

      <div className="fwin-foot">
        <button
          className="fbtn"
          disabled={!hasAgentMeta && !canDiff}
          onClick={cycleMode}
        >
          {cycleLabel()}
        </button>
        <span className={`fstate ${flash ? 'ok' : dirty ? 'mod' : 'clean'}`}>
          {flash ? 'saved ✓' : dirty ? '● modified' : 'clean'}
        </span>
        <button className="fbtn primary" disabled={!dirty} onClick={save}>save</button>
      </div>
    </>
  )
}
