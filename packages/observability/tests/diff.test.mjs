import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const build = spawnSync('pnpm', ['-F', '@axel/observability', 'build'], {
  cwd: REPO,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (build.status !== 0) {
  console.error('build stdout:', build.stdout)
  console.error('build stderr:', build.stderr)
  throw new Error('pnpm -F @axel/observability build failed')
}

const { diffUiVsBackend, reconstruct, looksLikeToolCallJson } = await import(REPO + '/packages/observability/dist/index.js')

// The exact failure mode this package exists to catch: a local model emits a
// tool-call-shaped JSON object as plain text. The harness never parses it into
// a tool call, and the UI renders the raw JSON to the user as a chat bubble.
const TOOL_JSON = '{\n  "name": "grep",\n  "parameters": {\n    "pattern": "test contact",\n    "path": "/path/to/contact"\n  }\n}'

const rec = (seq, kind, extra) => ({ seq, ts: new Date(seq * 1000).toISOString(), sessionId: 's1', kind, ...extra })

test('looksLikeToolCallJson detects tool-call-shaped JSON', () => {
  assert.equal(looksLikeToolCallJson(TOOL_JSON), true)
  assert.equal(looksLikeToolCallJson('To answer this I will use the grep function.'), false)
  assert.equal(looksLikeToolCallJson('{ "foo": 1 }'), false)
})

test('diff surfaces json_as_text when the model emits a tool call as text shown in the UI', () => {
  const records = [
    rec(1, 'session_start', { auth: false, tools: [] }),
    rec(2, 'user_input', { text: 'why is the real contact always showing the test contact?', source: 'main' }),
    rec(3, 'turn', { iteration: 0, rawModelOutput: TOOL_JSON, parsedToolCalls: [], model: 'llama3.1:8b', provider: 'ollama', tier: 'q4-local' }),
    rec(4, 'wire_event', { event: { type: 'token', value: TOOL_JSON } }),
    rec(5, 'wire_event', { event: { type: 'message_end' } }),
    rec(6, 'wire_event', { event: { type: 'done' } }),
  ]
  const ui = {
    capturedAt: new Date().toISOString(),
    messages: [
      { role: 'user', text: 'why is the real contact always showing the test contact?' },
      { role: 'axel', text: TOOL_JSON },
    ],
  }

  const { findings, backend } = diffUiVsBackend(records, ui)
  const jat = findings.find(f => f.kind === 'json_as_text')
  assert.ok(jat, 'expected a json_as_text finding')
  assert.equal(jat.severity, 'mismatch')
  assert.equal(jat.ui, 'rendered as assistant message')
  assert.equal(backend.turns.length, 1)
})

test('diff reports streaming_stuck when the UI is mid-stream after the turn finished', () => {
  const records = [
    rec(1, 'user_input', { text: 'hi', source: 'main' }),
    rec(2, 'wire_event', { event: { type: 'token', value: 'hello' } }),
    rec(3, 'wire_event', { event: { type: 'message_end' } }),
    rec(4, 'wire_event', { event: { type: 'done' } }),
  ]
  const ui = {
    capturedAt: new Date().toISOString(),
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'axel', text: 'hello', streaming: true },
    ],
  }
  const { findings } = diffUiVsBackend(records, ui)
  assert.ok(findings.some(f => f.kind === 'streaming_stuck'))
})

test('reconstruct folds streamed tokens into assistant text', () => {
  const records = [
    rec(1, 'user_input', { text: 'hi', source: 'main' }),
    rec(2, 'wire_event', { event: { type: 'token', value: 'hel' } }),
    rec(3, 'wire_event', { event: { type: 'token', value: 'lo' } }),
    rec(4, 'wire_event', { event: { type: 'message_end' } }),
  ]
  const view = reconstruct(records)
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[0].role, 'user')
  assert.equal(view.messages[1].role, 'assistant')
  assert.equal(view.messages[1].text, 'hello')
})

test('clean session reports no divergence', () => {
  const records = [
    rec(1, 'user_input', { text: 'hi', source: 'main' }),
    rec(2, 'turn', { iteration: 0, rawModelOutput: 'Hello! How can I help?', parsedToolCalls: [], model: 'llama3.1:8b', provider: 'ollama', tier: 'q4-local' }),
    rec(3, 'wire_event', { event: { type: 'token', value: 'Hello! How can I help?' } }),
    rec(4, 'wire_event', { event: { type: 'message_end' } }),
    rec(5, 'wire_event', { event: { type: 'done' } }),
  ]
  const ui = {
    capturedAt: new Date().toISOString(),
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'axel', text: 'Hello! How can I help?' },
    ],
  }
  const { findings } = diffUiVsBackend(records, ui)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'no_divergence')
})
