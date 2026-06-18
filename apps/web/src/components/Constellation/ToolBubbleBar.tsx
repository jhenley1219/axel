// Discrete left-edge rail of tool dots. Tools are hidden until used: a dot
// fades in only while its tool is in flight (or while an app holds persistent
// live state, e.g. a running timer countdown), pulses green while active, then
// flashes + fades back out a moment after the call finishes. Click a dot to
// pin its details popover (anchored to the right); apps (timer/notes) instead
// open their control panel on click.
//
// Concurrency: each invocation is tracked independently, so two calls to the
// same tool don't cancel each other's flash. Dots mount/unmount on a flex
// column keyed by `tool.name`, so an arriving dot does NOT remount siblings.

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { InstalledToolView } from '@axel/agent'
import type { ToolInvocation } from '../../hooks/useVoiceInterface.js'
import { ToolPanelRenderer } from '../ToolPanel/ToolPanelRenderer.js'
import type { Bindings } from '../ToolPanel/spec.js'

const FLASH_MS = 900
const HOVER_DWELL_MS = 180

type Props = {
  tools: Array<InstalledToolView>
  activeInvocations: Array<ToolInvocation>
  // Set of tool names with persistent live state (e.g. "timer" when a
  // countdown is running). Keeps the dot present + tinted even when no
  // tool_use is currently in flight — the app keeps ticking after the
  // start_timer call returns.
  activeApps?: Set<string>
  // Click handler for the dot itself. Returns true when it consumed the click
  // by opening an app panel (timer/notes); falsy means "not an app", and the
  // rail falls back to pinning the details popover.
  onBubbleClick?: (tool: InstalledToolView) => boolean | void
}

type AnchoredTool = { tool: InstalledToolView; anchor: DOMRect } | null

export function ToolBubbleBar({ tools, activeInvocations, activeApps, onBubbleClick }: Props): React.ReactElement | null {
  const [hover, setHover] = useState<AnchoredTool>(null)
  const [pinned, setPinned] = useState<AnchoredTool>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel dwell on unmount so a popover that's about to fire doesn't try to
  // setState into a torn-down rail.
  useEffect(() => () => { if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current) }, [])

  // Group invocations by tool name so each dot reads its own slice without
  // re-rendering on every sibling's events.
  const invocationsByTool = useMemo(() => {
    const map = new Map<string, Array<ToolInvocation>>()
    for (const inv of activeInvocations) {
      const list = map.get(inv.toolName)
      if (list) list.push(inv)
      else map.set(inv.toolName, [inv])
    }
    return map
  }, [activeInvocations])

  // Hidden until used: only tools with a live/recent invocation or persistent
  // app state get a dot. Preserve the registry order for stable stacking.
  const activeTools = useMemo(
    () => tools.filter(t => invocationsByTool.has(t.name) || (activeApps?.has(t.name) ?? false)),
    [tools, invocationsByTool, activeApps],
  )

  // Drop a pinned/hovered popover whose dot is no longer on screen.
  useEffect(() => {
    const live = new Set(activeTools.map(t => t.name))
    if (pinned && !live.has(pinned.tool.name)) setPinned(null)
    if (hover && !live.has(hover.tool.name)) setHover(null)
  }, [activeTools, pinned, hover])

  // Outside-click dismisses a pinned popover.
  useEffect(() => {
    if (!pinned) return
    const onDocPointerDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.tbar-host, .tp-pop')) return
      setPinned(null)
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true)
  }, [pinned])

  const onHoverIn = useCallback((tool: InstalledToolView, el: HTMLElement) => {
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = setTimeout(() => {
      setHover({ tool, anchor: el.getBoundingClientRect() })
    }, HOVER_DWELL_MS)
  }, [])
  const onHoverOut = useCallback(() => {
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = null
    setHover(null)
  }, [])

  const onDotClick = useCallback((tool: InstalledToolView, el: HTMLElement) => {
    // Apps consume the click by opening their panel; everything else toggles
    // a pinned details popover.
    if (onBubbleClick?.(tool)) { setPinned(null); setHover(null); return }
    setPinned(prev => (prev?.tool.name === tool.name ? null : { tool, anchor: el.getBoundingClientRect() }))
  }, [onBubbleClick])

  if (activeTools.length === 0) return null

  const shown = pinned ?? hover

  return (
    <div className="tbar-host">
      {activeTools.map(tool => (
        <ToolDot
          key={tool.name}
          tool={tool}
          invocations={invocationsByTool.get(tool.name) ?? []}
          isActive={activeApps?.has(tool.name) ?? false}
          isPinned={pinned?.tool.name === tool.name}
          onHoverIn={onHoverIn}
          onHoverOut={onHoverOut}
          onClick={onDotClick}
        />
      ))}
      {shown && <DetailPopover state={shown} />}
    </div>
  )
}

// Portal-mounted popover anchored to the RIGHT of the dot, vertically centered
// on it. Renders the tool's `presentation.hover` JSON spec if present, else a
// fallback summary card built from label + description.
function DetailPopover({ state }: { state: { tool: InstalledToolView; anchor: DOMRect } }): React.ReactElement | null {
  if (typeof document === 'undefined') return null
  const { tool, anchor } = state
  const left = anchor.right
  const top = anchor.top + anchor.height / 2
  const bag: Bindings = { input: {}, stream: {}, result: {} }
  const hoverSpec = tool.presentation?.hover
  return createPortal(
    <div className="tp-pop tp-anchor-right" style={{ left, top }} role="tooltip">
      {hoverSpec
        ? <ToolPanelRenderer spec={hoverSpec} bag={bag} />
        : <FallbackHover tool={tool} />
      }
    </div>,
    document.body,
  )
}

function FallbackHover({ tool }: { tool: InstalledToolView }): React.ReactElement {
  const label = tool.presentation?.label ?? tool.name
  const summary = tool.presentation?.summary ?? tool.description ?? ''
  return (
    <>
      <div className="tp-heading tp-h2">{label}</div>
      {summary && <div className="tp-text tp-tone-dim">{summary}</div>}
    </>
  )
}

type DotProps = {
  tool: InstalledToolView
  invocations: Array<ToolInvocation>
  isActive: boolean
  isPinned: boolean
  onHoverIn: (tool: InstalledToolView, el: HTMLElement) => void
  onHoverOut: () => void
  onClick: (tool: InstalledToolView, el: HTMLElement) => void
}

function ToolDot({ tool, invocations, isActive, isPinned, onHoverIn, onHoverOut, onClick }: DotProps): React.ReactElement {
  const now = performance.now()
  // Two slices: in-flight (no endedAt) drive the looping pulse; within-flash-
  // window (endedAt set and < FLASH_MS ago) drive the post-call bloom + fade.
  const inflight = invocations.filter(inv => inv.endedAt === undefined)
  const flashing = invocations.filter(inv => inv.endedAt !== undefined && now - inv.endedAt < FLASH_MS)
  const lastFlash = flashing[flashing.length - 1]

  const label = tool.presentation?.label ?? tool.name
  const summary = tool.presentation?.summary ?? tool.description ?? ''

  const cls = [
    'tbar-item',
    inflight.length > 0 ? 'is-invoking' : '',
    lastFlash ? (lastFlash.ok === false ? 'is-flash is-error' : 'is-flash') : '',
    isActive ? 'is-active' : '',
    isPinned ? 'is-pinned' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={cls}
      title={summary || label}
      aria-label={label}
      aria-expanded={isPinned}
      onPointerEnter={e => { if (e.pointerType === 'mouse') onHoverIn(tool, e.currentTarget) }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') onHoverOut() }}
      onFocus={e => onHoverIn(tool, e.currentTarget)}
      onBlur={() => onHoverOut()}
      onClick={e => onClick(tool, e.currentTarget)}
    >
      <span className="tbar-dot" aria-hidden="true" />
      <span className="tbar-label">{label}</span>
      {inflight.length > 1 && <span className="tbar-count" aria-label={`${inflight.length} concurrent calls`}>{inflight.length}</span>}
    </button>
  )
}
