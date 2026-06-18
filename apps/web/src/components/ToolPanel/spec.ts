// JSON-described UI DSL for tool hover cards and result panels.
//
// Authors put a `ToolPanelSpec` in their registration's `presentation.hover`
// and `presentation.result` slots. The renderer (ToolPanelRenderer) walks
// the tree, resolves Ref nodes against a live bindings bag (input/stream/
// result), and emits a fixed set of primitives — no React ships per tool.
// Unknown `kind` values degrade to <empty> so forward-compat is automatic.

export type Tone = 'cream' | 'dim' | 'lime' | 'cyan' | 'pink' | 'orange' | 'ok' | 'warn' | 'error' | 'info'

// `{ $: 'result.rows' }`         — read from the bindings bag (with pipe filters: | truncate:80 | n | json | date)
// `{ $: 'result.status', map }`  — same, but pass through the value map (used to pick tone from data)
export type Ref = { $: string; map?: Record<string, string> }

// Anything that can sit in a value slot: a literal string/number, a Ref node,
// or undefined. The renderer normalizes them all to string at render time.
export type Value = string | number | Ref | undefined

export type Spec =
  | { kind: 'text'; value: Value; tone?: Tone | Ref; size?: 'sm' | 'md' | 'lg' }
  | { kind: 'heading'; value: Value; level?: 1 | 2 | 3 }
  | { kind: 'kv'; rows: Array<{ k: Value; v: Value; tone?: Tone | Ref }>; dense?: boolean }
  | { kind: 'code'; value: Value; lang?: string; maxLines?: number }
  | { kind: 'badge'; value: Value; tone: Tone | Ref }
  | { kind: 'link'; href: Value; value: Value }
  | { kind: 'group'; children: Array<Spec>; direction?: 'col' | 'row'; gap?: 'sm' | 'md' | 'lg'; when?: Ref }
  | { kind: 'empty'; value?: Value; icon?: 'dot' | 'spark' | 'warn' }

// Bindings bag — three scopes merged left-to-right. Refs whose path doesn't
// resolve return `undefined`; primitives render their loading/empty state.
export type Bindings = {
  input?: Record<string, unknown>
  stream?: Record<string, unknown>
  result?: Record<string, unknown>
}

// Allowlist of pipe filters. Any unknown filter is dropped silently.
export const PIPE_FILTERS = new Set(['truncate', 'n', 'json', 'date'])

// Dotted-identifier-with-pipes regex. Rejects bracket notation, __proto__,
// computed keys — everything that could escape the binding scope.
export const REF_PATH_RE = /^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*(\s*\|\s*\w+(:[^|]+)?)*$/

// Safe-href schemes. The renderer falls back to plain text if a link fails.
export const SAFE_HREF_RE = /^(https?:|mailto:)/i
