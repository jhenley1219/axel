import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Build @axel/agent before importing from dist so the tests run against the
// freshly compiled output (mirrors what the live server loads).
const build = spawnSync('pnpm', ['-F', '@axel/agent', 'build'], {
  cwd: REPO,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (build.status !== 0) {
  console.error('build stdout:', build.stdout)
  console.error('build stderr:', build.stderr)
  throw new Error('pnpm -F @axel/agent build failed')
}

const { ReportBroker } = await import(REPO + '/packages/agent/dist/index.js')

// whenReported is the authoritative "child told the master it's done" signal a
// child PTY turn blocks on — the fix for terminals showing "done" while the
// child inside is still working.

test('whenReported resolves when the child submits a report', async () => {
  const broker = new ReportBroker()
  const spawnId = 's1'
  broker.register(spawnId, () => {})

  let resolved = false
  const gate = broker.whenReported(spawnId).then(() => { resolved = true })

  // Not resolved before the report lands.
  await new Promise(r => setTimeout(r, 5))
  assert.equal(resolved, false, 'must stay pending until the child reports')

  const res = broker.submit(spawnId, { summary: 'did the thing' })
  assert.equal(res.ok, true)
  await gate
  assert.equal(resolved, true, 'report call must unblock the waiter')
  assert.equal(broker.wasReported(spawnId), true)
})

test('whenReported resolves immediately if already reported this turn', async () => {
  const broker = new ReportBroker()
  broker.register('s2', () => {})
  broker.submit('s2', { summary: 'done' })
  // Should resolve without anyone else calling submit.
  await broker.whenReported('s2')
  assert.equal(broker.wasReported('s2'), true)
})

test('clearReported makes the next turn wait afresh (not sticky)', async () => {
  const broker = new ReportBroker()
  const spawnId = 's3'
  broker.register(spawnId, () => {})

  // Turn 1: reports.
  broker.submit(spawnId, { summary: 'turn one' })
  assert.equal(broker.wasReported(spawnId), true)

  // Turn 2 starts: forget turn 1's report.
  broker.clearReported(spawnId)
  assert.equal(broker.wasReported(spawnId), false)

  let resolved = false
  const gate = broker.whenReported(spawnId).then(() => { resolved = true })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(resolved, false, 'turn 2 must not complete on turn 1 report')

  broker.submit(spawnId, { summary: 'turn two' })
  await gate
  assert.equal(resolved, true)
})

test('unregister releases a pending waiter (PTY closed mid-turn)', async () => {
  const broker = new ReportBroker()
  const spawnId = 's4'
  broker.register(spawnId, () => {})

  let resolved = false
  const gate = broker.whenReported(spawnId).then(() => { resolved = true })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(resolved, false)

  // Session tears down before the child ever reported — must not hang.
  broker.unregister(spawnId)
  await gate
  assert.equal(resolved, true)
  assert.equal(broker.wasReported(spawnId), false)
})

test('empty summary is rejected and does not resolve the waiter', async () => {
  const broker = new ReportBroker()
  const spawnId = 's5'
  broker.register(spawnId, () => {})

  let resolved = false
  broker.whenReported(spawnId).then(() => { resolved = true })

  const res = broker.submit(spawnId, { summary: '   ' })
  assert.equal(res.ok, false)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(resolved, false, 'a rejected empty report is not a completion')
  assert.equal(broker.wasReported(spawnId), false)
})
