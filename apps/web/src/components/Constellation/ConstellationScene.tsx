// Centralized render tree for the constellation canvas. Receives all
// pre-computed state from ConstellationView (the logic layer) and renders the
// full visual hierarchy. No state or side-effects live here.
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VoiceOrb } from '../Voice/VoiceOrb.js'
import { VoiceHelp } from '../Voice/VoiceHelp.js'
import { SettingsPanel } from '../Settings/SettingsPanel.js'
import { StarSystem, type FileStar, type Orbiter } from './StarSystem.js'
import { SessionWin, SWIN_TAB_W, SWIN_TAB_H, SWIN_DETACH_W, SWIN_DETACH_H } from './SessionWin.js'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js'
import { ExpandedView, type ExpandMode } from './ExpandedView.js'
import { FilePopup } from './FilePopup.js'
import { FilePicker } from './FilePicker.js'
import { ToolStrip, toolPos } from './ToolStrip.js'
import { dotColor } from './fileStars.js'
import { buildCloud2D, cloudTint } from './cloud.js'
import { tetherEnds } from './layout/geo.js'
import { orbiterPlacements, ringPlan, ringRadii, visibleChildDirs } from './layout/orbiters.js'
import { labelCapacity, uniqueLabels } from './layout/labels.js'
import { FILE_TYPE_COLORS, extToFileType } from '../../types/constellation.js'
import type { FileEntry } from '@axel/core'
import { Galaxy3D } from './galaxy3d/Galaxy3D.js'
import type { ContextPick, FileTetherEnd, RingAnchor } from './galaxy3d/galaxyScene.js'
import type { AnimState } from './engine/useConstellationEngine.js'
import type { LayoutFrame } from './layout/computeLayout.js'
import type { DragEngine } from './engine/useDragEngine.js'
import type { OpenSystem, FsNode, Session, ToolNode, OrbTarget } from '../../types/constellation.js'
import type { Message } from '../../hooks/messages.js'
import type { PermissionRequest, QuestionRequest } from '../../hooks/useVoiceInterface.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { QueueMenu } from './QueueMenu.js'
import { QuestionPrompt } from './QuestionPrompt.js'
import type { TtsControls } from '../../hooks/useTtsEngine.js'
import type { OrbState } from '../Voice/VoiceOrb.js'
import type { Band } from './fileStars.js'

// ── Visual constants (presentation layer owns these) ───────────────────────
export const FILE_W  = 372
export const FILE_H  = 352
export const BOT_SAFE = 100

const OrbCore = React.memo(VoiceOrb)

// ── Types exposed to the logic layer ──────────────────────────────────────
export type PlacedFile = {
  path: string; name: string; band: Band; a: number
  // Present when the agent surfaced this file via its open_file tool.
  highlights?: Array<{ snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }>
  suggestion?: { find: string; replace: string; reason?: string }
  prompt?: string
}

export type PlacedWindow = {
  systemId: string
  files: Array<PlacedFile>
  side: 'left' | 'right'
  x: number
  y: number
  active: PlacedFile
}

export type CtxMenuState = { x: number; y: number; title: string; items: Array<ContextMenuItem> }

type SceneProps = {
  // Viewport
  w: number
  h: number
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  orbHostRef:   React.MutableRefObject<HTMLDivElement | null>
  // Engine output
  rendered: Map<string, AnimState>
  frame:    LayoutFrame
  drifting: boolean
  rootLay:  AnimState | undefined
  // Tree
  openSystems: Array<OpenSystem>
  nodes:       Map<string, FsNode>
  sessions:    Map<string, Session>
  tools:       Array<ToolNode>
  rootDirId:   string
  effectiveActive: string
  hotIds:   Set<string>
  openIds:  Set<string>
  projectsRoot: string | null
  // Files
  openFilePaths: Set<string>
  dirtyPaths:    Set<string>
  winPlaced:     Array<PlacedWindow>
  // Orb + voice
  orbState:      OrbState
  messages:      Array<Message>
  statusMsg:     string
  liveTranscript: string
  // Chat + ui
  chatInput:    string
  tick:         number
  showSettings: boolean
  expandView:   ExpandMode
  drag:         DragEngine
  // 3D galaxy view (alternate render skin; 2D engine stays the state authority)
  view3d:       boolean
  onToggleView: () => void
  orbTarget:    OrbTarget
  // Settings
  tts: TtsControls
  // Handlers
  onOrbiterClick: (name: string, systemId: string, ev?: React.MouseEvent | React.KeyboardEvent) => void
  onOrbiterContext: (name: string, systemId: string, ev: React.MouseEvent) => void
  onRingContext:    (systemId: string, ev: React.MouseEvent) => void
  onGalaxyContext:  (pick: ContextPick, clientX: number, clientY: number) => void
  onFileClick:    (f: FileStar, systemId: string) => void
  onFileDirty:    (path: string, dirty: boolean) => void
  onFocusSystem:  (id: string) => void
  onCloseSystem:  (id: string) => void
  onSelectTab:    (systemId: string, path: string) => void
  onCloseTab:     (path: string) => void
  onTap:          () => void
  setChatInput:   (v: string) => void
  onSendChat:     () => void
  onExpandView:   (mode: ExpandMode) => void
  onOpenSettings:    () => void
  onCloseSettings:   () => void
  onNewSession:      () => void
  onProjectsRefresh: () => void
  onMcpRefresh:      () => void
  // Context menu
  ctxMenu:       CtxMenuState | null
  onCloseCtxMenu: () => void
  // Session window interactions
  onSessionSend:  (systemId: string, term: string, text: string) => void
  onSessionQueue: (systemId: string) => void
  focusQueueIds:  Set<string>
  // Terminal tabs
  detachedSess:    Set<string>
  // Per-detached-session frozen slot/side so additions and focus flips don't
  // shift an already-positioned window (see ConstellationView for lifecycle).
  detachAnchors:   Map<string, { idx: number; side: 'above' | 'below' }>
  // Per-dir frozen dock side for the tabbed window — same purpose as
  // detachAnchors.side: focusing/defocusing the ring must not fling it across
  // the screen. Set on first appearance, pruned with the dir's sessions.
  tabSide:         Record<string, 'above' | 'below'>
  // Click-to-raise: ordered list of recently raised winIds (oldest first).
  // A window's level is its 1-indexed position; absent → level 0 (base z).
  winRaiseOrder:   Array<string>
  onRaiseWin:      (winId: string) => void
  activeTermTab:   Record<string, string>
  onSelectTermTab: (systemId: string, term: string) => void
  onNewTerminal:   (systemId: string) => void
  onDetachSess:    (sessId: string) => void
  onCloseSess:     (sessId: string) => void
  // Tool-permission approvals
  permsBySess:     Map<string, Array<PermissionRequest>>
  mainPermissions: Array<PermissionRequest>
  onPermission:    (id: string, behavior: 'allow' | 'deny') => void
  // Multiple-choice questions from the agent
  questionsBySess: Map<string, Array<QuestionRequest>>
  mainQuestions:   Array<QuestionRequest>
  onQuestion:      (id: string, choice: number | 'cancel') => void
  // Sub-agent queue items — drives the per-system pending badge.
  queueItems:      Array<{ id: string; fromTarget: string; fromTerm?: string; kind: 'proposal' | 'question' | 'confirmation'; prompt: string; options?: Array<string>; claimed: boolean }>
  // Background-terminal transcripts waiting to be read aloud — surfaced as
  // clickable rows in the QueueMenu so the user doesn't have to remember the
  // "read the transcript" catchphrase.
  unreadTranscripts: Array<{ target: string; term: string; key: string }>
  onReadTranscript:  (entry: { target: string; term: string; key: string }) => void
}

export function ConstellationScene({
  w, h, containerRef, orbHostRef,
  rendered, frame, drifting, rootLay,
  openSystems, nodes, sessions, tools,
  rootDirId, effectiveActive, hotIds, openIds, projectsRoot,
  openFilePaths, dirtyPaths, winPlaced,
  orbState, messages, statusMsg, liveTranscript,
  chatInput, tick, showSettings, expandView, drag,
  view3d, onToggleView, orbTarget, tts,
  onOrbiterClick, onOrbiterContext, onRingContext, onGalaxyContext, onFileClick, onFileDirty,
  onFocusSystem, onCloseSystem, onSelectTab, onCloseTab,
  onTap, setChatInput, onSendChat, onExpandView, onOpenSettings, onCloseSettings, onNewSession,
  onProjectsRefresh, onMcpRefresh,
  ctxMenu, onCloseCtxMenu,
  onSessionSend, onSessionQueue, focusQueueIds,
  detachedSess, detachAnchors, tabSide, winRaiseOrder, onRaiseWin,
  activeTermTab, onSelectTermTab, onNewTerminal, onDetachSess, onCloseSess,
  permsBySess, mainPermissions, onPermission,
  questionsBySess, mainQuestions, onQuestion,
  queueItems, unreadTranscripts, onReadTranscript,
}: SceneProps): React.ReactElement {
  // Group pending queue items by sender dir so each star can render its own
  // badge. Claimed items still count as "in progress" — the badge stays lit
  // until the root agent resolves them.
  const queuePendingByDir = useMemo(() => {
    const out: Record<string, number> = {}
    for (const item of queueItems) {
      out[item.fromTarget] = (out[item.fromTarget] ?? 0) + 1
    }
    return out
  }, [queueItems])
  // Open file-picker — one at a time, anchored to the ring that was clicked.
  // Coords are container-relative (.gc is the positioning context).
  const [pickerSys, setPickerSys] = useState<{ id: string; x: number; y: number } | null>(null)
  const closePicker = (): void => setPickerSys(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [confirmNewSession, setConfirmNewSession] = useState(false)
  const queueCount = unreadTranscripts.length + queueItems.length
  // Sarter & Woods (1995) — the orb's state should not be carried by animation
  // alone. A short text label under the chat dock names the mode in plain
  // words; hidden when idle to avoid visual clutter.
  const ORB_MODE_LABEL: Record<OrbState, string> = {
    idle:         '',
    listening:    'listening…',
    transcribing: 'transcribing…',
    thinking:     'thinking…',
    responding:   'speaking — tap orb to interrupt',
  }
  const orbModeLabel = ORB_MODE_LABEL[orbState] ?? ''
  // Open the picker for `id` at the given viewport-relative click point,
  // clamped so the full popover stays on screen. The picker has fixed
  // width and a max height (see .file-picker CSS); we use those as upper
  // bounds — small dirs may shift up further than strictly needed, but the
  // visual cost is a few extra px of margin, not clipped content.
  const PICKER_W = 240
  const PICKER_H_MAX = 340
  const PICKER_M = 8
  const openPickerAt = (id: string, clientX: number, clientY: number): void => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const node = nodes.get(id)
    if ((node?.files?.length ?? 0) === 0) return
    let x = clientX - rect.left
    let y = clientY - rect.top
    if (x + PICKER_W + PICKER_M > rect.width)      x = Math.max(PICKER_M, rect.width  - PICKER_W     - PICKER_M)
    if (y + PICKER_H_MAX + PICKER_M > rect.height) y = Math.max(PICKER_M, rect.height - PICKER_H_MAX - PICKER_M)
    setPickerSys({ id, x, y })
  }

  // Terminal windows hang above (focused) / below (unfocused) their ring; each
  // tethers to the ring's center circle so its source system is unambiguous.
  // Attached sessions share ONE tabbed window per dir; split-out (detached)
  // sessions get their own standalone windows stacked after it. In 3D mode
  // the window is positioned at (0, 0) inside an anchor wrapper whose
  // transform is mutated each frame by the 3D scene; `offsetY` controls its
  // screen-space distance from the projected ring center.
  type SessWin = {
    winId: string; dirId: string
    sessList: Array<Session>; active: Session
    detached: boolean
    x: number; y: number
    cx: number; cy: number     // 2D tether origin (ring center)
    offsetY: number            // 3D anchor offset from projected ring center
    focus: boolean
  }
  // Keep a 2D window's center inside the viewport so edge-tethered or stacked
  // terminals never render off-screen (mirrors the file-picker clamp above).
  // Windows are center-positioned (translate(-50%,-50%)), so the center is
  // bounded by half the window plus a margin; the inner Math.max guards the
  // degenerate case where the window is wider/taller than the viewport.
  const clampWinPos = (cx0: number, cy0: number, winW: number, winH: number): { x: number; y: number } => {
    const m = 8
    const hw = winW / 2, hh = winH / 2
    return {
      x: Math.min(Math.max(cx0, hw + m), Math.max(hw + m, w - hw - m)),
      y: Math.min(Math.max(cy0, hh + m), Math.max(hh + m, h - hh - m)),
    }
  }
  const sessWins: Array<SessWin> = openSystems.filter(s => !s.closing).flatMap(sys => {
    const lay = rendered.get(sys.dirId)
    if (!lay && !view3d) return []
    const focus = sys.dirId === effectiveActive
    const all = sys.sessions
      .map(id => sessions.get(id))
      .filter((s): s is Session => s !== undefined)
    if (all.length === 0) return []
    const attached = all.filter(s => !detachedSess.has(s.id))
    const split    = all.filter(s =>  detachedSess.has(s.id))

    // Slot → screen offset. `side` decides above-vs-below the ring; for the
    // tabbed window it tracks the ring's current focus state, but for detached
    // windows it's frozen at detach time (see detachAnchors).
    const yOf2D = (idx: number, side: 'above' | 'below'): number => side === 'above'
      ? lay!.cy - lay!.r - 18 - idx * 195
      : lay!.cy + lay!.r + 12 + 44 + idx * 195
    // 3D: ring radius is in world units; approximate ring screen-clearance
    // with a fixed pixel margin. Same stacking math, screen-relative.
    const offY3D = (idx: number, side: 'above' | 'below'): number =>
      side === 'above' ? -110 - idx * 195 : 110 + idx * 195

    const wins: Array<SessWin> = []
    if (attached.length > 0) {
      const wantTerm = activeTermTab[sys.dirId]
      const active = attached.find(s => s.term === wantTerm)
        ?? attached.find(s => s.term === 'main')
        ?? attached[attached.length - 1]
      // Tabbed window sits in slot 0. Its dock side is frozen on first
      // appearance (tabSide) so focusing/defocusing the ring doesn't fling it
      // across the screen; fall back to live focus before the freeze lands.
      const side: 'above' | 'below' = tabSide[sys.dirId] ?? (focus ? 'above' : 'below')
      const pos = view3d ? { x: 0, y: 0 } : clampWinPos(lay!.cx, yOf2D(0, side), SWIN_TAB_W, SWIN_TAB_H)
      wins.push({
        winId: `tw-${sys.dirId}`, dirId: sys.dirId,
        sessList: attached, active, detached: false,
        x: pos.x, y: pos.y,
        cx: lay?.cx ?? 0, cy: lay?.cy ?? 0,
        offsetY: offY3D(0, side), focus,
      })
    }
    for (const d of split) {
      // Frozen slot+side from detach time — invariant under partition changes
      // (attached/split mix shifting) and focus flips on the parent ring.
      const anchor = detachAnchors.get(d.id)
      const idx  = anchor?.idx ?? 1
      const side = anchor?.side ?? (focus ? 'above' : 'below')
      const pos = view3d ? { x: 0, y: 0 } : clampWinPos(lay!.cx, yOf2D(idx, side), SWIN_DETACH_W, SWIN_DETACH_H)
      wins.push({
        winId: d.id, dirId: sys.dirId,
        sessList: [d], active: d, detached: true,
        x: pos.x, y: pos.y,
        cx: lay?.cx ?? 0, cy: lay?.cy ?? 0,
        offsetY: offY3D(idx, side), focus,
      })
    }
    return wins
  })

  // A tab is "needs attention" if it has a pending permission OR a pending
  // question. Same dot indicator covers both so the user has one thing to scan.
  const permTabIds = new Set([
    ...[...permsBySess].filter(([, v]) => v.length > 0).map(([k]) => k),
    ...[...questionsBySess].filter(([, v]) => v.length > 0).map(([k]) => k),
  ])

  // Terminal windows render in both 2D and 3D, so per-session permission
  // prompts always live in the owning tab; only the main-session overlay
  // surfaces here.
  const overlayPerms = mainPermissions

  // ── 3D anchor wiring ──────────────────────────────────────────────────────
  // Each terminal window in 3D mode is wrapped in an absolutely-positioned div
  // whose transform is mutated each frame by the 3D scene to track its ring's
  // projected screen center. Refs collected here, list passed to Galaxy3D.
  const winAnchorRefs = useRef<Map<string, HTMLElement | null>>(new Map())
  const [ringAnchorList, setRingAnchorList] = useState<Array<RingAnchor>>([])
  const anchorKey = view3d
    ? sessWins.map(sw => `${sw.winId}:${sw.dirId}:${sw.offsetY}`).join('|')
    : ''
  useLayoutEffect(() => {
    if (!view3d) {
      setRingAnchorList(prev => (prev.length === 0 ? prev : []))
      return
    }
    const liveIds = new Set(sessWins.map(sw => sw.winId))
    for (const id of [...winAnchorRefs.current.keys()]) {
      if (!liveIds.has(id)) winAnchorRefs.current.delete(id)
    }
    const next: Array<RingAnchor> = []
    for (const sw of sessWins) {
      const el = winAnchorRefs.current.get(sw.winId)
      if (el) next.push({ dirId: sw.dirId, el, offsetY: sw.offsetY })
    }
    setRingAnchorList(next)
  }, [view3d, anchorKey])  // sessWins covered by anchorKey; ref churn handled by re-render

  // Screen endpoints for the ring-center → file-window tethers the 3D scene
  // draws. Source point lives on the dir's ring (resolved 3D-side via dirId);
  // color now encodes the file's type (the per-band palette retired with the
  // bands).
  const fileTethers: Array<FileTetherEnd> = view3d
    ? winPlaced.map(wp => {
        const off = drag.dragOffset(wp.systemId)
        const ft  = extToFileType(wp.active.name.split('.').pop() ?? '')
        return {
          dirId: wp.systemId,
          path: wp.active.path,
          x: wp.side === 'left' ? wp.x + off.x + FILE_W / 2 : wp.x + off.x - FILE_W / 2,
          y: wp.y + off.y,
          color: FILE_TYPE_COLORS[ft],
        }
      })
    : []

  return (
    <div className="gc" ref={containerRef}>
      <div className="gc-grid" />

      {/* ── 3D galaxy — alternate skin over the same tree state ────────────── */}
      {view3d && (
        <Galaxy3D
          openSystems={openSystems}
          nodes={nodes}
          rootDirId={rootDirId}
          effectiveActive={effectiveActive}
          hotIds={hotIds}
          openIds={openIds}
          projectsRoot={projectsRoot}
          orbState={orbState}
          orbTarget={orbTarget}
          fileTethers={fileTethers}
          ringAnchors={ringAnchorList}
          onFocusSystem={onFocusSystem}
          onOpenSubdir={(name, fromId) => onOrbiterClick(name, fromId)}
          onFileClick={onFileClick}
          onFiles={(dirId, clientX, clientY) => openPickerAt(dirId, clientX, clientY)}
          onTap={onTap}
          onContextPick={onGalaxyContext}
        />
      )}

      {/* ── SVG layer: crosshair → tethers → file tethers → umbilicals ─────── */}
      {!view3d && w > 0 && h > 0 && (
        <svg className="gc-svg" width={w} height={h}>
          {/* Geometric-center crosshair + drift tether (§2) */}
          {drifting && rootLay && (
            <g>
              <line className="gc-cross" x1={frame.gc.x - 9} y1={frame.gc.y} x2={frame.gc.x + 9} y2={frame.gc.y} />
              <line className="gc-cross" x1={frame.gc.x} y1={frame.gc.y - 9} x2={frame.gc.x} y2={frame.gc.y + 9} />
              <line className="gc-drift" x1={frame.gc.x} y1={frame.gc.y} x2={rootLay.cx} y2={rootLay.cy} />
            </g>
          )}

          {/* Rim-to-rim tethers (§0) — hot path = lime, branches = dim */}
          {openSystems.filter(s => s.parentSystemId).map(s => {
            const child  = rendered.get(s.dirId)
            const parent = rendered.get(s.parentSystemId!)
            if (!child || !parent) return null
            const ends = tetherEnds(parent, child)
            const hot  = hotIds.has(s.dirId) && hotIds.has(s.parentSystemId!)
            return (
              <line key={`th-${s.dirId}`}
                className={hot ? 'teth f' : 'teth dim'}
                opacity={child.o * child.v}
                x1={ends.x1} y1={ends.y1} x2={ends.x2} y2={ends.y2} />
            )
          })}

          {/* One dashed tether per file window, ring center → near window edge.
              The on-rim diamond source-point retired with the band layout —
              every open file now emanates from its dir's seed. */}
          {winPlaced.map(wp => {
            const lay = rendered.get(wp.systemId)
            if (!lay) return null
            const off  = drag.dragOffset(wp.systemId)
            const edgeX = wp.side === 'left'
              ? wp.x + off.x + FILE_W / 2
              : wp.x + off.x - FILE_W / 2
            return (
              <line key={`f-${wp.systemId}`} className="teth file"
                x1={lay.cx} y1={lay.cy} x2={edgeX} y2={wp.y + off.y} />
            )
          })}

          {/* Session-window tethers — same style as file tethers, pointing at
              the ring's center circle (segment under the window is hidden).
              Endpoint tracks the window's drag offset. */}
          {sessWins.map(sw => {
            const off = drag.dragOffset(sw.winId)
            return (
              <line key={`st-${sw.winId}`} className="teth file"
                x1={sw.x + off.x} y1={sw.y + off.y} x2={sw.cx} y2={sw.cy} />
            )
          })}

          {/* Tool umbilical lines from root */}
          {rootLay && tools.map((t, i) => {
            const p = toolPos(i, tools.length, w, h, BOT_SAFE)
            return (
              <line key={`u-${t.id}`} className="teth dotted"
                x1={rootLay.cx} y1={rootLay.cy} x2={p.x} y2={p.y} />
            )
          })}
        </svg>
      )}

      {/* ── Star systems — one per open directory ──────────────────────────── */}
      {!view3d && openSystems.map(sys => {
        const lay  = rendered.get(sys.dirId)
        const node = nodes.get(sys.dirId)
        if (!lay || !node) return null

        const dirs       = visibleChildDirs(nodes, sys.dirId)
        const placements = orbiterPlacements(dirs.length, lay.r)
        // Multi-ring overflow: when dirs.length > RING_MAX the orbiters split
        // across concentric rings. innerRingRadii feeds the extra dashed .rim
        // circles to StarSystem (excludes the outermost which equals lay.r).
        const allRingRadii = ringRadii(dirs.length, lay.r)
        const innerRingRadii = allRingRadii.slice(0, -1)
        // Anti-collision cap: chord between adjacent slots at THIS ring's
        // current radius. With multi-ring, take the MIN cap across all rings
        // so labels fit the tightest (innermost) ring; outer-ring labels are
        // shorter than they could be but consistent. Labels overflow softly
        // (hover overlay surfaces the full name) when even the min is too small.
        const plan    = ringPlan(dirs.length)
        const orbCap  = plan.length === 0
          ? labelCapacity(0, lay.r)
          : Math.min(...plan.map((n, i) => labelCapacity(n, allRingRadii[i])))
        // Reservation pool — every other name rendered on/around this ring.
        // Dir orbiter labels stay distinct from file names (shown in the
        // picker) and the parent dir's own label. Cross-feeding raw names (not
        // pre-computed labels) keeps the prefix-extension symmetric.
        const dirNames    = dirs.map(d => d.name)
        const fileNames   = (node.files ?? []).map(f => f.name)
        const ownDirName  = node.name
        // Uniqueness-driven labels — extend the prefix until each directory's
        // display label is distinct from every other on the rim. Soft cap:
        // two siblings like `outdoor-kitchen` / `outdoor-living` will both
        // overflow the lane rather than both collapse to "outdoor".
        const dirUnique = uniqueLabels(dirNames, orbCap, [...fileNames, ownDirName])
        const orbiters: Array<Orbiter> = dirs
          .map((d, i) => ({
            n: d.name, c: dotColor(d), a: placements[i].angle, r: placements[i].radius,
            display: dirUnique[i],
            open: openIds.has(d.id),
          }))
          .filter(o => !o.open)

        const isRoot   = sys.dirId === rootDirId

        const pathLabel = isRoot
          ? (projectsRoot?.split('/').filter(Boolean).pop() ?? '~/projects')
          : node.name
        const openedChildCount = openSystems.filter(s => s.parentSystemId === sys.dirId && !s.closing).length
        const sub = isRoot
          ? `${dirs.length} projects · ${openedChildCount} open`
          : `${dirs.length} dirs · ${node.files?.length ?? node.fileCount ?? 0} files`

        const fileCount = node.files?.length ?? 0
        // Cloud builds from a seeded PRNG keyed on node.id so positions stay
        // stable across renders — React's reconciliation sees identical values
        // and the scatter doesn't shimmer.
        const cloud = lay.o > 0.05 ? buildCloud2D(node, lay.r) : []
        return (
          <StarSystem
            key={sys.dirId}
            x={lay.cx} y={lay.cy} r={lay.r} o={lay.o} v={lay.v}
            dotColor={dotColor(node)}
            path={pathLabel} sub={sub}
            labelTop={isRoot}
            hideLabel={sys.sessions.length > 0}
            orbiters={orbiters}
            innerRingRadii={innerRingRadii}
            cloud={cloud}
            cloudTint={cloudTint(node)}
            queuePending={queuePendingByDir[node.name] ?? 0}
            queueColor={cloudTint(node)}
            onOrbiterClick={(name, ev) => onOrbiterClick(name, sys.dirId, ev)}
            onOrbiterContext={(name, ev) => onOrbiterContext(name, sys.dirId, ev)}
            onFocus={ev => {
              onFocusSystem(sys.dirId)
              // Left-click on the rim opens the file picker for this ring,
              // anchored at the click point but clamped on-screen by
              // openPickerAt. Skipped for empty dirs so a single-dir ring
              // doesn't pop an empty popover on every click.
              if (ev && fileCount > 0) openPickerAt(sys.dirId, ev.clientX, ev.clientY)
            }}
            onRingContext={isRoot ? undefined : ev => onRingContext(sys.dirId, ev)}
            onClose={isRoot ? undefined : () => onCloseSystem(sys.dirId)}
          />
        )
      })}

      {/* ── Terminal windows (tabbed per dir + split-out singles) ──────────── */}
      {sessWins.map(sw => {
        // Raise level = 1-indexed position in the recent-click list (0 = never
        // raised / fell off the bounded list). The pos+1 keeps the freshly
        // raised window strictly above every other.
        const raisePos   = winRaiseOrder.indexOf(sw.winId)
        const raiseLevel = raisePos < 0 ? 0 : raisePos + 1
        const win = (
          <SessionWin id={sw.winId}
            sessions={sw.sessList} active={sw.active}
            x={sw.x} y={sw.y} focus={sw.focus} drag={drag}
            detached={sw.detached}
            permTabIds={permTabIds}
            onSend={(term, text) => onSessionSend(sw.active.systemId, term, text)}
            onQueueFocus={() => onSessionQueue(sw.active.systemId)}
            queued={focusQueueIds.has(sw.active.systemId)}
            onSelectTab={s => onSelectTermTab(s.systemId, s.term)}
            onNewTab={() => onNewTerminal(sw.active.systemId)}
            onDetach={onDetachSess}
            onCloseTab={onCloseSess}
            permissions={permsBySess.get(sw.active.id)}
            onPermission={onPermission}
            questions={questionsBySess.get(sw.active.id)}
            onQuestion={onQuestion}
            raiseLevel={raiseLevel}
            onRaise={() => onRaiseWin(sw.winId)}
          />
        )
        if (!view3d) return <React.Fragment key={sw.winId}>{win}</React.Fragment>
        // 3D: wrapper anchors to the projected ring center via galaxyScene's
        // per-frame transform mutation. Window inside positions at (0, 0).
        return (
          <div key={sw.winId}
               ref={el => { winAnchorRefs.current.set(sw.winId, el) }}
               style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}>
            {win}
          </div>
        )
      })}

      {/* ── Right-click context menu ────────────────────────────────────────── */}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} title={ctxMenu.title}
          items={ctxMenu.items} onClose={onCloseCtxMenu} />
      )}

      {/* ── File picker — left-click on a ring's rim ──────────────────────── */}
      {pickerSys && (() => {
        const node = nodes.get(pickerSys.id)
        if (!node) return null
        const files = node.files ?? []
        return (
          <FilePicker
            x={pickerSys.x} y={pickerSys.y}
            title={node.name}
            files={files}
            openFilePaths={openFilePaths}
            dirtyFilePaths={dirtyPaths}
            onPick={(f: FileEntry) => {
              // FilePicker speaks FileEntry; downstream openFiles bookkeeping
              // still uses the FileStar record (band/a survive as 3D-galaxy
              // metadata even though 2D no longer renders an on-rim diamond).
              const ft  = extToFileType(f.name.split('.').pop() ?? '')
              const band: Band = ft === 'docs' ? 'docs' : (ft === 'config' || ft === 'data') ? 'config' : 'code'
              const star: FileStar = { n: f.name, path: f.path, band, a: 0, rr: 0, tracked: f.tracked }
              onFileClick(star, pickerSys.id)
            }}
            onClose={closePicker}
          />
        )
      })()}

      {/* ── Main-session permission approvals (no terminal window owns them) ── */}
      {overlayPerms.length > 0 && (
        <div className="perm-overlay">
          <PermissionPrompt req={overlayPerms[0]} queue={overlayPerms.slice(1)} onRespond={onPermission} />
        </div>
      )}

      {/* ── Main-session multiple-choice questions ─────────────────────────── */}
      {mainQuestions.length > 0 && (
        <div className="q-overlay">
          <QuestionPrompt req={mainQuestions[0]} moreCount={mainQuestions.length - 1} onRespond={onQuestion} />
        </div>
      )}

      {/* ── File editor windows (spec §3.6) ────────────────────────────────── */}
      {winPlaced.map(wp => (
        <FilePopup
          key={wp.systemId}
          id={wp.systemId}
          files={wp.files}
          activePath={wp.active.path}
          x={wp.x} y={wp.y} w={FILE_W} h={FILE_H}
          dirtyPaths={dirtyPaths}
          drag={drag}
          onSelectTab={path => onSelectTab(wp.systemId, path)}
          onCloseTab={onCloseTab}
          onDirty={onFileDirty}
        />
      ))}

      {/* ── AI orb — commuted by the engine, memoized against 60fps rerenders ─ */}
      {!view3d && (
        <div className="orb-host" ref={orbHostRef} style={{ width: 64, height: 64 }}>
          <OrbCore
            orbState={orbState}
            onTap={onTap} size={64} finish="signature" seed={3}
          />
          <div className="orb-tap" onClick={onTap} role="button" aria-label="Talk to Axle" />
        </div>
      )}

      {/* ── Tool dots ────────────────────────────────────────────────────────── */}
      <ToolStrip tools={tools} w={w} h={h} botSafe={BOT_SAFE} now={tick} />

      {/* ── App chrome ───────────────────────────────────────────────────────── */}
      <div className="ax-topbar">
        <div className="ax-brand">
          <span className="ax-logo">AXLE</span>
          <span className="ax-tag">{view3d ? 'agent galaxy · 3d' : 'system tree'}</span>
        </div>
        <div className="ax-topbar-btns">
          <button className="ax-gear ax-viewtoggle" onClick={onToggleView} title={view3d ? 'Flat constellation view' : '3D galaxy view'}>
            {view3d ? '2D' : '3D'}
          </button>
          <button className="ax-gear" onClick={() => setHelpOpen(true)} title="Things you can say" aria-label="Voice help">?</button>
          <button
            className="ax-gear"
            onClick={() => setQueueOpen(true)}
            title={queueCount > 0 ? `${queueCount} waiting in queue` : 'Queue'}
            aria-label="Show queue"
          >
            ☰{queueCount > 0 && <sup style={{ marginLeft: 2, color: 'var(--lime)', fontSize: 9 }}>{queueCount}</sup>}
          </button>
          <button className="ax-gear" onClick={() => setConfirmNewSession(true)} title="New session (clears this tab)" aria-label="New session">↻</button>
          <button className="ax-gear" onClick={onOpenSettings}>⚙</button>
        </div>
      </div>

      {statusMsg      && <div className="ax-status">{statusMsg}</div>}
      {orbModeLabel   && <div className="ax-orb-mode" data-state={orbState}>{orbModeLabel}</div>}
      {liveTranscript && <div className="ax-transcript">{liveTranscript}</div>}

      <VoiceHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <QueueMenu
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        unreadTranscripts={unreadTranscripts}
        queueItems={queueItems}
        onReadTranscript={onReadTranscript}
      />

      {confirmNewSession && (
        <div className="vhelp-scrim" onClick={() => setConfirmNewSession(false)}>
          <div className="ax-confirm" role="dialog" aria-label="New session" onClick={e => e.stopPropagation()}>
            <h4>New session?</h4>
            <p>
              This clears the current conversation, terminals, and agent memory in this
              tab, then reloads to a clean slate. Other tabs are unaffected. This can't
              be undone.
            </p>
            <div className="ax-confirm-actions">
              <button className="ax-settings-btn ghost" onClick={() => setConfirmNewSession(false)}>Cancel</button>
              <button className="ax-settings-btn primary" onClick={() => { setConfirmNewSession(false); onNewSession() }}>
                New session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chat dock ────────────────────────────────────────────────────────── */}
      <div className="gdock">
        {messages.length > 0 && (
          <div className="gdock-hist">
            {messages.slice(-2).map((m, i) => (
              <div key={i} className={`h ${m.role === 'user' ? 'user' : 'axle'}`}>
                <strong>{m.role === 'user' ? 'you' : 'axle'}</strong>&nbsp; {m.text}
              </div>
            ))}
          </div>
        )}
        <div className="gdock-in">
          <span className="you">you</span>
          <input
            className="ph"
            name="ax-prompt"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-form-type="other"
            placeholder="type a prompt or tap the orb to talk…"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendChat() } }}
          />
          <button className="snd" onClick={onSendChat}>↵</button>
          <button className="snd" onClick={() => onExpandView('chat')} title="Expand chat" aria-label="Expand chat">⤢</button>
          <button className="snd" onClick={() => onExpandView('dashboard')} title="Agent dashboard" aria-label="Agent dashboard">▦</button>
        </div>
      </div>

      <ExpandedView
        mode={expandView}
        onModeChange={onExpandView}
        messages={messages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        onSendChat={onSendChat}
        sessions={sessions}
        onSessionSend={onSessionSend}
        mainPermissions={mainPermissions}
        onPermission={onPermission}
      />

      <SettingsPanel
        open={showSettings}
        onClose={onCloseSettings}
        tts={tts}
        onProjectsRefresh={onProjectsRefresh}
        onMcpRefresh={onMcpRefresh}
      />
    </div>
  )
}
