import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Rebuild @axel/observability before importing dist so the code under test
// matches src. Assumes @axel/agent + @axel/core dist already exist (pnpm build).
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

const { ObservabilityRecorder, SessionReader } = await import(REPO + '/packages/observability/dist/index.js')

test('recorder writes a chronological feed + meta that the reader can read back', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'axel-obs-'))
  const rec = new ObservabilityRecorder(dir)
  const sid = 'sess-abc'

  rec.sessionStart(sid, { auth: false, tools: [] })
  rec.userInput(sid, { text: 'hello there', source: 'main' })
  rec.turn(sid, { iteration: 0, rawModelOutput: 'hi', parsedToolCalls: [], model: 'llama3.1:8b', provider: 'ollama', tier: 'q4-local' })
  rec.wireEvent(sid, { type: 'token', value: 'hi' })
  rec.wireEvent(sid, { type: 'message_end' })
  rec.uiSnapshot(sid, { capturedAt: new Date().toISOString(), messages: [{ role: 'user', text: 'hello there' }, { role: 'axel', text: 'hi' }] })
  await rec.flush()

  const reader = new SessionReader(dir)

  const sessions = reader.listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, sid)
  assert.equal(sessions[0].recordCount, 6)
  assert.equal(sessions[0].lastUserInput, 'hello there')

  const feed = reader.readFeed(sid)
  assert.equal(feed.length, 6)
  assert.deepEqual(feed.map(r => r.seq), [1, 2, 3, 4, 5, 6])
  assert.equal(feed[0].kind, 'session_start')
  assert.equal(feed[1].kind, 'user_input')
  assert.equal(feed[2].kind, 'turn')

  const onlyTurns = reader.readFeed(sid, { kinds: ['turn'] })
  assert.equal(onlyTurns.length, 1)

  const ui = reader.latestUiSnapshot(sid)
  assert.ok(ui)
  assert.equal(ui.messages.length, 2)

  assert.ok(existsSync(path.join(dir, 'sessions', sid, 'meta.json')))
  assert.ok(existsSync(path.join(dir, 'sessions', sid, 'events.jsonl')))
  const meta = JSON.parse(readFileSync(path.join(dir, 'sessions', sid, 'meta.json'), 'utf-8'))
  assert.equal(meta.lastSeq, 6)
})

test('unsafe session ids are confined to a sanitized directory (no traversal)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'axel-obs-'))
  const rec = new ObservabilityRecorder(dir)
  rec.userInput('../../etc/passwd', { text: 'x', source: 'plain' })
  await rec.flush()

  // Exactly one dir, directly under sessions/, with no path separators.
  const dirs = readdirSync(path.join(dir, 'sessions'))
  assert.equal(dirs.length, 1)
  assert.ok(!dirs[0].includes('/') && !dirs[0].includes(path.sep))

  // The feed still round-trips when queried by the original (unsafe) id.
  const reader = new SessionReader(dir)
  assert.equal(reader.readFeed('../../etc/passwd').length, 1)
})
