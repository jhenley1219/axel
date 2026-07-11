// State & logic layer — hooks, derived values, callbacks.
// All rendering is delegated to ConstellationScene (the render tree).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { injectConstellationStyles } from './constellationStyles.js'
import type { FileStar } from './StarSystem.js'
import { ConstellationScene, type CtxMenuState, type PlacedWindow, FILE_W, FILE_H, BOT_SAFE } from './ConstellationScene.js'
import { LabelOverlayProvider } from './LabelOverlay.js'
import type { ContextPick } from './galaxy3d/galaxyScene.js'
import type { ExpandMode } from './ExpandedView.js'
import { splitTermKey } from '../../hooks/messages.js'
import { restingDotHome, visibleChildDirs } from './layout/orbiters.js'
import { type Stage } from './layout/computeLayout.js'
import { useConstellationEngine } from './engine/useConstellationEngine.js'
import { useDragEngine } from './engine/useDragEngine.js'
import { useVoiceInterface } from '../../hooks/useVoiceInterface.js'
import type { PermissionRequest, QuestionRequest } from '../../hooks/useVoiceInterface.js'
import { useConstellationTree } from '../../hooks/useConstellationTree.js'
import type { FsNode, OrbTarget } from '../../types/constellation.js'
import { buildFileStars, type Band } from './fileStars.js'
import { ToolBubbleBar } from './ToolBubbleBar.js'
import { TimerApp } from '../Apps/TimerApp.js'
import { NotesApp } from '../Apps/NotesApp.js'

const TOP_SAFE = 72

type Highlight = { snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }
type Suggestion = { find: string; replace: string; reason?: string }
type OpenFile = {
  path: string; name: string; systemId: string; band: Band; a: number
  // Set when the agent opened this file via its open_file tool (vs. a user click).
  highlights?: Array<Highlight>
  suggestion?: Suggestion
  prompt?: string
}

function newTermId(): string {
  return `t-${Math.random().toString(36).slice(2, 8)}`
}

// Plain-words description of where the orb is anchored, for the root agent's
// system prompt. Anchor-only: which project (or home), no coordinates.
function describeOrbAnchor(t: OrbTarget, nodes: Map<string, FsNode>, rootId: string): string {
  const home = 'resting at "home" — the center of the constellation, the root view of all the projects'
  if (t.type === 'home') return home
  const id = t.type === 'dot' ? t.dirId : t.systemId
  if (!id || id === rootId || id === 'root') return home
  const name = nodes.get(id)?.name
  if (!name) return home
  return t.type === 'dot'
    ? `moving toward the project "${name}"`
    : `over the project "${name}"`
}

export function ConstellationView(): React.ReactElement {
  // No deps: always sync CSS (HMR-friendly)
  useEffect(() => { injectConstellationStyles() })

  const [showSettings, setShowSettings] = useState(false)
  const [expandView,   setExpandView]   = useState<ExpandMode>('none')
  const [chatInput,    setChatInput]    = useState('')
  const [stageSize,    setStageSize]    = useState({ w: 0, h: 0 })
  const [tick,         setTick]         = useState(Date.now())

  // ── View option: flat constellation vs 3D galaxy (persisted) ──────────────
  const [view3d, setView3d] = useState(() => localStorage.getItem('axle-view-3d') === '1')
  const toggleView = useCallback(() => setView3d(v => !v), [])
  useEffect(() => {
    try { localStorage.setItem('axle-view-3d', view3d ? '1' : '0') } catch { /* private mode */ }
  }, [view3d])

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // ── UI-open callback bridge (AxelAgent's ui_open_* wire events) ───────────
  // The voice hook fires these from the WS handler, but `openDir` and the
  // file-open helpers live AFTER it in this component. Refs break the cycle:
  // the hook reads them at message time; the consumer below points them at the
  // real callbacks once available.
  const onUIOpenDirRef  = useRef<(path: string) => void>(() => {})
  const onUIOpenFileRef = useRef<(path: string) => void>(() => {})
  const onUIFocusRootRef = useRef<() => void>(() => {})

  // Where the orb sits, in words — kept current below (orbTarget lives in the
  // tree hook, declared after this) and read at send time inside the voice hook.
  const locationRef = useRef<string>('')

  // ── Voice / AI ────────────────────────────────────────────────────────────
  const voice = useVoiceInterface({
    onUIOpenDir:  path => onUIOpenDirRef.current(path),
    onUIOpenFile: path => onUIOpenFileRef.current(path),
    onUIFocusRoot: () => onUIFocusRootRef.current(),
    getLocation:  () => locationRef.current,
  })
  const {
    orbState, messages, statusMsg, liveTranscript, onTap,
    toolUseEvent, targetMessages, targetStatus, targetSpawnIds, currentTarget,
    fsChangeId,
    tts,
    sendTranscript, setActiveContext, sendDirInput,
    openTerminal, clearTerminal,
    permissionRequests, respondPermission,
    questionRequests, respondQuestion,
    queueItems, unreadTranscripts, readTranscript,
    fileOpenRequests, dismissFileOpenRequest,
    closedDirEvents, dismissClosedDirEvent,
    installedTools, activeInvocations,
    timerState, notesState, dispatchApp,
    clearSession,
    constellationRef, requestUiSnapshot,
  } = voice

  // Which app popup is open (null = none). Click a bubble for a built-in app
  // to toggle its popup; other bubbles fall through to no-op.
  const [openApp, setOpenApp] = useState<'timer' | 'notes' | null>(null)
  const activeApps = useMemo(() => {
    const s = new Set<string>()
    if (timerState) s.add('timer')  // pulses with the timer's accent while a countdown is alive
    return s
  }, [timerState])
  const handleBubbleClick = useCallback((tool: { name: string }): boolean => {
    if (tool.name === 'timer') { setOpenApp(prev => prev === 'timer' ? null : 'timer'); return true }
    if (tool.name === 'notes') { setOpenApp(prev => prev === 'notes' ? null : 'notes'); return true }
    return false
  }, [])

  // ── File-system + session tree ────────────────────────────────────────────
  const tree = useConstellationTree(messages, toolUseEvent, targetMessages, currentTarget, fsChangeId, targetStatus, targetSpawnIds)
  const {
    nodes, openSystems, sessions, tools,
    rootDirId, activeSystemId, orbTarget,
    openDir, closeSystem, closeSystemByTarget, focusSystem, removeSession,
    onCloseDone, onOrbArrived, enterFromOf,
    refreshProjects, refreshMcp, projectsRoot,
  } = tree

  // Mirror the orb's anchor into the ref the voice hook reads at send time.
  useEffect(() => {
    locationRef.current = describeOrbAnchor(orbTarget, nodes, rootDirId)
  }, [orbTarget, nodes, rootDirId])

  // Feed orb/ring state into the observability snapshot and poke a send when it
  // settles. Opens resolve asynchronously (browseDir round-trips), often after
  // the message-driven throttle has already fired — without this poke the
  // recorded snapshot would miss the orb finally landing in the nested ring.
  useEffect(() => {
    constellationRef.current = {
      activeSystemId,
      orbTarget,
      openSystems: openSystems.map(s => ({ dirId: s.dirId, parentSystemId: s.parentSystemId })),
    }
    requestUiSnapshot()
  }, [activeSystemId, orbTarget, openSystems, constellationRef, requestUiSnapshot])

  // ── Engine — single rAF clock, lerped keyframes ───────────────────────────
  const stage = useMemo<Stage>(() => ({
    w: stageSize.w, h: stageSize.h,
    top:    TOP_SAFE + 30,
    bottom: Math.max(stageSize.h - BOT_SAFE - 20, TOP_SAFE + 160),
  }), [stageSize])

  const dotHomeOf = useCallback(
    (parentId: string, childId: string, parentR: number) => restingDotHome(nodes, parentId, childId, parentR),
    [nodes],
  )

  const ringCounts = useMemo(
    () => new Map(openSystems.map(s => {
      const node = nodes.get(s.dirId)
      return [s.dirId, (node?.children?.length ?? 0) + (node?.files?.length ?? 0)]
    })),
    [openSystems, nodes],
  )

  const { rendered, frame, containerRef, orbHostRef } = useConstellationEngine({
    stage, open: openSystems, rootId: rootDirId, orbTarget, ringCounts,
    dotHomeOf, enterFromOf, onCloseDone, onOrbArrive: onOrbArrived,
  })

  // Measure viewport via the same element the engine ref is attached to.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const m = () => setStageSize({ w: el.clientWidth, h: el.clientHeight })
    m()
    const ro = new ResizeObserver(m)
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  // ── Drag engine — declared here so any element in the tree can use it ──────
  const drag = useDragEngine()

  // ── Voice / chat ALWAYS talks to root ─────────────────────────────────────
  // Children are background workers — root delegates to them and reads their
  // terminals via tools. Visual focus (which ring is active) is decoupled
  // from voice routing on purpose: the user can navigate around without the
  // conversation hopping to a sandboxed child agent that can't see anything
  // outside its own directory. Direct typing into a specific terminal tab
  // still works through that tab's prompt bar (handleSessionSend → sendDirInput).
  const effectiveActive = activeSystemId ?? rootDirId
  useEffect(() => { setActiveContext('') }, [setActiveContext])

  // ── Hot path (root → orb's system) ───────────────────────────────────────
  const hotIds = useMemo(() => {
    const ids = new Set<string>()
    let id: string | undefined = orbTarget.type === 'home' ? rootDirId : orbTarget.systemId
    while (id) {
      ids.add(id)
      id = openSystems.find(s => s.dirId === id)?.parentSystemId
    }
    return ids
  }, [orbTarget, openSystems, rootDirId])

  const openIds = useMemo(() => new Set(openSystems.map(s => s.dirId)), [openSystems])

  const sendChat = useCallback(() => {
    const t = chatInput.trim(); if (!t) return; setChatInput(''); sendTranscript(t)
  }, [chatInput, sendTranscript])

  // ── Session focus queue ────────────────────────────────────────────────────
  // Tracks which systems are waiting for AI attention. Clicking the mini-orb
  // on a terminal window either immediately focuses (if idle) or enqueues.
  // Tapping the main orb pops the queue before toggling voice.
  type QueueEntry = { systemId: string; label: string }
  const [focusQueue, setFocusQueue] = useState<Array<QueueEntry>>([])

  const focusQueueIds = useMemo(
    () => new Set(focusQueue.map(e => e.systemId)),
    [focusQueue],
  )

  const systemLabel = useCallback((systemId: string): string => {
    const node = nodes.get(systemId)
    if (!node) return systemId
    return node.path && projectsRoot && node.path.startsWith(projectsRoot)
      ? node.path.slice(projectsRoot.length).replace(/^\/+/, '')
      : node.name
  }, [nodes, projectsRoot])

  // ── Tool-permission routing ────────────────────────────────────────────────
  // Terminal-tagged requests render inside the owning terminal tab; the rest
  // (main session, or a terminal whose window hasn't bloomed yet) surface in
  // the central overlay so a paused agent is never silently waiting.
  const { permsBySess, mainPermissions } = useMemo(() => {
    const bySess = new Map<string, Array<PermissionRequest>>()
    const main: Array<PermissionRequest> = [...(permissionRequests[''] ?? [])]
    for (const [key, reqs] of Object.entries(permissionRequests)) {
      if (!key || reqs.length === 0) continue
      const { target, term } = splitTermKey(key)
      let owner: string | null = null
      for (const s of sessions.values()) {
        if (s.term !== term || systemLabel(s.systemId) !== target) continue
        if (openSystems.some(sys => !sys.closing && sys.dirId === s.systemId)) owner = s.id
        break
      }
      if (owner) bySess.set(owner, reqs)
      else main.push(...reqs)
    }
    return { permsBySess: bySess, mainPermissions: main }
  }, [permissionRequests, sessions, openSystems, systemLabel])

  // Same routing pattern for multiple-choice questions. Terminal-tagged ones
  // render in the owning tab; the rest fall through to the central overlay.
  const { questionsBySess, mainQuestions } = useMemo(() => {
    const bySess = new Map<string, Array<QuestionRequest>>()
    const main: Array<QuestionRequest> = [...(questionRequests[''] ?? [])]
    for (const [key, reqs] of Object.entries(questionRequests)) {
      if (!key || reqs.length === 0) continue
      const { target, term } = splitTermKey(key)
      let owner: string | null = null
      for (const s of sessions.values()) {
        if (s.term !== term || systemLabel(s.systemId) !== target) continue
        if (openSystems.some(sys => !sys.closing && sys.dirId === s.systemId)) owner = s.id
        break
      }
      if (owner) bySess.set(owner, reqs)
      else main.push(...reqs)
    }
    return { questionsBySess: bySess, mainQuestions: main }
  }, [questionRequests, sessions, openSystems, systemLabel])

  // Terminal input goes over the per-dir channel (dir_input) — it echoes into
  // that terminal tab's own transcript and runs on the server's per-terminal
  // queue, concurrent with the main session, other dirs, and the same dir's
  // other tabs. It must NOT steal the main voice context; the mini-orb (queue)
  // button is how a terminal asks for the orb's attention.
  const handleSessionSend = useCallback((systemId: string, term: string, text: string) => {
    sendDirInput(systemLabel(systemId), text, term)
  }, [sendDirInput, systemLabel])

  // ── Terminal tabs — open / select / detach / close ────────────────────────
  const [activeTermTab, setActiveTermTab] = useState<Record<string, string>>({})
  const [detachedSess,  setDetachedSess]  = useState<Set<string>>(new Set())
  const [ctxMenu,       setCtxMenu]       = useState<CtxMenuState | null>(null)
  // Per-detached-session anchor: idx is the slot above/below the tabbed window
  // (frozen at detach time so adding/closing other terminals doesn't shift it);
  // side is which face of the ring it docks on (also frozen at detach time so
  // changing the ring's focus state doesn't fling the window across the screen).
  type DetachAnchor = { idx: number; side: 'above' | 'below' }
  const [detachAnchors, setDetachAnchors] = useState<Map<string, DetachAnchor>>(new Map())
  // Per-dir frozen dock side for the tabbed terminal window. Captured the first
  // time the dir has a session (based on focus at that moment) so later focus
  // flips don't fling the window above↔below its ring. Pruned with the dir's
  // sessions; detached windows freeze their own side via detachAnchors.
  const [tabSide, setTabSide] = useState<Record<string, 'above' | 'below'>>({})
  useEffect(() => {
    setTabSide(prev => {
      const next = { ...prev }
      let changed = false
      const liveDirs = new Set<string>()
      for (const s of sessions.values()) liveDirs.add(s.systemId)
      for (const dir of liveDirs) {
        if (!(dir in next)) { next[dir] = dir === effectiveActive ? 'above' : 'below'; changed = true }
      }
      for (const dir of Object.keys(next)) {
        if (!liveDirs.has(dir)) { delete next[dir]; changed = true }
      }
      return changed ? next : prev
    })
  }, [sessions, effectiveActive])
  // Click-to-raise: most-recently-clicked window goes on top. The list is the
  // raise order — index 0 = oldest raised, last = newest. Windows not in the
  // list use the default base z-index. Capped to avoid the z-index growing into
  // the context menu / overlay layers (see Window.tsx for the calc).
  const [winRaiseOrder, setWinRaiseOrder] = useState<Array<string>>([])
  const raiseWin = useCallback((winId: string) => {
    setWinRaiseOrder(prev => {
      if (prev[prev.length - 1] === winId) return prev
      const next = prev.filter(id => id !== winId)
      next.push(winId)
      // Trim oldest so the level never exceeds 10 (keeps zIndex below the
      // ctx-menu layer at 65). The dropped windows fall back to base z = 5.
      while (next.length > 10) next.shift()
      return next
    })
  }, [])
  // Dir whose ring is opening because of a right-click "open terminal" —
  // the terminal is created once the system exists (ring first, then tab).
  const pendingTermRef = useRef<string | null>(null)

  // The dir's FIRST terminal is 'main' (shared with voice focus and root
  // delegation); later ones get generated ids so each tab is its own session.
  const openTerminalFor = useCallback((dirId: string) => {
    const target = systemLabel(dirId)
    if (!target) return  // root — target '' would route to the main session
    const hasMain = [...sessions.values()].some(s => s.systemId === dirId && s.term === 'main')
    const term = hasMain ? newTermId() : 'main'
    openTerminal(target, term)
    setActiveTermTab(prev => ({ ...prev, [dirId]: term }))
  }, [systemLabel, sessions, openTerminal])

  // Right-clicked a closed dot → ring is opening; create the tab on arrival.
  useEffect(() => {
    const dirId = pendingTermRef.current
    if (!dirId) return
    if (openSystems.some(s => s.dirId === dirId && !s.closing)) {
      pendingTermRef.current = null
      openTerminalFor(dirId)
    }
  }, [openSystems, openTerminalFor])

  const handleSelectTermTab = useCallback((systemId: string, term: string) => {
    setActiveTermTab(prev => ({ ...prev, [systemId]: term }))
  }, [])

  const handleDetachSess = useCallback((sessId: string) => {
    setDetachedSess(prev => {
      const wasDetached = prev.has(sessId)
      const next = new Set(prev)
      if (wasDetached) next.delete(sessId)
      else next.add(sessId)
      // Anchor lifecycle: assign a stable slot+side on detach so future
      // attaches/detaches in the same ring don't restack this window. Clear it
      // when re-attaching so the next detach starts fresh.
      setDetachAnchors(prevAnchors => {
        const nextAnchors = new Map(prevAnchors)
        if (wasDetached) { nextAnchors.delete(sessId); return nextAnchors }
        const sess = sessions.get(sessId)
        if (!sess) return prevAnchors
        // Highest existing idx in this same ring + 1; tabbed window takes slot
        // 0 conceptually (even when it's currently empty), so detached start at 1.
        let maxIdx = 0
        for (const [otherId, anchor] of prevAnchors) {
          const other = sessions.get(otherId)
          if (other?.systemId === sess.systemId && anchor.idx > maxIdx) maxIdx = anchor.idx
        }
        const side: 'above' | 'below' = sess.systemId === effectiveActive ? 'above' : 'below'
        nextAnchors.set(sessId, { idx: maxIdx + 1, side })
        return nextAnchors
      })
      return next
    })
  }, [sessions, effectiveActive])

  // Prune detachAnchors when sessions disappear (ring closed, session closed
  // without going through handleCloseSess). Cheap O(n) scan keyed on the map's
  // identity — only runs when the sessions map actually changes.
  useEffect(() => {
    setDetachAnchors(prev => {
      let changed = false
      const next = new Map(prev)
      for (const id of prev.keys()) {
        if (!sessions.has(id)) { next.delete(id); changed = true }
      }
      return changed ? next : prev
    })
    setWinRaiseOrder(prev => {
      // winIds are either `tw-${dirId}` or a sessId. Drop entries whose owner
      // (session or tabbed-dir) is gone.
      const liveDirs = new Set([...sessions.values()].map(s => s.systemId))
      const next = prev.filter(id =>
        id.startsWith('tw-') ? liveDirs.has(id.slice(3)) : sessions.has(id),
      )
      return next.length === prev.length ? prev : next
    })
  }, [sessions])

  const handleCloseSess = useCallback((sessId: string) => {
    const sess = sessions.get(sessId)
    const key = removeSession(sessId)
    if (key) clearTerminal(key)
    setDetachedSess(prev => {
      if (!prev.has(sessId)) return prev
      const next = new Set(prev)
      next.delete(sessId)
      return next
    })
    if (sess) {
      setActiveTermTab(prev => {
        if (prev[sess.systemId] !== sess.term) return prev
        const { [sess.systemId]: _gone, ...rest } = prev
        return rest
      })
    }
  }, [sessions, removeSession, clearTerminal])

  // Mini-orb queue: only moves visual focus to the requested ring. Voice
  // routing is unaffected — every conversation goes to root.
  const handleSessionQueue = useCallback((systemId: string) => {
    if (orbState === 'idle') {
      focusSystem(systemId)
    } else {
      setFocusQueue(prev =>
        prev.some(e => e.systemId === systemId)
          ? prev
          : [...prev, { systemId, label: systemLabel(systemId) }],
      )
    }
  }, [orbState, focusSystem, systemLabel])

  // Orb tap: drain queue (visual focus only), then toggle voice
  const handleOrbTap = useCallback(() => {
    if (focusQueue.length > 0) {
      const [next, ...rest] = focusQueue
      setFocusQueue(rest)
      focusSystem(next.systemId)
    }
    onTap()
  }, [focusQueue, onTap, focusSystem])

  // ── Open files — spec §3.6 ────────────────────────────────────────────────
  const [openFiles,  setOpenFiles]  = useState<Array<OpenFile>>([])
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())

  const closeTab = useCallback((path: string) => {
    const closing = openFiles.find(o => o.path === path)
    const next    = openFiles.filter(o => o.path !== path)
    setOpenFiles(next)
    if (closing && activeTabs[closing.systemId] === path) {
      const sibling = next.filter(o => o.systemId === closing.systemId).pop()
      setActiveTabs(prev => {
        const copy = { ...prev }
        if (sibling) copy[closing.systemId] = sibling.path
        else delete copy[closing.systemId]
        return copy
      })
    }
  }, [openFiles, activeTabs])

  const handleFileClick = useCallback((f: FileStar, systemId: string) => {
    if (openFiles.some(o => o.path === f.path)) {
      if (activeTabs[systemId] === f.path) closeTab(f.path)
      else setActiveTabs(prev => ({ ...prev, [systemId]: f.path }))
      return
    }
    let next = [...openFiles, { path: f.path, name: f.n, systemId, band: f.band, a: f.a }]
    const sysOrder = [...new Set(next.map(o => o.systemId))]
    if (sysOrder.length > 2) next = next.filter(o => o.systemId !== sysOrder[0])
    setOpenFiles(next)
    setActiveTabs(prev => ({ ...prev, [systemId]: f.path }))
  }, [openFiles, activeTabs, closeTab])

  const handleFileDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths(prev => {
      if (prev.has(path) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(path); else next.delete(path)
      return next
    })
  }, [])

  // ── Wire the UI-open refs the voice hook reads from ───────────────────────
  // Dir: same action as a left-click on an unopened orbiter — openDir from the
  // dir's parent ring so the inflate animation reads correctly.
  // File: if its parent dir already has an open system, run the same logic as
  // a star click; otherwise open the parent dir (MVP — file-after-dir staging
  // is a future iteration).
  const parentOf = useCallback((childId: string): string | undefined => {
    for (const n of nodes.values()) {
      if (n.kind === 'dir' && n.children?.includes(childId)) return n.id
    }
    return undefined
  }, [nodes])

  useEffect(() => {
    onUIFocusRootRef.current = () => focusSystem(rootDirId)
    onUIOpenDirRef.current = (path: string) => {
      for (const node of nodes.values()) {
        if (node.kind !== 'dir' || node.path !== path) continue
        if (openIds.has(node.id)) { focusSystem(node.id); return }
        openDir(node.id, parentOf(node.id) ?? rootDirId)
        return
      }
    }
    onUIOpenFileRef.current = (path: string) => {
      for (const sys of openSystems) {
        if (sys.closing) continue
        const node = nodes.get(sys.dirId)
        const file = node?.files?.find(f => f.path === path)
        if (!file) continue
        const star = buildFileStars(node!, 1).find(s => s.path === path)
        if (star) handleFileClick(star, sys.dirId)
        return
      }
      const parent = [...nodes.values()].find(
        n => n.kind === 'dir' && n.files?.some(f => f.path === path),
      )
      if (parent) openDir(parent.id, parentOf(parent.id) ?? rootDirId)
    }
  }, [nodes, openSystems, openIds, openDir, focusSystem, rootDirId, parentOf, handleFileClick])

  // A closing ring takes its file window with it
  useEffect(() => {
    setOpenFiles(prev => {
      const live = new Set(openSystems.filter(s => !s.closing).map(s => s.dirId))
      const next = prev.filter(o => live.has(o.systemId))
      return next.length === prev.length ? prev : next
    })
  }, [openSystems])

  // Agent → UI open_file: drop each request into openFiles, docked under the
  // open ring whose dir is the longest path-prefix of the file (fallback: the
  // root ring). Re-opening an already-open path replaces it so new highlights
  // overwrite stale ones. Pure UI surfacing — no permission gate (the agent
  // already passed Read/Write checks to know about the file).
  useEffect(() => {
    if (fileOpenRequests.length === 0) return
    for (const req of fileOpenRequests) {
      let bestSysId = rootDirId
      let bestLen   = -1
      for (const sys of openSystems) {
        if (sys.closing) continue
        const np = nodes.get(sys.dirId)?.path
        if (np && (req.path === np || req.path.startsWith(np + '/')) && np.length > bestLen) {
          bestSysId = sys.dirId
          bestLen   = np.length
        }
      }
      const name = req.path.split('/').filter(Boolean).pop() ?? req.path
      setOpenFiles(prev => {
        const without = prev.filter(o => o.path !== req.path)
        // Default 'code' band — band/a are layout breadcrumbs the open-window
        // path doesn't actually read after construction, so placeholders are fine.
        return [...without, {
          path: req.path, name, systemId: bestSysId, band: 'code' as Band, a: 0,
          highlights: req.highlights,
          suggestion: req.suggestion,
          prompt:     req.prompt,
        }]
      })
      setActiveTabs(prev => ({ ...prev, [bestSysId]: req.path }))
      dismissFileOpenRequest(req.id)
    }
  }, [fileOpenRequests, openSystems, nodes, rootDirId, dismissFileOpenRequest])

  // Drain dir_closed events from the agent's close_idle_dirs sweep. Each one
  // triggers the same close animation as a user-driven close on the ring.
  useEffect(() => {
    if (closedDirEvents.length === 0) return
    for (const ev of closedDirEvents) {
      closeSystemByTarget(ev.target)
      dismissClosedDirEvent(ev.id)
    }
  }, [closedDirEvents, closeSystemByTarget, dismissClosedDirEvent])

  const openFilePaths = useMemo(() => new Set(openFiles.map(o => o.path)), [openFiles])

  // ── Build PlacedWindow array ───────────────────────────────────────────────
  const W = stageSize.w
  const rootLay  = rendered.get(rootDirId)
  const drifting = Math.hypot(frame.drift.x, frame.drift.y) > 8

  const winPlaced = useMemo<Array<PlacedWindow>>(() => {
    const order: Array<string> = []
    const bySys = new Map<string, Array<OpenFile>>()
    for (const o of openFiles) {
      const list = bySys.get(o.systemId)
      if (list) list.push(o)
      else { bySys.set(o.systemId, [o]); order.push(o.systemId) }
    }
    const sideCounts = { left: 0, right: 0 }
    return order.map(systemId => {
      const files  = bySys.get(systemId)!
      const lay    = rendered.get(systemId)
      const side: 'left' | 'right' = (lay?.cx ?? W) < W / 2 ? 'left' : 'right'
      const slot   = sideCounts[side]++
      const active = files.find(o => o.path === activeTabs[systemId]) ?? files[files.length - 1]
      return {
        systemId,
        files,
        side,
        x: side === 'left' ? 18 + FILE_W / 2 : W - 18 - FILE_W / 2,
        y: TOP_SAFE + 24 + FILE_H / 2 + slot * (FILE_H + 16),
        active,
      }
    })
  }, [openFiles, activeTabs, rendered, W])

  // ── Orbiter click — grow from the exact star that was clicked (no event in
  //    the 3D view: the engine falls back to the parent's resting dot) ────────
  const handleOrbiterClick = useCallback(
    (name: string, fromSystemId: string, ev?: React.MouseEvent | React.KeyboardEvent) => {
      const match = visibleChildDirs(nodes, fromSystemId)
        .find(d => d.name.toLowerCase() === name.toLowerCase())
      if (!match || openIds.has(match.id)) return
      const sr   = containerRef.current?.getBoundingClientRect()
      const rect = ev ? (ev.currentTarget as HTMLElement).getBoundingClientRect() : undefined
      const pt   = sr && rect
        ? { x: rect.left + rect.width / 2 - sr.left, y: rect.top + rect.height / 2 - sr.top }
        : undefined
      openDir(match.id, fromSystemId, pt)
    },
    [nodes, openIds, openDir, containerRef],
  )

  // ── Right-click menus ──────────────────────────────────────────────────────
  // Closed dot: "open terminal" opens the ring exactly like a left-click,
  // then creates the terminal once the system exists (sequential). Open ring:
  // the terminal tab is created immediately.
  const handleOrbiterContext = useCallback(
    (name: string, fromSystemId: string, ev: React.MouseEvent) => {
      const match = visibleChildDirs(nodes, fromSystemId)
        .find(d => d.name.toLowerCase() === name.toLowerCase())
      if (!match) return
      const sr = containerRef.current?.getBoundingClientRect()
      const x  = ev.clientX - (sr?.left ?? 0)
      const y  = ev.clientY - (sr?.top ?? 0)
      if (openIds.has(match.id)) {
        setCtxMenu({ x, y, title: match.name, items: [
          { label: 'open terminal', onClick: () => openTerminalFor(match.id) },
        ] })
        return
      }
      // Captured NOW — currentTarget is gone by the time the item is clicked.
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
      const pt   = sr
        ? { x: rect.left + rect.width / 2 - sr.left, y: rect.top + rect.height / 2 - sr.top }
        : undefined
      setCtxMenu({ x, y, title: match.name, items: [
        { label: 'open terminal', onClick: () => {
          pendingTermRef.current = match.id
          openDir(match.id, fromSystemId, pt)
        } },
      ] })
    },
    [nodes, openIds, openDir, openTerminalFor, containerRef],
  )

  const handleRingContext = useCallback(
    (systemId: string, ev: React.MouseEvent) => {
      const sr = containerRef.current?.getBoundingClientRect()
      setCtxMenu({
        x: ev.clientX - (sr?.left ?? 0),
        y: ev.clientY - (sr?.top ?? 0),
        title: systemLabel(systemId),
        items: [{ label: 'open terminal', onClick: () => openTerminalFor(systemId) }],
      })
    },
    [systemLabel, openTerminalFor, containerRef],
  )

  // Galaxy-3D right-click: the scene raycasts and hands us a typed pick + the
  // viewport-relative client coords. We translate those into the same
  // CtxMenuState 2D uses so a single <ContextMenu> renders for both modes.
  const handleGalaxyContext = useCallback(
    (pick: ContextPick, clientX: number, clientY: number) => {
      const sr = containerRef.current?.getBoundingClientRect()
      const x  = clientX - (sr?.left ?? 0)
      const y  = clientY - (sr?.top ?? 0)
      if (pick.kind === 'dir') {
        // Root is excluded for the same reason as 2D — openTerminalFor early-
        // returns on an empty target (it would route to the main session).
        if (pick.dirId === rootDirId) return
        setCtxMenu({
          x, y, title: systemLabel(pick.dirId),
          items: [{ label: 'open terminal', onClick: () => openTerminalFor(pick.dirId) }],
        })
      } else if (pick.kind === 'subdir') {
        const match = visibleChildDirs(nodes, pick.dirId)
          .find(d => d.name.toLowerCase() === pick.name.toLowerCase())
        if (!match) return
        if (openIds.has(match.id)) {
          setCtxMenu({ x, y, title: match.name, items: [
            { label: 'open terminal', onClick: () => openTerminalFor(match.id) },
          ] })
          return
        }
        // 3D scene has no DOM rect for the picked orbiter — pass undefined so
        // the engine falls back to the parent's resting-dot angle (same as the
        // keyboard path in handleOrbiterClick).
        setCtxMenu({ x, y, title: match.name, items: [
          { label: 'open terminal', onClick: () => {
            pendingTermRef.current = match.id
            openDir(match.id, pick.dirId)
          } },
        ] })
      }
      // file / agent picks: no menu (matches 2D: files have no right-click handler)
    },
    [rootDirId, systemLabel, openTerminalFor, nodes, openIds, openDir, containerRef],
  )

  return (
    <LabelOverlayProvider>
    <ToolBubbleBar
      tools={installedTools}
      activeInvocations={activeInvocations}
      activeApps={activeApps}
      onBubbleClick={handleBubbleClick}
    />
    {openApp === 'timer' && (
      <TimerApp
        state={timerState}
        onDispatch={(action, payload) => dispatchApp('timer', action, payload)}
        onClose={() => setOpenApp(null)}
      />
    )}
    {openApp === 'notes' && (
      <NotesApp
        state={notesState}
        onDispatch={(action, payload) => dispatchApp('notes', action, payload)}
        onClose={() => setOpenApp(null)}
      />
    )}
    <ConstellationScene
      w={W} h={stageSize.h}
      containerRef={containerRef}
      orbHostRef={orbHostRef}
      rendered={rendered}
      frame={frame}
      drifting={drifting}
      rootLay={rootLay}
      openSystems={openSystems}
      nodes={nodes}
      sessions={sessions}
      tools={tools}
      rootDirId={rootDirId}
      effectiveActive={effectiveActive}
      hotIds={hotIds}
      openIds={openIds}
      projectsRoot={projectsRoot}
      openFilePaths={openFilePaths}
      dirtyPaths={dirtyPaths}
      winPlaced={winPlaced}
      orbState={orbState}
      messages={messages}
      statusMsg={statusMsg}
      liveTranscript={liveTranscript}
      chatInput={chatInput}
      tick={tick}
      showSettings={showSettings}
      expandView={expandView}
      drag={drag}
      view3d={view3d}
      onToggleView={toggleView}
      orbTarget={orbTarget}
      tts={tts}
      onOrbiterClick={handleOrbiterClick}
      onOrbiterContext={handleOrbiterContext}
      onRingContext={handleRingContext}
      onGalaxyContext={handleGalaxyContext}
      onFileClick={handleFileClick}
      onFileDirty={handleFileDirty}
      onFocusSystem={focusSystem}
      onCloseSystem={closeSystem}
      onSelectTab={(systemId, path) => setActiveTabs(prev => ({ ...prev, [systemId]: path }))}
      onCloseTab={closeTab}
      onTap={handleOrbTap}
      setChatInput={setChatInput}
      onSendChat={sendChat}
      onExpandView={setExpandView}
      onOpenSettings={() => setShowSettings(true)}
      onCloseSettings={() => setShowSettings(false)}
      onNewSession={clearSession}
      onProjectsRefresh={refreshProjects}
      onMcpRefresh={refreshMcp}
      ctxMenu={ctxMenu}
      onCloseCtxMenu={() => setCtxMenu(null)}
      onSessionSend={handleSessionSend}
      onSessionQueue={handleSessionQueue}
      focusQueueIds={focusQueueIds}
      detachedSess={detachedSess}
      detachAnchors={detachAnchors}
      tabSide={tabSide}
      winRaiseOrder={winRaiseOrder}
      onRaiseWin={raiseWin}
      activeTermTab={activeTermTab}
      onSelectTermTab={handleSelectTermTab}
      onNewTerminal={openTerminalFor}
      onDetachSess={handleDetachSess}
      onCloseSess={handleCloseSess}
      permsBySess={permsBySess}
      mainPermissions={mainPermissions}
      onPermission={respondPermission}
      questionsBySess={questionsBySess}
      mainQuestions={mainQuestions}
      onQuestion={respondQuestion}
      queueItems={queueItems}
      unreadTranscripts={unreadTranscripts}
      onReadTranscript={readTranscript}
    />
    </LabelOverlayProvider>
  )
}
