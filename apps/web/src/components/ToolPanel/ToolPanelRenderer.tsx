// Renders a ToolPanelSpec (the JSON DSL) against a Bindings bag. Pure
// switch-on-kind, closed enum — any unknown kind falls through to <empty>
// so newer specs degrade cleanly on older clients. NEVER uses
// dangerouslySetInnerHTML; never evaluates strings; href schemes are
// allowlisted; everything else is plain text in React's default JSX escape.

import React from 'react'
import type { Bindings, Spec, Tone, Value } from './spec.js'
import { SAFE_HREF_RE } from './spec.js'
import { resolveRef, resolveValue } from './bindings.js'

type Props = { spec: unknown; bag: Bindings }

// Resolve a tone prop that may be a literal or a Ref (with a `map` lookup).
function resolveTone(t: Tone | { $: string; map?: Record<string, string> } | undefined, bag: Bindings): Tone | undefined {
  if (!t) return undefined
  if (typeof t === 'string') return t
  const r = resolveRef(t, bag)
  return typeof r === 'string' ? (r as Tone) : undefined
}

export function ToolPanelRenderer({ spec, bag }: Props): React.ReactElement | null {
  return <Node spec={spec} bag={bag} />
}

function Node({ spec, bag }: { spec: unknown; bag: Bindings }): React.ReactElement | null {
  if (!spec || typeof spec !== 'object') return null
  const s = spec as Spec
  switch (s.kind) {
    case 'text': {
      const v = resolveValue(s.value as Value, bag)
      if (v == null) return null
      const tone = resolveTone(s.tone, bag)
      const size = s.size ?? 'md'
      return <span className={`tp-text tp-size-${size}${tone ? ` tp-tone-${tone}` : ''}`}>{v}</span>
    }
    case 'heading': {
      const v = resolveValue(s.value as Value, bag)
      if (v == null) return null
      const level = s.level ?? 2
      return <div className={`tp-heading tp-h${level}`}>{v}</div>
    }
    case 'kv': {
      const rows = (s.rows ?? []).map((r, i) => {
        const key   = resolveValue(r.k as Value, bag)
        const value = resolveValue(r.v as Value, bag)
        if (value == null) return null
        const tone = resolveTone(r.tone, bag)
        return (
          <div key={i} className={`tp-kv-row${tone ? ` tp-tone-${tone}` : ''}`}>
            <span className="tp-kv-k">{key ?? ''}</span>
            <span className="tp-kv-v">{value}</span>
          </div>
        )
      }).filter(Boolean)
      if (rows.length === 0) return null
      return <div className={`tp-kv${s.dense ? ' tp-dense' : ''}`}>{rows}</div>
    }
    case 'code': {
      const v = resolveValue(s.value as Value, bag)
      if (v == null) return null
      const max = s.maxLines && s.maxLines > 0 ? s.maxLines : undefined
      const text = max ? v.split('\n').slice(0, max).join('\n') : v
      return (
        <pre className="tp-code" data-lang={s.lang ?? ''}>
          <code>{text}</code>
        </pre>
      )
    }
    case 'badge': {
      const v = resolveValue(s.value as Value, bag)
      if (v == null) return null
      const tone = resolveTone(s.tone, bag) ?? 'info'
      return <span className={`tp-badge tp-tone-${tone}`}>{v}</span>
    }
    case 'link': {
      const href = resolveValue(s.href as Value, bag)
      const v    = resolveValue(s.value as Value, bag) ?? href
      if (!href || !v) return null
      if (!SAFE_HREF_RE.test(href)) return <span className="tp-text">{v}</span>
      return <a className="tp-link" href={href} target="_blank" rel="noopener noreferrer">{v}</a>
    }
    case 'group': {
      if (s.when) {
        const gate = resolveRef(s.when, bag)
        if (!gate) return null
      }
      const dir = s.direction ?? 'col'
      const gap = s.gap ?? 'md'
      return (
        <div className={`tp-group tp-dir-${dir} tp-gap-${gap}`}>
          {(s.children ?? []).map((c, i) => <Node key={i} spec={c} bag={bag} />)}
        </div>
      )
    }
    case 'empty': {
      const v = resolveValue(s.value as Value, bag) ?? '—'
      return <div className={`tp-empty tp-empty-${s.icon ?? 'dot'}`}>{v}</div>
    }
    default:
      return <div className="tp-empty tp-empty-dot">—</div>
  }
}
