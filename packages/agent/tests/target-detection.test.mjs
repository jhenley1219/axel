import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Rebuild @axel/agent before importing dist so the code under test matches src.
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

const { findProjects } = await import(REPO + '/packages/agent/dist/projects.js')

// Directory resolution is no longer done by a keyword matcher — the root agent
// (Claude) reads the project list and opens the repo itself. What stays testable
// is HOW that list is built: findProjects must surface real project roots at any
// depth and never surface a project's internal build/output dirs.

const mkRoot = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-find-')))

test('finds a project nested inside a group folder', async () => {
  const root = mkRoot()
  const proj = path.join(root, 'clients', 'acme-web-app')
  mkdirSync(proj, { recursive: true })
  writeFileSync(path.join(proj, 'package.json'), '{}')

  const found = await findProjects(root)
  assert.ok(found.includes('clients'), 'group folder is openable')
  assert.ok(found.includes('clients/acme-web-app'), 'nested project root indexed by relative path')
})

test('a project is a leaf: its internal dirs are never surfaced', async () => {
  const root = mkRoot()
  const proj = path.join(root, 'clients', 'acme-web-app')
  mkdirSync(path.join(proj, 'apps', 'react-ui'), { recursive: true })
  mkdirSync(path.join(proj, 'src'), { recursive: true })
  mkdirSync(path.join(proj, 'out'), { recursive: true })
  writeFileSync(path.join(proj, 'package.json'), '{}')
  // a nested package.json inside the project must NOT spawn a second candidate
  writeFileSync(path.join(proj, 'apps', 'react-ui', 'package.json'), '{}')

  const found = await findProjects(root)
  assert.ok(found.includes('clients/acme-web-app'), 'the repo itself is indexed')
  assert.ok(!found.some(p => p.includes('/apps') || p.endsWith('/src') || p.endsWith('/out')),
    'internal apps/src/out dirs are not candidates')
})

test('a top-level project with junk subdirs surfaces only itself', async () => {
  const root = mkRoot()
  mkdirSync(path.join(root, 'claude-hub', 'out'), { recursive: true })
  mkdirSync(path.join(root, 'claude-hub', 'src'), { recursive: true })
  mkdirSync(path.join(root, 'claude-hub', 'resources'), { recursive: true })
  writeFileSync(path.join(root, 'claude-hub', 'package.json'), '{}')

  const found = await findProjects(root)
  assert.deepEqual(found, ['claude-hub'], 'only the project root, none of out/src/resources')
})

test('ignored dirs (node_modules) are skipped', async () => {
  const root = mkRoot()
  mkdirSync(path.join(root, 'axel', 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(path.join(root, 'axel', 'package.json'), '{}')
  writeFileSync(path.join(root, 'axel', 'node_modules', 'left-pad', 'package.json'), '{}')

  const found = await findProjects(root)
  assert.deepEqual(found, ['axel'], 'node_modules contents never indexed')
})

test('top-level plain folders (no project marker) are still openable', async () => {
  const root = mkRoot()
  mkdirSync(path.join(root, 'just-notes'), { recursive: true })
  const found = await findProjects(root)
  assert.ok(found.includes('just-notes'), 'a bare top-level dir can still be opened')
})
