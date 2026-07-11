import type { BackendMessage, BackendView, ObsRecord, ParsedToolCall, TurnRecord } from './types.js'

export type Scope = { target?: string; term?: string }

// A record belongs to the root view when it carries no target. A target/term
// scope matches records tagged with that target (and term, when given).
export const inScope = (rec: ObsRecord, scope: Scope): boolean => {
  const rt = (rec as { target?: string }).target
  const rtm = (rec as { term?: string }).term
  if (!scope.target) return !rt
  if (rt !== scope.target) return false
  return !scope.term || !rtm || rtm === scope.term
}

// Fold a session feed into a conversation view. Assistant text is rebuilt from
// streamed `token` wire events delimited by `message_end`; `tool_use`/`tool_end`
// become tool calls/results. `turn` records (axel/local runtime) are the
// authoritative raw-output-vs-parsed-calls ground truth and are kept verbatim.
export const reconstruct = (records: Array<ObsRecord>, scope: Scope = {}): BackendView => {
  const messages: Array<BackendMessage> = []
  const turns: Array<TurnRecord> = []

  let asst: { text: string; toolCalls: Array<ParsedToolCall> } | null = null
  const ensureAsst = (): { text: string; toolCalls: Array<ParsedToolCall> } => {
    if (!asst) asst = { text: '', toolCalls: [] }
    return asst
  }
  const flushAsst = (): void => {
    if (asst && (asst.text.length > 0 || asst.toolCalls.length > 0)) {
      messages.push({ role: 'assistant', text: asst.text, toolCalls: asst.toolCalls, ...scopeTag(scope) })
    }
    asst = null
  }

  for (const rec of records) {
    if (!inScope(rec, scope)) continue

    if (rec.kind === 'user_input') {
      flushAsst()
      messages.push({ role: 'user', text: rec.text, source: rec.source, ...scopeTag(scope) })
      continue
    }

    if (rec.kind === 'turn') {
      turns.push(rec)
      continue
    }

    if (rec.kind !== 'wire_event') continue
    const ev = rec.event
    switch (ev.type) {
      case 'token':
        ensureAsst().text += ev.value
        break
      case 'tool_use':
        ensureAsst().toolCalls.push({ id: ev.invocationId, name: ev.name, input: ev.input })
        break
      case 'message_end':
        flushAsst()
        break
      case 'tool_end':
        messages.push({ role: 'tool', invocationId: ev.invocationId, ok: ev.ok, result: ev.result, error: ev.error, ...scopeTag(scope) })
        break
      default:
        break
    }
  }
  flushAsst()

  return { sessionId: records[0]?.sessionId ?? '', target: scope.target, term: scope.term, messages, turns }
}

const scopeTag = (scope: Scope): { target?: string; term?: string } => ({
  ...(scope.target ? { target: scope.target } : {}),
  ...(scope.term ? { term: scope.term } : {}),
})
