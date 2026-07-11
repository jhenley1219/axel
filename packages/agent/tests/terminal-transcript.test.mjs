import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Build @axel/agent so the tests run against freshly compiled dist output
// (mirrors terminal-reuse.test.mjs and what the live server loads).
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

const { AgentOrchestrator, readClaudeTranscript, slugForCwd } = await import(REPO + '/packages/agent/dist/index.js')

const makeTempDir = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-tx-')))

// open_terminal dispatches the child run detached (void handleDirMessage); the
// stub child run emits synchronously, so a short flush lets pty_ready land in
// the orchestrator's transcript locators before we read.
const settle = () => new Promise(r => setTimeout(r, 30))

// Write a synthetic Claude JSONL session file under <root>/<slug(cwd)>/<id>.jsonl.
const writeTranscript = (root, cwd, id, lines) => {
  const dir = path.join(root, slugForCwd(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

const userLine = text => ({ type: 'user', message: { role: 'user', content: text } })
const asstText = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const asstTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } })
const toolResult = text => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } })

// ---- unit: the reader flattens + concatenates the whole session-id chain ----
test('readClaudeTranscript flattens user/assistant/tool records into clean prose', () => {
  const root = makeTempDir()
  const cwd = '/tmp/proj-a'
  writeTranscript(root, cwd, 'sess-1', [
    { type: 'last-prompt', leafUuid: 'x', sessionId: 'sess-1' }, // meta — ignored
    userLine('why is the CRM lookup failing?'),
    asstTool('grep', { pattern: 'contactId' }),
    toolResult('src/crm.ts:42 uses the test contact id'),
    asstText('The lookup is pinned to the test contact.'),
  ])

  const out = readClaudeTranscript({ cwd, sessionIds: ['sess-1'], projectsRoot: root })
  assert.match(out, /user: why is the CRM lookup failing\?/)
  assert.match(out, /\[tool: grep/)
  assert.match(out, /\[result: src\/crm\.ts:42/)
  assert.match(out, /assistant: The lookup is pinned to the test contact\./)
  assert.doesNotMatch(out, /last-prompt/)
})

test('readClaudeTranscript concatenates a multi-session restart chain in order', () => {
  const root = makeTempDir()
  const cwd = '/tmp/proj-b'
  writeTranscript(root, cwd, 'sess-old', [userLine('first task'), asstText('before restart')])
  writeTranscript(root, cwd, 'sess-new', [userLine('follow up'), asstText('after resume')])

  const out = readClaudeTranscript({ cwd, sessionIds: ['sess-old', 'sess-new'], projectsRoot: root })
  assert.ok(out.indexOf('before restart') < out.indexOf('after resume'), 'chain preserves order')
})

test('readClaudeTranscript keeps the tail and marks truncation when over maxChars', () => {
  const root = makeTempDir()
  const cwd = '/tmp/proj-c'
  writeTranscript(root, cwd, 'sess-1', [userLine('X'.repeat(500)), asstText('LAST_LINE_MARKER')])
  const out = readClaudeTranscript({ cwd, sessionIds: ['sess-1'], projectsRoot: root, maxChars: 100 })
  assert.match(out, /earlier chars truncated/)
  assert.match(out, /LAST_LINE_MARKER/)
})

test('readClaudeTranscript returns empty (never throws) for a missing file', () => {
  const root = makeTempDir()
  const out = readClaudeTranscript({ cwd: '/tmp/nope', sessionIds: ['does-not-exist'], projectsRoot: root })
  assert.equal(out, '')
})

// ---- integration: read_terminal serves the full transcript via the orchestrator ----
// Drive a root run to capture its terminal + read handlers. Each child terminal
// runs under a per-term claude id (claude-<term>). With emitPtyReady the child
// announces its transcript locator like PtyAgent; with manualPeekId it stays
// silent and the read path must recover the id from peek() — the manual /
// dir_input case the user hit.
const writeTermTranscript = (projectsRoot, projDir, term, lines) =>
  writeTranscript(projectsRoot, projDir, `claude-${term}`, lines)

const driveOrchestrator = async (opts = {}) => {
  const { emitPtyReady = true, manualPeekId = null } = opts
  const root = makeTempDir()
  mkdirSync(path.join(root, 'proj'))
  const projDir = path.join(root, 'proj')
  const captured = { term: null, read: null }

  const stubRuntime = {
    async run(_msg, _rid, _sid, onEvent, _onAuth, _sys, projectsDirOverride, _allowed, termHandler, _fileH, _cleanup, queueRole, readHandler) {
      if (!queueRole || queueRole.role === 'root') {
        if (!captured.term && termHandler) captured.term = termHandler
        if (!captured.read && readHandler) captured.read = readHandler
      }
      if (queueRole && queueRole.role === 'child') {
        if (emitPtyReady) {
          onEvent({ type: 'pty_ready', spawnId: `spawn-${queueRole.term}`, claudeSessionId: `claude-${queueRole.term}`, cwd: projectsDirOverride })
        }
        onEvent({ type: 'message_end' })
        return `spawn-${queueRole.term}`
      }
      onEvent({ type: 'message_end' })
      return undefined
    },
    async probe() { return null },
    peek() {
      // Simulate a live PTY exposing its claude session id (the manual path).
      return manualPeekId ? { strippedTail: '', turnText: '', claudeSessionId: manualPeekId, cwd: projDir } : null
    },
  }

  const orch = new AgentOrchestrator({
    projectsDir: root,
    allowedDirs: [root],
    auditLogPath: path.join(makeTempDir(), 'audit.jsonl'),
    getAgent: () => stubRuntime,
  })
  await orch.handleMessage('hi', 'sess-int', () => {}, () => {})
  assert.ok(captured.term && captured.read, 'root run must expose terminal + read handlers')
  return { captured, projDir }
}

test('read_terminal returns the full persisted conversation (source: full)', async () => {
  const projectsRoot = makeTempDir()
  process.env.AXEL_CLAUDE_PROJECTS_ROOT = projectsRoot
  try {
    const { captured, projDir } = await driveOrchestrator()
    const open = await captured.term({ directory: 'proj', prompt: 'diagnose the crm pairing' })
    assert.equal(open.ok, true)
    await settle()
    writeTermTranscript(projectsRoot, projDir, open.term, [
      userLine('why is this email not paired to a crm contact?'),
      asstText('Because the association is keyed on the test contact id.'),
    ])

    const res = await captured.read({ target: 'proj' })
    assert.equal(res.ok, true)
    assert.equal(res.source, 'full', 'full transcript is the authoritative source')
    assert.match(res.text, /why is this email not paired to a crm contact\?/)
    assert.match(res.text, /keyed on the test contact id/)
  } finally {
    delete process.env.AXEL_CLAUDE_PROJECTS_ROOT
  }
})

test('read_terminal with no term enumerates every terminal open for the target', async () => {
  const projectsRoot = makeTempDir()
  process.env.AXEL_CLAUDE_PROJECTS_ROOT = projectsRoot
  try {
    const { captured, projDir } = await driveOrchestrator()
    const a = await captured.term({ directory: 'proj', prompt: 'first task' })
    const b = await captured.term({ directory: 'proj', prompt: 'second, unrelated task', new: true })
    assert.notEqual(a.term, b.term, 'two distinct terminals opened')
    await settle()
    writeTermTranscript(projectsRoot, projDir, a.term, [userLine('task A'), asstText('did A')])
    writeTermTranscript(projectsRoot, projDir, b.term, [userLine('task B'), asstText('did B')])

    const res = await captured.read({ target: 'proj' })
    assert.equal(res.ok, true)
    assert.match(res.text, /2 terminals open for proj/, 'lists the open terminals')
    assert.match(res.text, new RegExp(a.term))
    assert.match(res.text, new RegExp(b.term))
  } finally {
    delete process.env.AXEL_CLAUDE_PROJECTS_ROOT
  }
})

// The exact original failure: the user's meaningful terminal was OLDER than the
// empty terminals the agent later spawned. Reading with no term must return the
// terminal that actually has content, not the most-recent empty one.
test('read_terminal (no term) returns the terminal with content, not the newest empty one', async () => {
  const projectsRoot = makeTempDir()
  process.env.AXEL_CLAUDE_PROJECTS_ROOT = projectsRoot
  try {
    const { captured, projDir } = await driveOrchestrator()
    const withContent = await captured.term({ directory: 'proj', prompt: 'the real task' })
    await settle()
    writeTermTranscript(projectsRoot, projDir, withContent.term, [
      userLine('the CRM customer is not being found'),
      asstText('It resolves to the test contact instead of the real one.'),
    ])
    const newerEmpty = await captured.term({ directory: 'proj', prompt: 'a later, empty spawn', new: true })
    await settle()
    assert.notEqual(withContent.term, newerEmpty.term)

    const res = await captured.read({ target: 'proj' })
    assert.equal(res.ok, true)
    assert.equal(res.source, 'full')
    assert.equal(res.term, withContent.term, 'picked the terminal that has content')
    assert.match(res.text, /test contact instead of the real one/)
  } finally {
    delete process.env.AXEL_CLAUDE_PROJECTS_ROOT
  }
})

// The manual case: a terminal driven by hand (no pty_ready recorded). The read
// path must recover the claude session id from the live PTY via peek() and
// still return the FULL transcript — even while the terminal is "working".
test('read_terminal reads a manually-driven terminal via the live peek() session id', async () => {
  const projectsRoot = makeTempDir()
  process.env.AXEL_CLAUDE_PROJECTS_ROOT = projectsRoot
  try {
    const { captured, projDir } = await driveOrchestrator({ emitPtyReady: false, manualPeekId: 'claude-manual' })
    const open = await captured.term({ directory: 'proj', prompt: 'user typed this by hand' })
    assert.equal(open.ok, true)
    await settle()
    // No pty_ready fired, so no locator was recorded — only peek() knows the id.
    writeTranscript(projectsRoot, projDir, 'claude-manual', [
      userLine('why is the CRM lookup failing?'),
      asstText('The lookup is pinned to the test contact.'),
    ])

    const res = await captured.read({ target: 'proj' })
    assert.equal(res.ok, true)
    assert.equal(res.source, 'full', 'recovered the transcript via peek() session id')
    assert.match(res.text, /why is the CRM lookup failing\?/)
    assert.match(res.text, /pinned to the test contact/)
  } finally {
    delete process.env.AXEL_CLAUDE_PROJECTS_ROOT
  }
})
