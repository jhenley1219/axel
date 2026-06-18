// Resolves Ref nodes against a Bindings bag, applies pipe filters from a
// fixed allowlist, and runs the optional `map` lookup that lets tone props
// pick a color from a data value (e.g. result.status → 'ok'|'error' → 'lime'|'pink').

import { PIPE_FILTERS, REF_PATH_RE, type Bindings, type Ref, type Value } from './spec.js'

// Walk a dotted path. Returns undefined on any miss — never throws.
function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function applyFilter(value: unknown, filter: string): unknown {
  const [name, ...rest] = filter.split(':')
  const arg = rest.join(':')
  if (!PIPE_FILTERS.has(name)) return value
  if (value == null) return value
  switch (name) {
    case 'truncate': {
      const n = Math.max(1, Number(arg) || 80)
      const s = String(value)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    case 'n': {
      const num = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(num)) return String(value)
      // 1 234 567 → "1,234,567"; 1.23456 → "1.23"
      if (Number.isInteger(num)) return num.toLocaleString()
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }
    case 'json': {
      try { return JSON.stringify(value, null, 2) } catch { return String(value) }
    }
    case 'date': {
      const d = new Date(value as string | number)
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
    }
    default:
      return value
  }
}

// Returns undefined if the ref path is malformed (security: only allowlisted
// shapes resolve; anything else degrades to an empty render).
export function resolveRef(ref: Ref, bag: Bindings): unknown {
  if (!ref || typeof ref.$ !== 'string') return undefined
  if (!REF_PATH_RE.test(ref.$)) return undefined
  const [rawPath, ...filters] = ref.$.split('|').map(s => s.trim())
  // First segment is the scope: input | stream | result. Anything else is
  // out-of-scope and resolves to undefined.
  const [scope, ...rest] = rawPath.split('.')
  let value: unknown
  if (scope === 'input')  value = readPath(bag.input,  rest.join('.'))
  else if (scope === 'stream') value = readPath(bag.stream, rest.join('.'))
  else if (scope === 'result') value = readPath(bag.result, rest.join('.'))
  else return undefined
  for (const f of filters) value = applyFilter(value, f)
  if (ref.map && value != null) return ref.map[String(value)] ?? undefined
  return value
}

// Convenience: resolve any Value (literal | Ref | undefined) to a display string.
export function resolveValue(v: Value, bag: Bindings): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  const r = resolveRef(v, bag)
  return r == null ? undefined : (typeof r === 'string' ? r : String(r))
}
