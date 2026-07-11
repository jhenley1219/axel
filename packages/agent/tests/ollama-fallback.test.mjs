import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Deterministic, Ollama-free coverage for the text-JSON fallback parser in
// OllamaProvider. The live harness only sees native tool_calls now, so this is
// the test that proves a model which prints its call as TEXT is still recovered.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const build = spawnSync('pnpm', ['-F', '@axel/agent', 'build'], { cwd: REPO, encoding: 'utf8' })
if (build.status !== 0) {
  console.error(build.stdout, build.stderr)
  throw new Error('pnpm -F @axel/agent build failed')
}

const { OllamaProvider } = await import(REPO + '/packages/agent/dist/index.js')

// Build a fake /api/chat NDJSON stream from a list of OllamaChatLine objects.
const fakeFetch = (lines) => async () => ({
  ok: true,
  body: new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + '\n'))
      controller.close()
    },
  }),
})

const collect = async (provider, req) => {
  const events = []
  for await (const ev of provider.stream(req)) events.push(ev)
  return events
}

const GREP_TOOLS = [{ name: 'grep', description: 'search', inputSchema: { type: 'object' } }]
const baseReq = (tools) => ({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools })

test('recovers a tool call printed as TEXT (flat {name, parameters})', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = fakeFetch([
    { message: { role: 'assistant', content: 'I will search. {"name": "grep", "parameters": {"pattern": "test contact"}}' }, done: false },
    { message: { role: 'assistant', content: '' }, done: true },
  ])
  try {
    const events = await collect(new OllamaProvider({}), baseReq(GREP_TOOLS))
    const calls = events.filter((e) => e.type === 'tool_call')
    assert.equal(calls.length, 1, 'one tool call recovered')
    assert.equal(calls[0].name, 'grep')
    assert.equal(calls[0].input.pattern, 'test contact')
  } finally {
    globalThis.fetch = orig
  }
})

test('recovers nested {function:{name, arguments}} shape', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = fakeFetch([
    { message: { role: 'assistant', content: '```json\n{"function": {"name": "grep", "arguments": {"pattern": "x"}}}\n```' }, done: true },
  ])
  try {
    const events = await collect(new OllamaProvider({}), baseReq(GREP_TOOLS))
    const calls = events.filter((e) => e.type === 'tool_call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'grep')
    assert.equal(calls[0].input.pattern, 'x')
  } finally {
    globalThis.fetch = orig
  }
})

test('does NOT misread JSON naming an unknown tool', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = fakeFetch([
    { message: { role: 'assistant', content: 'here is config: {"name": "not_a_tool", "parameters": {}}' }, done: true },
  ])
  try {
    const events = await collect(new OllamaProvider({}), baseReq(GREP_TOOLS))
    assert.equal(events.filter((e) => e.type === 'tool_call').length, 0)
  } finally {
    globalThis.fetch = orig
  }
})

test('does NOT double-fire when a native tool_call is present', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = fakeFetch([
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'grep', arguments: { pattern: 'a' } } }] }, done: false },
    { message: { role: 'assistant', content: '{"name": "grep", "parameters": {"pattern": "b"}}' }, done: true },
  ])
  try {
    const events = await collect(new OllamaProvider({}), baseReq(GREP_TOOLS))
    const calls = events.filter((e) => e.type === 'tool_call')
    assert.equal(calls.length, 1, 'only the native call fires; no fallback double')
    assert.equal(calls[0].input.pattern, 'a')
  } finally {
    globalThis.fetch = orig
  }
})
