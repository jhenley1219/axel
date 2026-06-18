import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
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

const {
  Conversation,
  SessionStore,
  ToolRegistry,
  readFile: readFileTool,
  writeFile: writeFileTool,
  editFile,
  listDir,
  glob,
  bashTool,
  buildDefaultRegistry,
  AxelAgent,
  PermissionBroker,
} = await import(REPO + '/packages/agent/dist/index.js')

const { AuditLogger } = await import(REPO + '/packages/core/dist/index.js')

const makeTempDir = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-phase-b-')))

const makeLogger = () => {
  const dir = makeTempDir()
  return new AuditLogger(path.join(dir, 'audit.jsonl'))
}

test('Conversation.addUser/addAssistant/addToolResult preserves order', () => {
  const c = new Conversation()
  c.addUser('hello')
  c.addAssistant('thinking...', [{ id: 'call-1', name: 'read_file', input: { path: 'x.txt' } }])
  c.addToolResult('call-1', 'contents')
  c.addAssistant('done')

  const msgs = c.toMessages()
  assert.equal(msgs.length, 4)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[0].content, 'hello')

  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content, 'thinking...')
  assert.ok(Array.isArray(msgs[1].toolCalls))
  assert.equal(msgs[1].toolCalls.length, 1)
  assert.equal(msgs[1].toolCalls[0].id, 'call-1')
  assert.equal(msgs[1].toolCalls[0].name, 'read_file')

  assert.equal(msgs[2].role, 'tool')
  assert.equal(msgs[2].toolCallId, 'call-1')
  assert.equal(msgs[2].content, 'contents')

  assert.equal(msgs[3].role, 'assistant')
  assert.equal(msgs[3].content, 'done')
  assert.ok(msgs[3].toolCalls === undefined)
})

test('Conversation.addAssistant without toolCalls omits toolCalls field', () => {
  const c = new Conversation()
  c.addAssistant('plain reply')
  c.addAssistant('empty list', [])
  const msgs = c.toMessages()
  assert.equal(msgs[0].toolCalls, undefined)
  assert.equal(msgs[1].toolCalls, undefined)
})

test('SessionStore evicts entries after TTL with fake clock', () => {
  let now = 0
  const ttl = 1000
  const store = new SessionStore(() => now, ttl)

  const a = store.get('alice')
  a.addUser('first')

  now = 500
  const aAgain = store.get('alice')
  assert.equal(aAgain, a, 'within TTL should return same conversation')
  assert.equal(aAgain.toMessages().length, 1)

  // Advance past TTL — touch a different key so sweep runs over alice.
  now = 500 + ttl + 1
  store.get('bob')
  // alice was last touched at 500; now > 500 + ttl → evicted.
  // New get returns a fresh Conversation with no history.
  const aFresh = store.get('alice')
  assert.notEqual(aFresh, a, 'past TTL should return a new conversation')
  assert.equal(aFresh.toMessages().length, 0)
})

test('read_file: reads file under sandbox; rejects out-of-bounds', async () => {
  const dir = makeTempDir()
  const fp = path.join(dir, 'note.txt')
  writeFileSync(fp, 'hello world')

  const ok = await readFileTool.execute({ path: fp }, { allowedDirs: [dir], cwd: dir })
  assert.equal(ok.ok, true)
  assert.equal(ok.output, 'hello world')

  const outside = makeTempDir()
  const bad = path.join(outside, 'evil.txt')
  writeFileSync(bad, 'nope')
  const fail = await readFileTool.execute({ path: bad }, { allowedDirs: [dir], cwd: dir })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /outside allowed dirs/)
})

test('write_file: writes under sandbox; rejects out-of-bounds', async () => {
  const dir = makeTempDir()
  const fp = path.join(dir, 'sub', 'a.txt')
  const ok = await writeFileTool.execute({ path: fp, content: 'data' }, { allowedDirs: [dir], cwd: dir })
  assert.equal(ok.ok, true)
  assert.equal(readFileSync(fp, 'utf8'), 'data')

  const outside = makeTempDir()
  const bad = path.join(outside, 'a.txt')
  const fail = await writeFileTool.execute({ path: bad, content: 'no' }, { allowedDirs: [dir], cwd: dir })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /outside allowed dirs/)
})

test('edit_file: replaces unique old_string; out-of-bounds rejected', async () => {
  const dir = makeTempDir()
  const fp = path.join(dir, 'src.txt')
  writeFileSync(fp, 'foo bar baz')
  const ok = await editFile.execute(
    { path: fp, old_string: 'bar', new_string: 'qux' },
    { allowedDirs: [dir], cwd: dir },
  )
  assert.equal(ok.ok, true)
  assert.equal(readFileSync(fp, 'utf8'), 'foo qux baz')

  const outside = makeTempDir()
  const bad = path.join(outside, 'x.txt')
  writeFileSync(bad, 'x')
  const fail = await editFile.execute(
    { path: bad, old_string: 'x', new_string: 'y' },
    { allowedDirs: [dir], cwd: dir },
  )
  assert.equal(fail.ok, false)
  assert.match(fail.error, /outside allowed dirs/)
})

test('list_dir: lists entries under sandbox; rejects out-of-bounds', async () => {
  const dir = makeTempDir()
  writeFileSync(path.join(dir, 'a.txt'), '')
  mkdirSync(path.join(dir, 'sub'))
  const ok = await listDir.execute({ path: dir }, { allowedDirs: [dir], cwd: dir })
  assert.equal(ok.ok, true)
  assert.ok(ok.output.includes('file\ta.txt'))
  assert.ok(ok.output.includes('dir\tsub'))

  const outside = makeTempDir()
  const fail = await listDir.execute({ path: outside }, { allowedDirs: [dir], cwd: dir })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /outside allowed dirs/)
})

test('glob: finds files matching pattern; rejects out-of-bounds root', async () => {
  const dir = makeTempDir()
  writeFileSync(path.join(dir, 'a.ts'), '')
  writeFileSync(path.join(dir, 'b.js'), '')
  mkdirSync(path.join(dir, 'nested'))
  writeFileSync(path.join(dir, 'nested', 'c.ts'), '')

  const ok = await glob.execute({ pattern: '**/*.ts', root: dir }, { allowedDirs: [dir], cwd: dir })
  assert.equal(ok.ok, true)
  const lines = ok.output.split('\n').filter(Boolean).sort()
  assert.deepEqual(lines, ['a.ts', 'nested/c.ts'])

  const outside = makeTempDir()
  const fail = await glob.execute({ pattern: '*', root: outside }, { allowedDirs: [dir], cwd: dir })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /outside allowed dirs/)
})

test('bash: echo succeeds, exit 1 errors, timeout kills long sleep', async () => {
  const dir = makeTempDir()
  const ctx = { allowedDirs: [dir], cwd: dir }

  const ok = await bashTool.execute({ command: 'echo hi' }, ctx)
  assert.equal(ok.ok, true)
  assert.match(ok.output, /^hi/)

  const fail = await bashTool.execute({ command: 'exit 1' }, ctx)
  assert.equal(fail.ok, false)
  assert.match(fail.error, /exit 1/)

  const timed = await bashTool.execute({ command: 'sleep 5', timeout_ms: 250 }, ctx)
  assert.equal(timed.ok, false)
  assert.match(timed.error, /timeout after 250ms/)
})

test('ToolRegistry: register/get/list', () => {
  const reg = new ToolRegistry()
  const fake = {
    name: 'foo',
    description: 'd',
    inputSchema: { type: 'object' },
    execute: async () => ({ ok: true, output: 'ok' }),
  }
  reg.register(fake)
  assert.equal(reg.get('foo'), fake)
  assert.equal(reg.get('missing'), undefined)
  const list = reg.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'foo')

  const def = buildDefaultRegistry()
  const names = def.list().map(t => t.name).sort()
  for (const expected of ['bash', 'edit_file', 'glob', 'grep', 'list_dir', 'read_file', 'write_file']) {
    assert.ok(names.includes(expected), 'default registry should include ' + expected)
  }
})

test('AxelAgent: one tool_call (read_file) then text — emits tool_use, token, message_end', async () => {
  const dir = makeTempDir()
  const fp = path.join(dir, 'note.txt')
  writeFileSync(fp, 'pong')

  const calls = []
  let round = 0
  const fakeProvider = {
    name: 'ollama',
    async probe() { return null },
    stream(req) {
      const r = round++
      calls.push({ messages: req.messages.map(m => m.role) })
      // Round 0: emit one tool_call then end.
      // Round 1: emit two tokens then end (after seeing the tool result).
      const events = r === 0
        ? [
            { type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: fp } },
            { type: 'end' },
          ]
        : [
            { type: 'token', value: 'the file says ' },
            { type: 'token', value: 'pong' },
            { type: 'end' },
          ]
      return (async function* () {
        for (const ev of events) yield ev
      })()
    },
  }

  const broker = new PermissionBroker()
  const unsubscribe = broker.onRequest(req => {
    broker.resolve(req.id, 'allow')
  })

  const registry = buildDefaultRegistry()
  const sessionStore = new SessionStore(() => 0, 60_000)
  const logger = makeLogger()

  const agent = new AxelAgent(
    dir,
    [dir],
    logger,
    () => fakeProvider,
    {
      registry,
      sessionStore,
      permissionBroker: broker,
      getPermissionMode: () => 'default',
      getTier: () => 'frontier',
    },
  )

  const events = []
  const axelSid = 'axel-test-1'
  const result = await agent.run(
    'read the file',
    undefined,
    axelSid,
    ev => events.push(ev),
    () => {},
    'system',
    dir,
    [dir],
  )
  unsubscribe()

  assert.equal(typeof result, 'string', 'run returns a session uuid string')

  const tokens = events.filter(e => e.type === 'token')
  const toolUses = events.filter(e => e.type === 'tool_use')
  const messageEnds = events.filter(e => e.type === 'message_end')

  assert.ok(tokens.length >= 1, 'expected at least one token event')
  assert.equal(toolUses.length, 1, 'expected exactly one tool_use event')
  assert.equal(toolUses[0].name, 'read_file')
  assert.equal(messageEnds.length, 1, 'expected exactly one message_end')

  const conv = sessionStore.get(axelSid)
  const msgs = conv.toMessages()
  // Expect: user, assistant (with toolCall), tool (result), assistant (final text)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[0].content, 'read the file')

  assert.equal(msgs[1].role, 'assistant')
  assert.ok(Array.isArray(msgs[1].toolCalls))
  assert.equal(msgs[1].toolCalls.length, 1)
  assert.equal(msgs[1].toolCalls[0].name, 'read_file')

  assert.equal(msgs[2].role, 'tool')
  assert.equal(msgs[2].toolCallId, 'call-1')
  assert.equal(msgs[2].content, 'pong')

  assert.equal(msgs[3].role, 'assistant')
  assert.equal(msgs[3].content, 'the file says pong')

  assert.equal(round, 2, 'provider.stream invoked twice (tool round + final round)')
})
