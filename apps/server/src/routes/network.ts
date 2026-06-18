import { Router } from 'express'
import { readdir, readFile, writeFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { IGNORED_DIRS, OllamaProvider } from '@axel/agent'
import { isPathUnder } from '@axel/core'
import type { AppSettings, FileEntry, McpListItem, ProjectItem } from '@axel/core'
import { config } from '../config.js'
import { sessionGuard } from '../middleware/sessionGuard.js'
import { mcpRegistry, settingsManager } from '../services.js'

export const networkRouter = Router()

const LANG_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
  swift: 'swift', kt: 'kotlin', php: 'php', md: 'md', json: 'json',
}

function detectLang(files: Array<string>): string | undefined {
  const counts = new Map<string, number>()
  for (const f of files) {
    const ext = f.split('.').pop()?.toLowerCase() ?? ''
    const lang = LANG_EXT[ext]
    if (!lang) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

const execFileP = promisify(execFile)
const GIT_BUF = 4 * 1024 * 1024
const FILE_MAX = 1024 * 1024

// Tracked entries directly inside `dir` (git ls-files paths are cwd-relative),
// or null when dir is not inside a git repo.
async function gitTrackedIn(dir: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'ls-files'], { maxBuffer: GIT_BUF })
    return new Set(stdout.split('\n').filter(Boolean).map(p => p.split('/')[0]))
  } catch { return null }
}

async function listFiles(dir: string, entries: Array<Dirent>): Promise<Array<FileEntry>> {
  const names = entries
    .filter(e => e.isFile() && !IGNORED_DIRS.has(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b))
  if (!names.length) return []
  const tracked = await gitTrackedIn(dir)
  return names.map(name => ({ name, path: path.join(dir, name), tracked: tracked?.has(name) ?? false }))
}

// Only files under the projects root (or an explicitly allowed dir) may be read/written
async function allowedFileRoots(): Promise<Array<string>> {
  const settings = await settingsManager.getSettings()
  const roots = [settings.projectsRoot, ...config.allowedDirs].filter((r): r is string => !!r)
  return roots.map(r => path.resolve(r))
}

// Directory browser — lets the client navigate the server filesystem to pick a root
// Best starting directory for the file browser — prefer the host user's home
// (mounted at the same path as on the host) over the container's own home.
async function defaultBrowsePath(): Promise<string> {
  // On macOS the host home mounts under /Users; on Linux under /home
  for (const candidate of ['/Users', '/home']) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true })
      if (entries.some(e => e.isDirectory())) return candidate
    } catch { /* not present */ }
  }
  return process.env.HOME ?? '/'
}

networkRouter.get('/api/fs/browse', sessionGuard, async (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path : await defaultBrowsePath()
  const requested = path.resolve(rawPath)

  // Walk up to the nearest readable ancestor so a stale/missing path doesn't dead-end the browser.
  let browsePath = requested
  let entries: Dirent[] = []
  let read = false
  while (!read) {
    try {
      entries = await readdir(browsePath, { withFileTypes: true })
      read = true
    } catch {
      const parent = path.dirname(browsePath)
      if (parent === browsePath) {
        res.status(400).json({ ok: false, error: 'not_readable', path: requested })
        return
      }
      browsePath = parent
    }
  }

  const dirs = entries
    .filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map(e => ({ name: e.name, path: path.join(browsePath, e.name) }))
    .sort((a, b) => {
      const aHidden = a.name.startsWith('.')
      const bHidden = b.name.startsWith('.')
      if (aHidden !== bHidden) return aHidden ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  const parent = path.dirname(browsePath)
  const fellBack = browsePath !== requested
  const files = await listFiles(browsePath, entries)
  res.json({
    ok: true,
    path: browsePath,
    parent: parent !== browsePath ? parent : null,
    dirs,
    files,
    ...(fellBack ? { fellBackFrom: requested } : {}),
  })
})

// Read a file plus its git context: content, tracked?, and the HEAD version (for diffs)
networkRouter.get('/api/fs/file', sessionGuard, async (req, res) => {
  if (typeof req.query.path !== 'string') {
    res.status(400).json({ ok: false, error: 'missing_path' })
    return
  }
  const file = path.resolve(req.query.path)
  if (!isPathUnder(file, await allowedFileRoots())) {
    res.status(403).json({ ok: false, error: 'outside_root' })
    return
  }
  try {
    const st = await stat(file)
    if (!st.isFile()) { res.status(400).json({ ok: false, error: 'not_a_file' }); return }
    if (st.size > FILE_MAX) { res.status(413).json({ ok: false, error: 'too_large' }); return }
    const content = await readFile(file, 'utf8')
    if (content.includes('\u0000')) { res.status(415).json({ ok: false, error: 'binary' }); return }

    const dir = path.dirname(file)
    let tracked = false
    let head: string | null = null
    try {
      const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { maxBuffer: GIT_BUF })
      const toplevel = stdout.trim()
      const rel = path.relative(toplevel, file)
      await execFileP('git', ['-C', toplevel, 'ls-files', '--error-unmatch', rel], { maxBuffer: GIT_BUF })
      tracked = true
      // Fails for tracked-but-never-committed files — head stays null, diff disabled
      const shown = await execFileP('git', ['-C', toplevel, 'show', `HEAD:${rel}`], { maxBuffer: GIT_BUF })
      head = shown.stdout
    } catch { /* not a repo / untracked / no HEAD version */ }

    res.json({ ok: true, content, tracked, head })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    res.status(500).json({ ok: false, error: 'read_failed', message: msg })
  }
})

// Save edits back to disk — IDE-style; only existing files under the projects root
networkRouter.put('/api/fs/file', sessionGuard, async (req, res) => {
  const { path: rawPath, content } = (req.body ?? {}) as { path?: unknown; content?: unknown }
  if (typeof rawPath !== 'string' || typeof content !== 'string') {
    res.status(400).json({ ok: false, error: 'invalid_body' })
    return
  }
  if (content.length > FILE_MAX) {
    res.status(413).json({ ok: false, error: 'too_large' })
    return
  }
  const file = path.resolve(rawPath)
  if (!isPathUnder(file, await allowedFileRoots())) {
    res.status(403).json({ ok: false, error: 'outside_root' })
    return
  }
  try {
    const st = await stat(file)
    if (!st.isFile()) { res.status(400).json({ ok: false, error: 'not_a_file' }); return }
    await writeFile(file, content, 'utf8')
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    res.status(500).json({ ok: false, error: 'write_failed', message: msg })
  }
})

networkRouter.get('/api/fs/projects', sessionGuard, async (_req, res) => {
  const settings = await settingsManager.getSettings()
  const root = settings.projectsRoot ?? config.allowedDirs[0]
  if (!root) {
    res.json({ ok: true, root: null, items: [] })
    return
  }
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const items: Array<ProjectItem> = []
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (ent.name.startsWith('.') || IGNORED_DIRS.has(ent.name)) continue
      const full = path.join(root, ent.name)
      let fileCount = 0
      let detected: string | undefined
      try {
        const inner = await readdir(full)
        fileCount = inner.length
        detected = detectLang(inner)
      } catch { /* unreadable — show with count 0 */ }
      items.push({ id: `dir-${ent.name}`, name: ent.name, path: full, fileCount, lang: detected })
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    const files = await listFiles(root, entries)
    res.json({ ok: true, root, items, files })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    res.status(500).json({ ok: false, error: 'scan_failed', message: msg, root })
  }
})

networkRouter.get('/api/mcp/list', sessionGuard, async (_req, res) => {
  try {
    const regs = await mcpRegistry.load()
    res.json({
      ok: true,
      registryDir: config.mcpRegistryDir,
      items: regs.map((r): McpListItem => ({
        id: `tool-${r.name}`,
        name: r.name,
        kind: r.kind,
        endpoint: r.kind === 'http' ? r.url : `${r.command}${r.args?.length ? ' ' + r.args.join(' ') : ''}`,
        description: r.description ?? null,
        addDir: r.addDir ?? null,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    res.status(500).json({ ok: false, error: 'mcp_list_failed', message: msg })
  }
})

networkRouter.get('/api/settings', sessionGuard, async (_req, res) => {
  const s = await settingsManager.getSettings()
  res.json({
    ok: true,
    settings: settingsManager.getRedactedSettings(s),
    hasKeys: Object.fromEntries(Object.entries(s.apiKeys ?? {}).map(([k, v]) => [k, Boolean(v)])),
    projectsRoot: s.projectsRoot ?? config.allowedDirs[0] ?? null,
    mcpRegistryDir: config.mcpRegistryDir,
  })
})

networkRouter.put('/api/settings', sessionGuard, async (req, res) => {
  const body = req.body as Partial<AppSettings>
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'invalid_body' })
    return
  }
  const next = await settingsManager.updateSettings(body)
  res.json({ ok: true, settings: settingsManager.getRedactedSettings(next) })
})

// Lists the models installed on the user's local Ollama daemon. Returns
// ok:false when the daemon is unreachable so the UI can surface a hint
// rather than silently empty the picker.
networkRouter.get('/api/runtime/ollama/models', sessionGuard, async (_req, res) => {
  const s = await settingsManager.getSettings()
  const baseURL = s.runtimeBaseURL || undefined
  try {
    const models = await new OllamaProvider({ baseURL }).listModels()
    res.json({ ok: true, models })
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// Pulls an Ollama model. Streams NDJSON progress lines back to the client;
// the browser parses them with body.getReader(). Closing the HTTP connection
// does NOT cancel the pull on the daemon — Ollama finishes the download and
// the next /models scan will surface it.
networkRouter.post('/api/runtime/ollama/pull', sessionGuard, async (req, res) => {
  const body = req.body as { name?: unknown }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) {
    res.status(400).json({ ok: false, error: 'missing model name' })
    return
  }
  const s = await settingsManager.getSettings()
  const baseURL = s.runtimeBaseURL || undefined
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  const controller = new AbortController()
  // Best-effort: if the client disconnects we abort the upstream fetch so we
  // don't keep parsing a stream nobody is reading. The pull itself continues
  // server-side on the Ollama daemon.
  req.on('close', () => controller.abort())
  try {
    for await (const ev of new OllamaProvider({ baseURL }).pullModel(name, controller.signal)) {
      res.write(JSON.stringify(ev) + '\n')
      if (ev.type === 'done' || ev.type === 'error') break
    }
  } catch (err) {
    res.write(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }) + '\n')
  } finally {
    res.end()
  }
})
