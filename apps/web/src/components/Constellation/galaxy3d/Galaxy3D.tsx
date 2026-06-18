// React wrapper for the 3D galaxy view. Owns no tree state — it translates the
// real constellation state (open systems, nodes, orb pipeline, orb target)
// into the imperative scene's sync payload, and routes scene picks back to the
// same handlers the 2D view uses. The 2D engine stays mounted as the state
// authority (close/arrive callbacks); this is purely an alternate render skin.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ringRadius } from '../layout/computeLayout.js'
import { visibleChildDirs } from '../layout/orbiters.js'
import { dotColor } from '../fileStars.js'
import { buildCloud3D, cloudTintHex } from '../cloud.js'
import { cssColor } from './ax3d.js'
import { computeLayout3D } from './layout3d.js'
import {
  buildGalaxyScene, type ContextPick, type FileTetherEnd, type GalaxyApi, type GalaxySystem, type RingAnchor,
} from './galaxyScene.js'
import type { FileStar } from '../StarSystem.js'
import type { FsNode, OpenSystem, OrbTarget } from '../../../types/constellation.js'
import type { OrbState } from '../../Voice/VoiceOrb.js'

// The template scales the 2D ring-radius rule ×1.6 in space
const R3D = 1.6

type Props = {
  openSystems: Array<OpenSystem>
  nodes: Map<string, FsNode>
  rootDirId: string
  effectiveActive: string
  hotIds: Set<string>
  openIds: Set<string>
  projectsRoot: string | null
  orbState: OrbState
  orbTarget: OrbTarget
  fileTethers: Array<FileTetherEnd>
  ringAnchors: Array<RingAnchor>
  onFocusSystem: (id: string) => void
  onOpenSubdir: (name: string, fromSystemId: string) => void
  onFileClick: (f: FileStar, systemId: string) => void
  onFiles: (dirId: string, clientX: number, clientY: number) => void
  onTap: () => void
  onContextPick: (pick: ContextPick, clientX: number, clientY: number) => void
}

export function Galaxy3D(props: Props): React.ReactElement {
  const {
    openSystems, nodes, rootDirId, effectiveActive, hotIds, openIds,
    projectsRoot, orbState, orbTarget, fileTethers, ringAnchors,
  } = props

  const hostRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<GalaxyApi | null>(null)
  const [pivot, setPivot] = useState('agent')

  // Latest handlers + pick lookup without re-mounting the scene
  const propsRef = useRef(props)
  propsRef.current = props

  const systems = useMemo(() => {
    const rOf = (dirId: string): number => {
      const node = nodes.get(dirId)
      const count = (node?.children?.length ?? 0) + (node?.files?.length ?? 0)
      return ringRadius(count, 1) * R3D
    }
    const placements = computeLayout3D(openSystems, rootDirId, rOf)

    const out: Array<GalaxySystem> = []
    for (const s of openSystems) {
      const node = nodes.get(s.dirId)
      const place = placements.get(s.dirId)
      if (!node || !place) continue
      const isRoot = s.dirId === rootDirId
      const r = rOf(s.dirId)
      const dirs = visibleChildDirs(nodes, s.dirId)
      const openedChildCount = openSystems.filter(x => x.parentSystemId === s.dirId && !x.closing).length
      out.push({
        dirId: s.dirId,
        parentId: s.parentSystemId,
        name: isRoot ? (projectsRoot?.split('/').filter(Boolean).pop() ?? '~/projects') : node.name,
        sub: isRoot
          ? `${dirs.length} projects · ${openedChildCount} open`
          : `${dirs.length} dirs · ${node.files?.length ?? node.fileCount ?? 0} files`,
        color: cssColor(dotColor(node)),
        r,
        closing: !!s.closing,
        attended: s.dirId === effectiveActive,
        hot: hotIds.has(s.dirId),
        pos: place.pos,
        tilt: place.tilt,
        orbiters: dirs
          .filter(d => !openIds.has(d.id))
          .map(d => ({ name: d.name, color: cssColor(dotColor(d)) })),
        // Files moved to the FilePicker dropdown — the 3D scene no longer
        // renders per-file diamonds. The empty array keeps the scene plumbing
        // alive (parent classes still iterate it as no-ops).
        files: [],
        // Probability-cloud ribbon — particles seeded by node.id so the
        // scatter is stable across renders. Colors mirror the dir's file-type
        // distribution; empty dirs get a faint cream atmosphere.
        cloud: buildCloud3D(node, r),
        cloudTint: cloudTintHex(node),
      })
    }
    return out
  }, [openSystems, nodes, rootDirId, effectiveActive, hotIds, openIds, projectsRoot])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = buildGalaxyScene(host, {
      onFocusSystem: id => propsRef.current.onFocusSystem(id),
      onOpenSubdir: (name, fromId) => propsRef.current.onOpenSubdir(name, fromId),
      // File-diamond clicks no longer exist (no glyphs to click). Kept as a
      // no-op so the scene-side callback contract stays uniform — the actual
      // open-file path now runs through `onFiles` + the React FilePicker.
      onFileClick: () => {},
      onFiles: (dirId, x, y) => propsRef.current.onFiles(dirId, x, y),
      onOrbTap: () => propsRef.current.onTap(),
      onFollow: (follow, focus) => setPivot(follow ? 'agent' : focus),
      onContextPick: (pick, x, y) => propsRef.current.onContextPick(pick, x, y),
    })
    apiRef.current = api
    return () => { api.dispose(); apiRef.current = null }
  }, [])

  useEffect(() => { apiRef.current?.sync(systems) }, [systems])
  useEffect(() => { apiRef.current?.setAgentState(orbState) }, [orbState])

  const agentTargetId = orbTarget.type === 'home' ? null : orbTarget.systemId
  useEffect(() => { apiRef.current?.setAgentTarget(agentTargetId) }, [agentTargetId])
  useEffect(() => { apiRef.current?.setFileTethers(fileTethers) }, [fileTethers])
  useEffect(() => { apiRef.current?.setRingAnchors(ringAnchors) }, [ringAnchors])

  return (
    <div className="gx-host" ref={hostRef}>
      <div className="gx-pivot">
        <span className={'gx-pivot-dot' + (pivot === 'agent' ? '' : ' free')} />
        {pivot === 'agent' ? 'orbiting the agent' : `free pivot · ${pivot}`}
      </div>
    </div>
  )
}
