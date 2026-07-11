import { inScope, reconstruct, type Scope } from './reconstruct.js'
import type { BackendView, DiffFinding, ObsRecord, UiSnapshot } from './types.js'

const TOOL_NAME_RE = /"name"\s*:\s*"[^"]+"/
const TOOL_ARGS_RE = /"(parameters|arguments|input)"\s*:/

// The classic failure signature: prose or a code fence containing a JSON
// object shaped like a tool call (a "name" plus a parameters/arguments/input
// object) that the harness never turned into an actual tool call.
export const looksLikeToolCallJson = (text: string): boolean =>
  !!text && TOOL_NAME_RE.test(text) && TOOL_ARGS_RE.test(text)

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

const overlaps = (a: string, b: string): boolean => {
  const na = norm(a)
  const nb = norm(b)
  if (na.length < 20 || nb.length < 20) return false
  return na.includes(nb.slice(0, 40)) || nb.includes(na.slice(0, 40))
}

const doneTargets = (records: Array<ObsRecord>): Set<string> => {
  const set = new Set<string>()
  for (const r of records) {
    if (r.kind === 'wire_event' && r.event.type === 'target_done' && r.event.target) {
      set.add(`${r.event.target} ${r.event.term ?? 'main'}`)
    }
  }
  return set
}

const hasCompletionAfterLastInput = (records: Array<ObsRecord>, scope: Scope): boolean => {
  let lastInputSeq = -1
  for (const r of records) {
    if (r.kind === 'user_input' && inScope(r, scope)) lastInputSeq = r.seq
  }
  for (const r of records) {
    if (r.seq <= lastInputSeq) continue
    if (r.kind === 'wire_event' && (r.event.type === 'done' || r.event.type === 'message_end') && inScope(r, scope)) return true
  }
  return false
}

// Compare what the backend actually produced against what the UI last
// reported. Returns the reconstructed backend view alongside the findings so
// the caller can show both sides of any divergence.
export const diffUiVsBackend = (
  records: Array<ObsRecord>,
  ui: UiSnapshot | null,
  scope: Scope = {},
): { backend: BackendView; ui: UiSnapshot | null; findings: Array<DiffFinding> } => {
  const backend = reconstruct(records, scope)
  const findings: Array<DiffFinding> = []

  // A. Tool-call JSON emitted as text (turn records are authoritative).
  for (const t of backend.turns) {
    if (t.parsedToolCalls.length === 0 && looksLikeToolCallJson(t.rawModelOutput)) {
      const shown = !!ui && ui.messages.some(m => m.role !== 'user' && overlaps(m.text, t.rawModelOutput))
      findings.push({
        severity: 'mismatch',
        kind: 'json_as_text',
        detail: `Iteration ${t.iteration}: model (${t.provider}/${t.model}) emitted tool-call-shaped JSON as plain text; no tool call was parsed${shown ? ', and it was rendered to the user as a chat message' : ''}.`,
        backend: { rawModelOutput: t.rawModelOutput.slice(0, 500) },
        ui: shown ? 'rendered as assistant message' : 'not matched in UI messages',
      })
    }
  }
  // Fallback for runtimes without turn records (claude-code subprocess).
  if (backend.turns.length === 0) {
    for (const m of backend.messages) {
      if (m.role === 'assistant' && m.toolCalls.length === 0 && looksLikeToolCallJson(m.text)) {
        findings.push({
          severity: 'warn',
          kind: 'json_as_text',
          detail: 'An assistant message contains tool-call-shaped JSON but no tool call was recorded for it.',
          backend: { text: m.text.slice(0, 500) },
        })
      }
    }
  }

  if (ui) {
    // B. Assistant message count drift.
    const backendAsst = backend.messages.filter(m => m.role === 'assistant').length
    const uiAsst = ui.messages.filter(m => m.role !== 'user').length
    if (backendAsst !== uiAsst) {
      findings.push({
        severity: 'warn',
        kind: 'assistant_count_mismatch',
        detail: `Backend produced ${backendAsst} assistant message(s); UI shows ${uiAsst}.`,
        backend: backendAsst,
        ui: uiAsst,
      })
    }

    // C. Stuck streaming flag after the turn finished.
    const stuck = ui.messages.filter(m => m.streaming)
    if (stuck.length > 0 && hasCompletionAfterLastInput(records, scope)) {
      findings.push({
        severity: 'warn',
        kind: 'streaming_stuck',
        detail: `UI still marks ${stuck.length} message(s) as streaming, but the backend turn completed (done/message_end seen).`,
        ui: stuck.map(m => m.text.slice(0, 80)),
      })
    }

    // D. Target stuck "working" after the backend reported it done.
    if (ui.targetStatus) {
      const done = doneTargets(records)
      for (const [key, status] of Object.entries(ui.targetStatus)) {
        if (status === 'working' && done.has(key)) {
          findings.push({
            severity: 'warn',
            kind: 'status_stuck',
            detail: `UI shows target "${key}" as working, but the backend emitted target_done for it.`,
            ui: key,
          })
        }
      }
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: 'info', kind: 'no_divergence', detail: 'No UI-vs-backend divergence detected by current heuristics.' })
  }

  return { backend, ui, findings }
}
