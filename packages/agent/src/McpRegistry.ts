import { readdir, readFile, mkdir, writeFile } from 'fs/promises'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import { watch as fsWatch, type FSWatcher } from 'fs'
import path from 'path'
import type { InstalledToolView, ToolPresentation } from './types.js'

// HTTP-transport MCP — a long-running web server the agent connects to.
export type HttpRegistration = {
  kind: 'http'
  name: string
  url: string
  token?: string
  description?: string
  addDir?: string
  presentation?: ToolPresentation
}

// Stdio-transport MCP — claude spawns the binary per invocation.
export type StdioRegistration = {
  kind: 'stdio'
  name: string
  command: string
  args?: Array<string>
  env?: Record<string, string>
  description?: string
  addDir?: string
  presentation?: ToolPresentation
}

export type AppRegistration = HttpRegistration | StdioRegistration

// Loose shape on disk — we accept several historical / agent-invented field
// names and normalize them to AppRegistration.
type RawRegistration = {
  name?: string
  url?: string
  token?: string
  description?: string
  addDir?: string
  presentation?: ToolPresentation
  // stdio fields
  transport?: 'http' | 'stdio' | string
  type?: 'http' | 'stdio' | string
  command?: string
  args?: Array<string>
  env?: Record<string, string>
}

function normalize(raw: RawRegistration): AppRegistration | null {
  if (!raw.name) return null
  const description = raw.description
  const addDir = raw.addDir
  const presentation = raw.presentation
  const explicitType = (raw.transport ?? raw.type)?.toLowerCase()
  const looksStdio = explicitType === 'stdio' || (!raw.url && !!raw.command)
  if (looksStdio) {
    if (!raw.command) return null
    return {
      kind: 'stdio',
      name: raw.name,
      command: raw.command,
      args: raw.args,
      env: raw.env,
      description, addDir, presentation,
    }
  }
  if (!raw.url) return null
  return {
    kind: 'http',
    name: raw.name,
    url: raw.url,
    token: raw.token,
    description, addDir, presentation,
  }
}

// Built-in tools the agent always has — surfaced in the bubble bar so the user
// can see "you already have these" before installing anything. Names match the
// MCP tool names the orchestrator wires in (axel_files.open_file etc.).
export const BUILTIN_TOOLS: ReadonlyArray<InstalledToolView> = [
  {
    name: 'open_file',
    kind: 'builtin',
    description: 'Surface a file to you with optional highlights and a one-shot suggestion.',
    presentation: { label: 'file', icon: 'file', accent: 'var(--cyan)', summary: 'Surface a file you can review and accept inline.' },
  },
  {
    name: 'open_terminal',
    kind: 'builtin',
    description: 'Open a terminal tab in a project directory and optionally hand it a prompt.',
    presentation: { label: 'term', icon: 'terminal', accent: 'var(--lime)', summary: 'Open a project terminal.' },
  },
  {
    name: 'timer',
    kind: 'builtin',
    description: 'A timer app you can start, pause, resume, or cancel by voice or by clicking the bubble.',
    presentation: { label: 'timer', icon: 'spark', accent: 'var(--orange)', summary: 'Pomodoro-style countdown timer.' },
  },
  {
    name: 'notes',
    kind: 'builtin',
    description: 'A shared scratchpad. Read, write, or append text via the agent or by clicking the bubble.',
    presentation: { label: 'notes', icon: 'gear', accent: 'var(--purp)', summary: 'Persistent scratchpad shared with the agent.' },
  },
  {
    name: 'close_idle_dirs',
    kind: 'builtin',
    description: 'Close any open project directories that have no live work (no running runs, no queued runs, no open terminals or file popups).',
    presentation: { label: 'cleanup', icon: 'broom', accent: 'var(--cyan)', summary: 'Tidy up idle project directories.' },
  },
]

export type McpServerEntry =
  | { type: 'http'; url: string; headers?: Record<string, string>; timeout?: number }
  | { type: 'stdio'; command: string; args?: Array<string>; env?: Record<string, string> }

type McpConfigFile = {
  mcpServers: Record<string, McpServerEntry>
}

export const DEFAULT_REGISTRY_DIR = path.join(homedir(), '.axel', 'mcp-registry')

export class McpRegistry {
  constructor(private dir: string = DEFAULT_REGISTRY_DIR) {}

  async load(): Promise<Array<AppRegistration>> {
    try {
      await mkdir(this.dir, { recursive: true })
      const files = await readdir(this.dir)
      const regs: Array<AppRegistration> = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await readFile(path.join(this.dir, file), 'utf-8')
          const parsed = JSON.parse(raw) as RawRegistration
          const normalized = normalize(parsed)
          if (normalized) regs.push(normalized)
        } catch { /* skip malformed */ }
      }
      return regs
    } catch {
      return []
    }
  }

  // Generates a temp --mcp-config file for a claude invocation.
  // Emits the right transport per entry so newly-created MCPs work on the
  // very next agent message — no app restart, just drop a registration JSON.
  // `extra` adds per-spawn entries (e.g. the permission-prompt bridge) on top
  // of the registered apps.
  async generateConfig(extra?: Record<string, McpServerEntry>): Promise<{
    configPath: string | null
    addDirs: Array<string>
    cleanup: () => void
  }> {
    const regs = await this.load()
    const addDirs = regs.flatMap(r => r.addDir ? [r.addDir] : [])

    if (regs.length === 0 && !extra) {
      return { configPath: null, addDirs, cleanup: () => {} }
    }

    const config: McpConfigFile = { mcpServers: {} }
    for (const reg of regs) {
      if (reg.kind === 'http') {
        config.mcpServers[reg.name] = {
          type: 'http',
          url: reg.url,
          ...(reg.token ? { headers: { Authorization: `Bearer ${reg.token}` } } : {}),
          timeout: 30_000,
        }
      } else {
        config.mcpServers[reg.name] = {
          type: 'stdio',
          command: reg.command,
          ...(reg.args ? { args: reg.args } : {}),
          ...(reg.env  ? { env:  reg.env  } : {}),
        }
      }
    }
    // Applied last so a registry file can't shadow a per-spawn entry (e.g.
    // hijack the permission-prompt bridge by registering the same name).
    Object.assign(config.mcpServers, extra)

    const configPath = path.join(tmpdir(), `axel-mcp-${randomUUID()}.json`)
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })

    return {
      configPath,
      addDirs,
      cleanup: () => { unlink(configPath).catch(() => {}) },
    }
  }

  async summary(): Promise<string> {
    const regs = await this.load()
    if (regs.length === 0) return 'No apps registered.'
    return regs
      .map(r => {
        const where = r.kind === 'http' ? r.url : `stdio: ${r.command}`
        return `- **${r.name}** (${where})${r.description ? `: ${r.description}` : ''}`
      })
      .join('\n')
  }

  // Built-ins first, then everything on disk. Stable order so bubble-bar
  // siblings keep their layout slot across refreshes.
  async listView(): Promise<Array<InstalledToolView>> {
    const regs = await this.load()
    const extra: Array<InstalledToolView> = regs.map(r => ({
      name: r.name,
      kind: r.kind,
      description: r.description,
      presentation: r.presentation,
    }))
    return [...BUILTIN_TOOLS, ...extra]
  }

  // Watch the registry directory for *.json add/change/unlink. Fires
  // `onChange` with the latest projected list whenever the on-disk set
  // diverges from the last snapshot. Debounced — fs.watch can fire bursts
  // (e.g. atomic write = unlink+rename) and we only want one update per
  // settled change. Returns a stop() for clean shutdown.
  watch(onChange: (view: Array<InstalledToolView>) => void): () => void {
    const DEBOUNCE_MS = 300
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null
    let closed = false
    let lastJson = ''

    const settle = (): void => {
      timer = null
      if (closed) return
      this.listView()
        .then(view => {
          if (closed) return
          const json = JSON.stringify(view)
          if (json === lastJson) return
          lastJson = json
          onChange(view)
        })
        .catch(() => {})
    }

    const schedule = (): void => {
      if (closed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(settle, DEBOUNCE_MS)
    }

    // mkdir-then-watch so a fresh install with no registry yet still works.
    mkdir(this.dir, { recursive: true })
      .then(() => {
        if (closed) return
        try {
          watcher = fsWatch(this.dir, () => schedule())
          watcher.on('error', () => {})
        } catch (err) {
          console.error('[mcp-registry] failed to watch', this.dir, err)
        }
        // Prime the snapshot so the FIRST real change actually fires the diff
        // (without this, `lastJson === ''` and the first listView() would emit
        // unnecessarily — harmless but noisy).
        this.listView().then(view => { lastJson = JSON.stringify(view) }).catch(() => {})
      })
      .catch(() => {})

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }
}
