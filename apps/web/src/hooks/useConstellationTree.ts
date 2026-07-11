import { useCallback, useEffect, useRef, useState } from 'react'
import { browseDir, getSettings } from '../api.js'
import { splitTermKey } from './messages.js'
import type { Message } from './messages.js'
import type { Pt } from '../components/Constellation/layout/geo.js'
import type { FileEntry, McpListItem, ProjectItem, SettingsResponse } from '@axel/core'
import {
  type FsNode, type OpenSystem, type OrbTarget, type Session,
  type ToolNode, langToFileType,
} from '../types/constellation.js'

export type ToolUseEvent = { name: string; input?: unknown; id: number; target?: string }

const ACCENT_CYCLE = ['cyan', 'lime', 'orange', 'pink']
const ACTIVE_MS    = 5 * 60 * 1000

let _seq = 0
function nextId(): string { return `sess-${++_seq}` }

function parseMcpServer(raw: string): string {
  const m = /^mcp__([^_][^_]*(?:_[^_]+)*)__/.exec(raw)
  return m ? m[1] : raw
}

// Case-insensitive exact match (used for server-sent target names which are authoritative).
// Targets may be root-relative paths ("axel/apps/web") for nested rings — those
// match against the tail of the node's absolute path.
function nodeMatchesTarget(n: FsNode | undefined, target: string): boolean {
  if (!n) return false
  const t = target.toLowerCase()
  const p = n.path?.toLowerCase() ?? ''
  return (
    n.name.toLowerCase() === t ||
    n.id.toLowerCase()   === t ||
    p.split('/').pop()   === t ||
    p === t || p.endsWith('/' + t)
  )
}

// Fuzzy score: how well does `dirName` match within `text`?
// Returns 0-100. Used for user-message parsing so partial names work.
//
// Examples:
//   scoreDir('outdoor-kitchen-ai', 'run audit on outdoor kitchen')  → 80  ✓
//   scoreDir('rta-blueprint-react-ui', 'check the blueprint project') → 40 ✓
//   scoreDir('keystone', 'open keystone')                           → 100 ✓
//   scoreDir('src', 'check source code')                            → 0   (too short)
function scoreDir(dirName: string, text: string): number {
  const dl = dirName.toLowerCase()
  const tl = text.toLowerCase()

  // Verbatim substring match wins immediately
  if (tl.includes(dl)) return 100

  // Squashed match: spoken un-hyphenated names arrive as separate words
  // ("paul the robot baby" → "paultherobotbaby"). ≥6 chars so tiny names
  // can't match inside unrelated words.
  const dSquash = dl.replace(/[^a-z0-9]+/g, '')
  if (dSquash.length >= 6 && tl.replace(/[^a-z0-9]+/g, '').includes(dSquash)) return 100

  // Split dir name on hyphens/underscores into tokens; skip tokens < 4 chars
  // (avoid matching short abbreviations like "ai", "ui", "rta" out of context)
  const tokens = dl.split(/[-_]+/).filter(t => t.length >= 4)
  // Require ≥2 meaningful tokens for partial matching. A dir reduced
  // to ONE generic token (e.g. acme-blueprint-api →
  // ["blueprint"]) would otherwise score a perfect ratio on a shared word and
  // beat the dir the user actually named (acme-blueprint-react-ui-azure, which
  // dilutes its ratio with the unmatched "react" token). Single-name dirs still
  // match verbatim/squashed above (returns 100 when the whole word appears).
  if (tokens.length < 2) return 0

  // Words in the user's message (split on any non-alpha run, skip < 3 chars)
  const words = tl.split(/[^a-z0-9]+/).filter(w => w.length >= 3)
  if (words.length === 0) return 0

  let matched = 0
  for (const token of tokens) {
    const found = words.some(w =>
      w === token ||                                  // exact word match
      (token.length >= 6 && w.includes(token)) ||    // message word contains long token
      // token contains message word — ≥5 chars, or a stopword inside an
      // un-hyphenated name matches everything ("the" ⊂ "paultherobotbaby")
      (token.length >= 6 && w.length >= 5 && token.includes(w)),
    )
    if (found) matched++
  }

  if (matched === 0) return 0
  const ratio = matched / tokens.length

  // Require at least 50% of meaningful tokens to match
  if (ratio < 0.5) return 0

  return Math.round(ratio * 80)
}

// Find the best-matching child dir id given a user message or target string.
// Returns the id or null if no match above threshold.
function bestDirMatch(
  text:     string,
  rootNode: FsNode | undefined,
  nodes:    Map<string, FsNode>,
  minScore  = 50,
): string | null {
  let bestId:    string | null = null
  let bestScore: number = minScore - 1

  for (const id of (rootNode?.children ?? [])) {
    const n = nodes.get(id)
    if (!n) continue
    const s = scoreDir(n.name, text)
    if (s > bestScore) { bestScore = s; bestId = id }
  }

  return bestId
}

function subtreeIds(rootId: string, open: Array<OpenSystem>): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const s of open) {
      if (s.parentSystemId && ids.has(s.parentSystemId) && !ids.has(s.dirId)) {
        ids.add(s.dirId)
        grew = true
      }
    }
  }
  return ids
}

export function useConstellationTree(
  messages:        Array<Message>,
  toolUseEvent:    ToolUseEvent | null,
  targetMessages:  Record<string, Array<Message>>,
  currentTarget:   string | null,
  fsChangeId:      number,
  targetStatus:    Record<string, 'working' | 'done' | 'error'> = {},
  targetSpawnIds:  Record<string, string> = {},
) {
  const [nodes,          setNodes]          = useState<Map<string, FsNode>>(new Map())
  const [openSystems,    setOpenSystems]    = useState<Array<OpenSystem>>([])
  const [sessions,       setSessions]       = useState<Map<string, Session>>(new Map())
  const [tools,          setTools]          = useState<Array<ToolNode>>([])
  const [rootDirId,      setRootDirId]      = useState<string>('root')
  const [activeSystemId, setActiveSystemId] = useState<string | null>(null)
  const [orbTarget,      setOrbTarget]      = useState<OrbTarget>({ type: 'home' })
  const [projectsRoot,   setProjectsRoot]   = useState<string | null>(null)
  const [loading,        setLoading]        = useState(true)

  const openSystemsRef    = useRef(openSystems)
  const nodesRef          = useRef(nodes)
  useEffect(() => { openSystemsRef.current = openSystems }, [openSystems])
  useEffect(() => { nodesRef.current = nodes },             [nodes])

  // Click-captured points the engine grows new rings out of (consumed once)
  const enterFromRef = useRef<Map<string, Pt>>(new Map())
  const enterFromOf = useCallback((dirId: string): Pt | undefined => {
    const pt = enterFromRef.current.get(dirId)
    enterFromRef.current.delete(dirId)
    return pt
  }, [])

  // ── MCP tools ────────────────────────────────────────────────────────────────
  const refreshMcp = useCallback(() => {
    fetch('/api/mcp/list', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((data: { ok: boolean; items: Array<McpListItem> } | null) => {
        if (!data?.ok) return
        setTools(data.items.map((item, i) => ({
          id:    item.id,
          name:  item.name,
          description: item.description ?? undefined,
          accent: ACCENT_CYCLE[i % ACCENT_CYCLE.length],
        })))
      })
      .catch(() => {})
  }, [])

  // ── load project directories ──────────────────────────────────────────────────
  const refreshProjects = useCallback(() => {
    setLoading(true)
    Promise.all([
      getSettings(),
      fetch('/api/fs/projects', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ])
      .then(([settings, fsData]: [SettingsResponse | null, { ok: boolean; root: string; items: Array<ProjectItem>; files?: Array<FileEntry> } | null]) => {
        const root  = settings?.projectsRoot ?? fsData?.root ?? '~'
        setProjectsRoot(root)

        const newNodes = new Map<string, FsNode>()
        const childIds: Array<string> = []

        if (fsData?.ok) {
          for (const item of fsData.items) {
            const node: FsNode = {
              id:           item.id,
              name:         item.name,
              kind:         'dir',
              path:         item.path,
              fileCount:    item.fileCount,
              dominantType: langToFileType(item.lang),
            }
            newNodes.set(item.id, node)
            childIds.push(item.id)
          }
        }

        const rootNode: FsNode = {
          id:       'root',
          name:     root.split('/').filter(Boolean).pop() ?? root,
          kind:     'dir',
          path:     root,
          children: childIds,
          files:    fsData?.files ?? [],
        }
        newNodes.set('root', rootNode)

        setRootDirId('root')
        setNodes(newNodes)
        setOpenSystems(prev => {
          if (prev.some(s => s.dirId === 'root')) return prev
          return [{ dirId: 'root', sessions: [] }]
        })
        setActiveSystemId(prev => prev ?? 'root')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { refreshProjects(); refreshMcp() }, [refreshProjects, refreshMcp])

  // ── live directory refresh ─────────────────────────────────────────────────
  // Fired when the server reports the projects directory set changed. Unlike the
  // initial refreshProjects (which rebuilds the node map from scratch — fine at
  // mount when nothing is open), this MERGES: it re-pulls the top-level projects
  // and every currently-open subdir ring, preserving existing nodes so the user's
  // open navigation and running agents are never collapsed. No page reload.
  const refreshTree = useCallback(() => {
    const openDirs = openSystemsRef.current.filter(s => s.dirId !== 'root')
    Promise.all([
      fetch('/api/fs/projects', { credentials: 'include' }).then(r => r.ok ? r.json() : null) as Promise<{ ok: boolean; root: string; items: Array<ProjectItem>; files?: Array<FileEntry> } | null>,
      ...openDirs.map(s => {
        const node = nodesRef.current.get(s.dirId)
        return node
          ? browseDir(node.path).then(data => ({ dirId: s.dirId, data })).catch(() => null)
          : Promise.resolve(null)
      }),
    ])
      .then(([fsData, ...subResults]) => {
        setNodes(prev => {
          const next = new Map(prev)

          // Top-level projects under the root.
          const childIds: Array<string> = []
          if (fsData?.ok) {
            for (const item of fsData.items) {
              const existing = next.get(item.id)
              next.set(item.id, {
                ...existing,
                id:           item.id,
                name:         item.name,
                kind:         'dir',
                path:         item.path,
                fileCount:    item.fileCount,
                dominantType: langToFileType(item.lang),
              })
              childIds.push(item.id)
            }
          }
          const root = next.get('root')
          if (root) next.set('root', { ...root, children: childIds, files: fsData?.files ?? root.files })

          // Each open subdir ring — refresh its children too, so dirs created
          // deeper in the tree surface live as well.
          for (const res of subResults) {
            if (!res || !res.data?.ok) continue
            const subChildIds: Array<string> = []
            for (const d of res.data.dirs) {
              const childId = `${res.dirId}/${d.name}`
              const existing = next.get(childId)
              next.set(childId, { ...existing, id: childId, name: d.name, kind: 'dir', path: d.path })
              subChildIds.push(childId)
            }
            const parent = next.get(res.dirId)
            if (parent) next.set(res.dirId, { ...parent, children: subChildIds, files: res.data.files ?? parent.files })
          }

          return next
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (fsChangeId === 0) return  // skip the initial mount value; refreshProjects already ran
    refreshTree()
  }, [fsChangeId, refreshTree])

  // ── open a directory — fetch its subdirs, then add the system; the engine
  //    animates it growing out of its resting dot (or `enterFrom` click point) ──
  const openingInFlightRef = useRef<Set<string>>(new Set())

  // Returns a Promise that resolves once the system has actually been added
  // (or the open was a no-op). Callers chaining sequential opens (the AI
  // fan-out queue in onOrbArrived) await this so they don't race the browseDir
  // network round-trip and overwrite the orb target before addSystem parks it.
  // `explicitPath` lets a caller open a dir whose node isn't in the map yet —
  // needed for nested drill-downs (openNestedPath) where a deeper segment's node
  // is only created once its parent is browsed, and nodesRef lags a render behind
  // that. When given, we seed a placeholder node so sessions/rendering resolve it.
  const openDir = useCallback((dirId: string, fromSystemId: string, enterFrom?: Pt, explicitPath?: string): Promise<void> => {
    return new Promise<void>(resolve => {
      if (openSystemsRef.current.some(s => s.dirId === dirId)) { resolve(); return }
      const node = nodesRef.current.get(dirId)
      const dirPath = node?.path ?? explicitPath
      if (!dirPath) { resolve(); return }
      if (!node) {
        setNodes(prev => prev.has(dirId) ? prev : new Map(prev).set(dirId, {
          id: dirId, name: dirId.split('/').pop() ?? dirId, kind: 'dir', path: dirPath,
        }))
      }
      if (enterFrom) enterFromRef.current.set(dirId, enterFrom)

      const addSystem = (): void => {
        setOpenSystems(prev => prev.some(s => s.dirId === dirId)
          ? prev
          : [...prev, { dirId, parentSystemId: fromSystemId, sessions: [] }])
        openingInFlightRef.current.delete(dirId)
        // Opening (manual OR AI-spawned) moves visual focus to the new dir —
        // the orb represents WHERE THE CONVERSATION IS, not voice routing.
        // Voice/chat is hardcoded to root elsewhere, so this is purely visual.
        setActiveSystemId(dirId)
        setOrbTarget({ type: 'system', systemId: dirId })
        resolve()
      }

      browseDir(dirPath)
        .then(data => {
          if (data.ok) {
            setNodes(prev => {
              const next = new Map(prev)
              const childIds: Array<string> = []
              for (const d of data.dirs) {
                const childId = `${dirId}/${d.name}`
                next.set(childId, { id: childId, name: d.name, kind: 'dir', path: d.path })
                childIds.push(childId)
              }
              const updated = next.get(dirId) ?? { id: dirId, name: dirId.split('/').pop() ?? dirId, kind: 'dir' as const, path: dirPath }
              next.set(dirId, { ...updated, children: childIds, files: data.files ?? [] })
              return next
            })
          }
          addSystem()
        })
        .catch(addSystem)
    })
  }, [])

  // ── close a system — mark the subtree closing; the engine plays the reverse
  //    transition and reports each system done, which is when we remove it ─────
  const closeSystem = useCallback((systemId: string) => {
    const ids = subtreeIds(systemId, openSystemsRef.current)
    setOpenSystems(prev => prev.map(s => ids.has(s.dirId) ? { ...s, closing: true } : s))
  }, [])

  // Resolve a server-sent target name (e.g. dir_closed.target) to the matching
  // open system and trigger the close animation. No-op if nothing matches.
  const closeSystemByTarget = useCallback((targetName: string) => {
    const sys = openSystemsRef.current.find(s =>
      nodeMatchesTarget(nodesRef.current.get(s.dirId), targetName),
    )
    if (sys) closeSystem(sys.dirId)
  }, [closeSystem])

  const onCloseDone = useCallback((dirId: string) => {
    const parent = openSystemsRef.current.find(s => s.dirId === dirId)?.parentSystemId ?? 'root'
    setOpenSystems(prev => prev.filter(s => s.dirId !== dirId))
    setActiveSystemId(prev => prev === dirId ? parent : prev)
    setOrbTarget(prev =>
      prev.type !== 'home' && prev.systemId === dirId
        ? { type: 'system', systemId: parent }
        : prev,
    )
  }, [])

  // ── tool activation ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toolUseEvent) return
    const server = parseMcpServer(toolUseEvent.name)
    const serverLower = server.toLowerCase()
    setTools(prev => {
      const matched = prev.some(t => t.name.toLowerCase() === serverLower)
      if (!matched) {
        // Unknown server — a new MCP may have been registered; refresh the list
        refreshMcp()
        return prev
      }
      return prev.map(t => t.name.toLowerCase() === serverLower ? { ...t, activeUntil: Date.now() + ACTIVE_MS } : t)
    })
  }, [toolUseEvent, refreshMcp])

  // ── core: open a system by name (idempotent, uses refs so always fresh) ───────
  // AI-initiated opens follow spec §3.3 targeting: the orb travels to the resting
  // dot first; the open fires when it arrives (onOrbArrive → onOrbArrived below).
  //
  // pendingOpensRef is a QUEUE, not a single slot. A multi-target fan-out
  // (`open these two dirs in parallel`) calls ensureSystemOpen for each target
  // back-to-back in the same tick; the prior single-slot design overwrote the
  // first pending open with the second, and the orb walked straight to dir2
  // — dir1 stayed forever stuck in openingInFlightRef and never rendered. With
  // a queue we drain sequentially: orb walks to dir1's dot → opens dir1 →
  // walks to dir2's dot → opens dir2. Both backends were running in parallel
  // all along; this just gets the UI to reflect both.
  const pendingOpensRef = useRef<Array<{ dirId: string; from: string }>>([])

  // Open a nested target ("clients/acme-web-app") by drilling one segment
  // at a time: open each ancestor so its children load, then enter the deepest.
  // Top-level node ids are NOT bare names (the projects route ids them
  // "dir-<name>"), so the first segment is resolved by NAME among root's
  // children; deeper segments use openDir's deterministic "<parentId>/<name>" id
  // and a path derived from the parent (nodesRef lags a render behind each open,
  // so we compute ids/paths rather than read them back).
  const nestedInFlightRef = useRef<Set<string>>(new Set())
  const openNestedPath = useCallback(async (targetName: string): Promise<void> => {
    if (nestedInFlightRef.current.has(targetName)) return
    nestedInFlightRef.current.add(targetName)
    try {
      const segs = targetName.split('/').filter(Boolean)
      if (segs.length === 0) return
      const rootNode = nodesRef.current.get('root')
      const seg0 = (rootNode?.children ?? []).find(id => {
        const n = nodesRef.current.get(id)
        return !!n && n.name.toLowerCase() === segs[0].toLowerCase()
      }) ?? bestDirMatch(segs[0], rootNode, nodesRef.current)
      if (!seg0) return
      let curId: string = seg0
      let curPath: string | undefined = nodesRef.current.get(curId)?.path
      if (!openSystemsRef.current.some(s => s.dirId === curId)) {
        await openDir(curId, 'root', undefined, curPath)
      }
      for (let i = 1; i < segs.length; i++) {
        const childId: string = `${curId}/${segs[i]}`
        const childPath: string | undefined = curPath ? `${curPath}/${segs[i]}` : undefined
        if (!openSystemsRef.current.some(s => s.dirId === childId)) {
          await openDir(childId, curId, undefined, childPath)
        }
        curId = childId
        curPath = childPath
      }
      // Land focus on the deepest ring (no-op if openDir already parked there).
      setActiveSystemId(curId)
      setOrbTarget({ type: 'system', systemId: curId })
    } finally {
      nestedInFlightRef.current.delete(targetName)
    }
  }, [openDir])

  const ensureSystemOpen = useCallback((targetName: string) => {
    if (!targetName || !nodesRef.current.size) return

    // Already open — move the visual focus (orb + activeSystemId) to it.
    // The orb tracks WHERE THE CONVERSATION IS; referencing an open dir
    // pulls the orb back to it. Voice routing stays on root regardless.
    // nodeMatchesTarget matches a nested target via the node's path suffix,
    // so a re-reference of an already-open nested ring refocuses correctly.
    const existing = openSystemsRef.current.find(s =>
      nodeMatchesTarget(nodesRef.current.get(s.dirId), targetName),
    )
    if (existing) {
      setActiveSystemId(existing.dirId)
      setOrbTarget({ type: 'system', systemId: existing.dirId })
      return
    }

    // Nested target (multi-segment path) — drill in. Top-level fuzzy matching
    // can only resolve a bare project name, never a "group/child" path, so a
    // nested open would otherwise stop at the group ring.
    if (targetName.includes('/')) {
      void openNestedPath(targetName)
      return
    }

    // Single-segment: existing exact-or-fuzzy match, opened via the orb-walk queue.
    const rootNode = nodesRef.current.get('root')
    const exactMatch = (rootNode?.children ?? []).find(id =>
      nodeMatchesTarget(nodesRef.current.get(id), targetName),
    )
    const match = exactMatch ?? bestDirMatch(targetName, rootNode, nodesRef.current)
    if (!match) return

    if (openSystemsRef.current.some(s => s.dirId === match)) return
    if (openingInFlightRef.current.has(match)) return

    openingInFlightRef.current.add(match)
    pendingOpensRef.current.push({ dirId: match, from: 'root' })
    // Only retarget the orb if this is the head of an otherwise-empty queue.
    // Otherwise the orb is already walking to the previous pending dir and
    // onOrbArrived's chain will pick this entry up after that one resolves —
    // retargeting now would skip the in-flight open.
    if (pendingOpensRef.current.length === 1) {
      setOrbTarget({ type: 'dot', systemId: 'root', dirId: match })
    }
  }, [openNestedPath])

  // Orb reached its target dot — open the head of the pending queue. After
  // addSystem fires (parks orb on the new system) we check the queue and walk
  // the orb to the next pending dot. Sequential drain, no race with the
  // browseDir async because openDir's promise resolves inside addSystem.
  const onOrbArrived = useCallback((target: OrbTarget) => {
    if (target.type !== 'dot') return
    const queue = pendingOpensRef.current
    if (queue.length === 0) return
    const head = queue[0]
    if (head.dirId !== target.dirId) return
    queue.shift()
    openDir(head.dirId, head.from, undefined).then(() => {
      const next = queue[0]
      if (next) setOrbTarget({ type: 'dot', systemId: 'root', dirId: next.dirId })
    })
  }, [openDir])

  // ── TRIGGER 1: currentTarget from WS target_start events ─────────────────────
  useEffect(() => {
    if (currentTarget) ensureSystemOpen(currentTarget)
  }, [currentTarget, ensureSystemOpen])

  // Re-run when nodes load in case currentTarget arrived first
  useEffect(() => {
    if (nodes.size > 0 && currentTarget) ensureSystemOpen(currentTarget)
  }, [nodes, currentTarget, ensureSystemOpen])

  // ── TRIGGER 2: targetMessages keys — covers per-token target field ────────────
  // Keys are termKey(target, term) composites; the ring is opened per target.
  const prevTargetKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const k of Object.keys(targetMessages)) {
      if (!prevTargetKeysRef.current.has(k)) {
        prevTargetKeysRef.current.add(k)
        ensureSystemOpen(splitTermKey(k).target)
      }
    }
  }, [targetMessages, ensureSystemOpen])

  // ── TRIGGER 3: user message text — fuzzy match, fires before agent responds ─────
  // "run audit on outdoor kitchen" → finds outdoor-kitchen-ai via token matching
  // "check the blueprint project"  → finds rta-blueprint-react-ui via "blueprint" token
  const prevUserCountRef = useRef(0)
  useEffect(() => {
    const userMsgs = messages.filter(m => m.role === 'user')
    if (userMsgs.length <= prevUserCountRef.current) return
    const newMsgs = userMsgs.slice(prevUserCountRef.current)
    prevUserCountRef.current = userMsgs.length

    for (const msg of newMsgs) {
      const rootNode = nodesRef.current.get('root')
      const match = bestDirMatch(msg.text, rootNode, nodesRef.current, 50)
      if (match) ensureSystemOpen(nodesRef.current.get(match)?.name ?? match)
    }
  }, [messages, ensureSystemOpen])

  // ── targetMessages → per-terminal sessions ────────────────────────────────────
  // Keys are termKey(target, term) composites — one Session per terminal, so a
  // dir can host several tabs. Empty buffers DO materialize (a just-opened
  // terminal is an empty tab awaiting input).
  const targetSessionMap = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    for (const [key, msgs] of Object.entries(targetMessages)) {
      const { target: targetName, term } = splitTermKey(key)
      // Use openSystems state (not ref) so this effect re-runs when a ring
      // opens — fixing the race where tokens arrive before the system exists.
      const sys = openSystems.find(s =>
        nodeMatchesTarget(nodes.get(s.dirId), targetName),
      )
      if (!sys) continue

      let sessId = targetSessionMap.current.get(key)
      if (!sessId) {
        sessId = nextId()
        targetSessionMap.current.set(key, sessId)
        const sess: Session = {
          id: sessId, systemId: sys.dirId,
          targetPath: nodes.get(sys.dirId)?.path ?? targetName,
          term,
          verb: 'working', lines: [],
        }
        setSessions(prev => new Map(prev).set(sessId!, sess))
        setOpenSystems(prev => prev.map(s =>
          s.dirId === sys.dirId && !s.sessions.includes(sessId!)
            ? { ...s, sessions: [...s.sessions, sessId!] }
            : s,
        ))
      }

      setSessions(prev => {
        const s = prev.get(sessId!)
        if (!s) return prev
        const next = new Map(prev)
        next.set(sessId!, {
          ...s,
          verb: targetStatus[key] ?? s.verb,
          spawnId: targetSpawnIds[key] ?? s.spawnId,
          lines: msgs.map(m => ({
            who: (m.role === 'user' ? 'you' : 'axle') as Session['lines'][number]['who'],
            t:   m.text,
          })),
        })
        return next
      })
    }
  }, [targetMessages, openSystems, nodes, targetStatus, targetSpawnIds])

  // ── close a terminal tab — drop its session everywhere; returns the
  //    composite buffer key so the caller can clear the voice-side buffer ──────
  const removeSession = useCallback((sessId: string): string | null => {
    let key: string | null = null
    for (const [k, v] of targetSessionMap.current) {
      if (v === sessId) { key = k; break }
    }
    if (key) targetSessionMap.current.delete(key)
    setSessions(prev => {
      if (!prev.has(sessId)) return prev
      const next = new Map(prev)
      next.delete(sessId)
      return next
    })
    setOpenSystems(prev => prev.map(s =>
      s.sessions.includes(sessId)
        ? { ...s, sessions: s.sessions.filter(id => id !== sessId) }
        : s,
    ))
    return key
  }, [])

  // Main chat lives in the bottom dock — no session window cluttering the
  // constellation for the root system. Only agent work-in-progress sessions bloom.

  // Navigate to any open system (e.g. tapping a ring to focus it)
  const focusSystem = useCallback((systemId: string) => {
    const sys = openSystemsRef.current.find(s => s.dirId === systemId)
    if (!sys) return
    setActiveSystemId(systemId)
    setOrbTarget({ type: 'system', systemId })
  }, [])

  return {
    nodes, openSystems, sessions, tools,
    rootDirId, activeSystemId, orbTarget,
    openDir, closeSystem, closeSystemByTarget, focusSystem, removeSession,
    onCloseDone, onOrbArrived, enterFromOf,
    refreshProjects, refreshMcp,
    projectsRoot, loading,
  }
}
