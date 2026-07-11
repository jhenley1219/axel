import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const { AgentOrchestrator } = await import(REPO + '/packages/agent/dist/index.js')

function makeTempDir() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-term-')))
}

// Capture the root spawn's open_terminal handler by stubbing the runtime. Only
// the FIRST handler is kept so a detached child run (which passes its own
// restricted handler) can't clobber it.
async function rootTerminalHandler(root) {
  mkdirSync(path.join(root, 'proj'))
  let handler = null
  const stubRuntime = {
    async run(_msg, _rid, _sid, onEvent, _onAuth, _sys, _pd, _ad, termHandler) {
      if (!handler && termHandler) handler = termHandler
      onEvent({ type: 'message_end' })
      return undefined
    },
    async probe() { return null },
  }
  const orch = new AgentOrchestrator({
    projectsDir: root,
    allowedDirs: [root],
    auditLogPath: path.join(makeTempDir(), 'audit.jsonl'),
    getAgent: () => stubRuntime,
  })
  await orch.handleMessage('hi', 'sess-a', () => {}, () => {})
  assert.ok(handler, 'root run must receive an open_terminal handler')
  return handler
}

// REUSE IS THE DEFAULT: a follow-up prompt with no term continues the target's
// existing terminal — you talk TO the terminal, you don't stack a new tab per
// message. (This intentionally reverses the old "no term = fresh" behavior.)
test('a prompted open with no term REUSES the target\'s existing terminal', async () => {
  const handler = await rootTerminalHandler(makeTempDir())

  const r1 = await handler({ directory: 'proj', prompt: 'first task' })
  assert.equal(r1.ok, true)
  assert.equal(r1.reused, false, 'first open of the dir is fresh')

  const r2 = await handler({ directory: 'proj', prompt: 'a follow-up, no term given' })
  assert.equal(r2.ok, true)
  assert.equal(r2.reused, true, 'a follow-up with no term must continue the existing terminal')
  assert.equal(r2.term, r1.term, 'the follow-up lands in the same terminal')
})

// The escape hatch: `new: true` forces a fresh parallel terminal.
test('new: true spawns a FRESH terminal for parallel work', async () => {
  const handler = await rootTerminalHandler(makeTempDir())

  const r1 = await handler({ directory: 'proj', prompt: 'first task' })
  const r2 = await handler({ directory: 'proj', prompt: 'a separate parallel task', new: true })
  assert.equal(r2.reused, false, 'new:true must not reuse')
  assert.notEqual(r2.term, r1.term, 'parallel work gets its own fresh terminal id')
})

// A bare "open X" with no task must not stack an empty duplicate tab.
test('a bare refocus (no prompt) reuses the existing tab', async () => {
  const handler = await rootTerminalHandler(makeTempDir())

  const r1 = await handler({ directory: 'proj', prompt: 'task' })
  const r2 = await handler({ directory: 'proj' })
  assert.equal(r2.reused, true, 'bare open X refocuses the existing tab')
  assert.equal(r2.term, r1.term, 'refocus lands on the most-recent tab, no new id')
})

// An explicit term is always honoured as a follow-up to that specific tab.
test('an explicit term routes to that terminal', async () => {
  const handler = await rootTerminalHandler(makeTempDir())

  const r1 = await handler({ directory: 'proj', prompt: 'task' })
  const r2 = await handler({ directory: 'proj', term: r1.term, prompt: 'follow-up' })
  assert.equal(r2.term, r1.term, 'explicit term stays on that tab')
  assert.equal(r2.reused, true, 'explicit known term reads as reused')
})
