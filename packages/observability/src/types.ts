import type { AgentWireMessage, InstalledToolView } from '@axel/agent'

// ── Recorded feed ───────────────────────────────────────────────────────────
// One append-only events.jsonl per session. Every record carries a monotonic
// `seq`, an ISO `ts`, and the owning `sessionId`. The discriminant is `kind`.

export type RecordKind =
  | 'session_start'
  | 'user_input'
  | 'control_input'
  | 'wire_event'
  | 'turn'
  | 'ui_snapshot'
  | 'session_reset'

type Base = { seq: number; ts: string; sessionId: string }

export type UserInputSource = 'main' | 'dir' | 'plain' | 'wake'

export type ParsedToolCall = { id: string; name: string; input: unknown }

export type SessionStartRecord = Base & {
  kind: 'session_start'
  auth: boolean
  tools: Array<InstalledToolView>
}

export type UserInputRecord = Base & {
  kind: 'user_input'
  text: string
  source: UserInputSource
  uiLocation?: string
  target?: string
  term?: string
}

export type ControlInputRecord = Base & {
  kind: 'control_input'
  controlType: string
  payload: unknown
}

export type WireEventRecord = Base & {
  kind: 'wire_event'
  event: AgentWireMessage
  target?: string
  term?: string
}

// Agent-internal ground truth (axel/local-model runtime only): the exact text
// the provider streamed this iteration vs. the tool calls actually parsed out
// of it. The gap between the two is the silent tool-call-drop failure mode.
export type TurnRecord = Base & {
  kind: 'turn'
  iteration: number
  rawModelOutput: string
  parsedToolCalls: Array<ParsedToolCall>
  model: string
  provider: string
  tier: string
  target?: string
  term?: string
}

export type UiSnapshotRecord = Base & {
  kind: 'ui_snapshot'
  snapshot: UiSnapshot
}

export type SessionResetRecord = Base & { kind: 'session_reset' }

export type ObsRecord =
  | SessionStartRecord
  | UserInputRecord
  | ControlInputRecord
  | WireEventRecord
  | TurnRecord
  | UiSnapshotRecord
  | SessionResetRecord

// Distributive omit so each union member keeps its own discriminated fields
// (a plain Omit over a union collapses to the shared keys only).
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

// Fields the recorder fills in; convenience methods accept the rest.
export type ObsRecordInput = DistributiveOmit<ObsRecord, 'seq' | 'ts' | 'sessionId'>

// ── UI snapshot (shipped from the web client) ───────────────────────────────

export type UiMessage = { role: string; text: string; streaming?: boolean; target?: string }

export type UiInvocation = { invocationId: string; name: string; target?: string; ok?: boolean }

export type UiSnapshot = {
  capturedAt: string
  orbState?: string
  messages: Array<UiMessage>
  targetMessages?: Record<string, Array<UiMessage>>
  targetStatus?: Record<string, string>
  activeInvocations?: Array<UiInvocation>
  permissionRequests?: Record<string, Array<unknown>>
  questionRequests?: Record<string, Array<unknown>>
  fanOut?: unknown
  currentTarget?: string | null
  // Constellation nav state — which ring the orb is actually inside. This is the
  // UI state that diverges from the backend's open target for nested projects.
  constellation?: {
    activeSystemId?: string | null
    orbTarget?: unknown
    openSystems?: Array<{ dirId: string; parentSystemId?: string }>
  }
  installedToolCount?: number
}

// ── Session index (meta.json) ───────────────────────────────────────────────

export type SessionMeta = {
  sessionId: string
  createdAt: string
  updatedAt: string
  recordCount: number
  lastSeq: number
  lastUserInput?: string
  lastUiSnapshotAt?: string
}

// ── Reconstructed backend view ──────────────────────────────────────────────

export type BackendMessage =
  | { role: 'user'; text: string; source?: UserInputSource; target?: string; term?: string }
  | { role: 'assistant'; text: string; toolCalls: Array<ParsedToolCall>; target?: string; term?: string }
  | { role: 'tool'; invocationId?: string; name?: string; ok?: boolean; result?: unknown; error?: string; target?: string; term?: string }

export type BackendView = {
  sessionId: string
  target?: string
  term?: string
  messages: Array<BackendMessage>
  turns: Array<TurnRecord>
}

// ── Diff output ─────────────────────────────────────────────────────────────

export type DiffSeverity = 'info' | 'warn' | 'mismatch'

export type DiffFinding = {
  severity: DiffSeverity
  kind: string
  detail: string
  backend?: unknown
  ui?: unknown
}
