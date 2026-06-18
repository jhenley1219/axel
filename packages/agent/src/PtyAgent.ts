// Long-lived interactive `claude` PTY per (axelSessionId, target, term).
// Implements AgentRuntime so the orchestrator stays untouched: it calls
// run(prompt, runtimeSessionId, ...) and gets back a stable spawnId that
// routes subsequent turns to the same PTY. The PTY itself is rendered by
// xterm.js on the web side — looks identical to running `claude` in any
// vanilla OS terminal, with full TUI / box drawing / slash commands.
//
// Heuristics & limits (v1):
//   • Ready detection: poll-based with spinner-glyph hash masking, so a
//     continuously-animated spinner doesn't keep "silence" from ever firing.
//     Hard escape at PTY_READY_MAX_WAIT_MS so the orchestrator queue can
//     never wedge.
//   • Voice TTS is SILENT in PTY mode — see extractAssistantText below for
//     why. The xterm view shows everything live; spoken response is future
//     work that needs structured text from a sidechannel.
//   • No --resume across PTY restarts: closing a PTY loses its conversation
//     (claude session id isn't surfaced over the TUI in a parseable form).
import { spawn as ptySpawn } from 'node-pty'
import type { IPty } from 'node-pty'
import { randomUUID } from 'crypto'
import { chmodSync, existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'

// node-pty 1.1.x ships its `spawn-helper` companion binary inside the
// per-platform prebuild folder, but pnpm's strict-script-isolation can skip
// the post-install that chmods it +x — every subsequent pty.spawn() fails
// with "posix_spawnp failed." We fix it here, once, at module load time so
// fresh clones / Docker images / teammate installs all just work.
;(() => {
  if (process.platform === 'win32') return
  try {
    const req = createRequire(import.meta.url)
    // The published entry point is lib/index.js — its directory is the
    // node-pty install root, with prebuilds/<platform>-<arch>/spawn-helper.
    const ptyEntry = req.resolve('node-pty')
    const root = dirname(dirname(ptyEntry))
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (!existsSync(helper)) return
    const mode = statSync(helper).mode
    // Already executable for owner?
    if ((mode & 0o100) !== 0) return
    chmodSync(helper, mode | 0o755)
  } catch { /* best-effort — if it fails the original spawn error still surfaces */ }
})()
import { spawnEnv } from '@axel/core'
import type { AuditLogger, EffortLevel, PermissionMode } from '@axel/core'
import { McpRegistry } from './McpRegistry.js'
import type { McpServerEntry } from './McpRegistry.js'
import type { PermissionBroker } from './PermissionBroker.js'
import type { TerminalBroker, TerminalOpenHandler } from './TerminalBroker.js'
import type { FileOpenBroker, FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupBroker, CleanupHandler } from './CleanupBroker.js'
import type { AppBroker } from './AppBroker.js'
import type { AskBroker } from './AskBroker.js'
import type { ReportBroker } from './ReportBroker.js'
import type { TerminalReadHandler } from './TerminalReadBroker.js'
import type { RequestQueue, QueueSpawnRole } from './RequestQueue.js'
import type { AgentRuntime } from './AgentRuntime.js'
import type { AgentEvent, AgentSpawnOpts, RunSettings } from './ClaudeCodeAgent.js'

// Was 1200ms — felt sluggish on every turn (two ready-detect cycles per
// child turn = ~2.4s of pure wait). 500ms cuts ~1.4s/turn while still
// covering the spinner-glyph masking case (claude refreshes the spinner at
// ~10 Hz; the masked hash should be stable well inside this window when
// claude is actually idle). Override via PTY_READY_SILENCE_MS if a
// particular environment's TUI redraw cadence pushes through.
const READY_SILENCE_MS = Number(process.env.PTY_READY_SILENCE_MS ?? 500)
// Hard ceiling on how long PtyAgent.run() will block waiting for the next
// ready prompt. Without this, a misread of claude's TUI state (spinner that
// never settles, prompt regex that no longer matches a TUI redesign) would
// hang the orchestrator's per-terminal queue indefinitely. Resolving at the
// ceiling lets follow-up turns dispatch even when ready-detection fails —
// the user sees the live response in xterm regardless.
const READY_MAX_WAIT_MS = Number(process.env.PTY_READY_MAX_WAIT_MS ?? 45_000)
const MAX_BACKLOG_BYTES = 64 * 1024
const MAX_STRIPPED_TAIL = 4 * 1024
const DEBUG_PTY = process.env.PTY_DEBUG === '1'

// Common spinner glyphs claude's TUI cycles through while thinking. When the
// most recent stripped tail contains any of these, we treat "silence" as
// continuous-spinner output and look for a longer settle window before
// declaring ready. Without this, a spinner ticking at ~10 Hz keeps
// scheduleReadyCheck() resetting the timer forever.
const SPINNER_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷▖▘▝▗◐◓◑◒|\\\-]/

// Strip the most common ANSI control sequences. Not exhaustive — covers CSI
// (ESC[…letter), OSC (ESC]…BEL), and two-byte designators (ESC( / ESC)). Good
// enough for the prompt-detection regex and the voice extractor.
function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\][^]*/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[()][\x20-\x7E]/g, '')
    .replace(/\r/g, '')
}

// True when the recent stripped tail looks like claude sitting at its input
// prompt. Checks for box-bottom glyphs OR a bare `> ` line — covers both the
// composing and the freshly-reset states.
function isAtPrompt(tail: string): boolean {
  const last = tail.slice(-1024)
  if (/╰[─]+╯/.test(last)) return true
  if (/^[\s│]*>\s*$/m.test(last)) return true
  return false
}

// Best-effort cleanup of a PTY turn's accumulated stripped output for use as
// the child's transcript in the root agent's BACKGROUND TERMINALS section.
// PTY output is byte-oriented (TUI redraws, box drawing, spinner glyphs, the
// claude TUI's status indicators); the goal here isn't perfect prose but
// "readable enough that the root can summarize what the child actually said".
// Strategy is aggressive: drop lines that look like UI chrome (box borders,
// tool-use indicators ⏺ / ⎿ / ✻ / ●, dots-only spinners, the input-box
// re-render at the end), dedupe adjacent duplicates from TUI redraws, and
// keep only lines that have at least one run of letters — i.e. actual prose.
function cleanTuiTail(s: string): string {
  const out: Array<string> = []
  for (const raw of s.split('\n')) {
    // Strip box-drawing AND claude TUI status glyphs out of the line, then
    // trim. A line that was ONLY chrome collapses to empty and gets dropped.
    const line = raw
      .replace(/[│╭╮╰╯─└┘├┤┬┴┼┃┏┓┗┛┣┫┳┻╋]+/g, '')
      .replace(/[⏺⎿✻●○◯◉◐◑◒◓◔◕◖◗◴◵◶◷▶▷▸▹►◀◁◂◃◄⏵⏷⏶⏴⌛⏳]/g, '')
      .trim()
    if (!line) continue
    // Drop residual spinner / punctuation-only / "thinking" lines.
    if (/^[·•⋅.\s\-_=>+]+$/.test(line)) continue
    if (/^(thinking|analyzing|reading|searching|writing|running|loading|working|processing|generating)\.{0,3}$/i.test(line)) continue
    // Drop ctrl/keystroke hint lines (claude prints these under tool results).
    if (/^(ctrl|⌃|esc|enter|tab|shift)\b.*expand/i.test(line)) continue
    // Drop pure progress / count lines that aren't actually prose.
    if (/^read \d+ lines?\b/i.test(line)) continue
    if (/^\d+\s*(tokens?|lines?|chars?|bytes?)\b/i.test(line)) continue
    // Require at least one run of two or more letters — drops glyph-only
    // residue we didn't anticipate.
    if (!/[A-Za-z]{2,}/.test(line)) continue
    out.push(line)
  }
  // Collapse runs of adjacent duplicate lines (TUI redraws often repeat the
  // same status line as the spinner ticks).
  const deduped: Array<string> = []
  for (const line of out) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line)
  }
  return deduped.join('\n').trim()
}

// Voice TTS is intentionally silent in PTY mode (v1). The first version of
// this file tried to feed an ANSI-stripped "best-effort assistant text" to
// TTS, but a TUI uses cursor positioning and selective overwrites — not a
// linear text stream — so what came out was a jumbled mash of input-box
// echo, spinner glyphs, status lines, and the response. Voice was reading
// the user's own prompt back to them and overflowing TTS phoneme limits.
// Real fix needs either:
//   (a) a hybrid mode where claude also writes structured assistant text to
//       a sidechannel (stream-json / a custom axel MCP "speak" tool), OR
//   (b) parsing the xterm scrollback ring buffer client-side after a turn
//       settles and round-tripping clean text back to TTS.
// Both are non-trivial; the xterm view still shows everything live.

type PtySessionState = {
  spawnId: string
  pty: IPty
  axelSessionId: string
  cwd: string
  cleanupFns: Array<() => void>
  backlog: Array<Buffer>
  backlogBytes: number
  strippedTail: string
  subscribers: Set<(data: Buffer) => void>
  isClosed: boolean
  lastOutputAt: number
  pendingReady: Array<() => void>
  // Between a write() and the next ready prompt — we accumulate visible
  // output here and emit it for voice when the prompt re-appears.
  // True between a write() and the next ready prompt. Used by waitForReady's
  // eager-return fast path so back-to-back turns don't pay the poll latency.
  inFlight: boolean
  // Stripped output accumulated since the current turn's write. Cleared on
  // every write, scraped at turn-end into a synthetic token event so the root
  // agent's BACKGROUND TERMINALS section ALWAYS has terminal content — the
  // child's explicit mcp__axel_report__report call is then a nice-to-have
  // supplement, not the sole channel. Capped to bound memory on long turns.
  turnText: string
  // Spawn id this PTY uses for the axel_report MCP bridge, if any. Stored
  // here so run() can ask the broker "did the model report this turn?" and
  // skip the noisier TUI scrape when it did.
  reportSpawnId: string | undefined
}

const MAX_TURN_TEXT = 16 * 1024

type OpenSessionArgs = {
  axelSessionId: string
  cwd: string
  allowedDirs: Array<string>
  systemPrompt?: string
  onEvent: (event: AgentEvent) => void
  terminalHandler?: TerminalOpenHandler
  fileHandler?: FileOpenHandler
  cleanupHandler?: CleanupHandler
  queueRole?: QueueSpawnRole
  runSettings: RunSettings
  apiKey?: string
}

export class PtyAgent implements AgentRuntime {
  private sessions = new Map<string, PtySessionState>()
  // axelSessionId → spawnIds — used by resetSession to tear down all PTYs
  // for a logged-out / cleared session.
  private byAxelSession = new Map<string, Set<string>>()
  // Per-spawn ready-check timers so back-to-back data chunks don't fire
  // ready prematurely (last-write-wins debounce).
  private readyTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private projectsDir: string,
    private allowedDirs: string[],
    private logger: AuditLogger,
    private registry: McpRegistry,
    private claudeBin: string = 'claude',
    private getApiKey?: () => Promise<string | undefined>,
    private spawnOpts?: AgentSpawnOpts,
  ) {}

  async run(
    userMessage: string,
    runtimeSessionId: string | undefined,
    axelSessionId: string,
    onEvent: (event: AgentEvent) => void,
    onAuthUrl: (url: string) => void,
    systemPrompt?: string,
    projectsDirOverride?: string,
    allowedDirsOverride?: string[],
    terminalHandler?: TerminalOpenHandler,
    fileHandler?: FileOpenHandler,
    cleanupHandler?: CleanupHandler,
    queueRole?: QueueSpawnRole,
    _terminalReadHandler?: TerminalReadHandler,
  ): Promise<string | undefined> {
    const cwd = projectsDirOverride ?? this.projectsDir
    const allowedDirs = allowedDirsOverride ?? this.allowedDirs
    await this.logger.log({
      type: 'execute',
      sessionId: axelSessionId,
      tool: 'claude-pty',
      input: { preview: userMessage.slice(0, 120), spawnId: runtimeSessionId },
    })

    let session = runtimeSessionId ? this.sessions.get(runtimeSessionId) : undefined
    if (session && session.isClosed) session = undefined

    if (!session) {
      const runSettings = (await this.spawnOpts?.getRunSettings?.()) ?? {}
      const apiKey = (await this.getApiKey?.()) ?? process.env.ANTHROPIC_API_KEY
      try {
        session = await this.openSession({
          axelSessionId,
          cwd,
          allowedDirs,
          systemPrompt,
          onEvent,
          terminalHandler,
          fileHandler,
          cleanupHandler,
          queueRole,
          runSettings,
          apiKey,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'pty_spawn_failed'
        // Surface auth URLs the same way ClaudeCodeAgent does — node-pty
        // routes stderr into the data stream, so login URLs end up in the
        // subscriber path too; this catch only handles spawn failures.
        onAuthUrl(msg)
        throw err
      }
      onEvent({ type: 'pty_ready', spawnId: session.spawnId })
    }

    // Settle on a ready prompt before typing.
    await this.waitForReady(session)

    session.inFlight = true
    // Reset the per-turn output buffer BEFORE the write so onPtyData starts
    // accumulating this turn's output (and only this turn's) — used below to
    // synthesize the transcript token event.
    session.turnText = ''
    session.pty.write(userMessage)
    // 30 ms tick so the input box renders the text before we submit — long
    // pastes truncated on the very next \r without this.
    await new Promise(r => setTimeout(r, 30))
    session.pty.write('\r')

    await this.waitForReady(session)
    session.inFlight = false

    // Scrape the cleaned per-turn output as a fallback transcript, but ONLY
    // when the model didn't already give us a clean summary via the report
    // tool. If we always scraped, the noisier TUI tail would land after the
    // clean report in childTranscripts and the prompt's tail-truncation
    // window would prefer the noise — exactly the "garbled fragments" bug.
    const broker = this.spawnOpts?.reportBroker
    const reported = !!(session.reportSpawnId && broker?.wasReported(session.reportSpawnId))
    if (!reported) {
      const tail = cleanTuiTail(session.turnText)
      if (tail) {
        onEvent({ type: 'token', value: tail })
        onEvent({ type: 'message_end' })
      }
    }
    return session.spawnId
  }

  // Look up a live PTY for the WS handler.
  getSession(spawnId: string): PtySessionState | undefined {
    return this.sessions.get(spawnId)
  }

  // AgentRuntime.peek implementation — surfaces the per-spawn ANSI-stripped
  // tail and per-turn buffer for the orchestrator's read_terminal tool. PTY
  // children render through xterm bytes so this is the ONLY place clean text
  // for them lives. Returns null when the spawn isn't known or has exited.
  peek(spawnId: string): { strippedTail: string; turnText: string } | null {
    const s = this.sessions.get(spawnId)
    if (!s || s.isClosed) return null
    return { strippedTail: s.strippedTail, turnText: s.turnText }
  }

  // Tear down every PTY for an auth session — called from the orchestrator's
  // resetSession path so a "new session" click drops dangling claude processes.
  resetSession(axelSessionId: string): void {
    const ids = this.byAxelSession.get(axelSessionId)
    if (!ids) return
    for (const id of [...ids]) this.closeSession(id)
    this.byAxelSession.delete(axelSessionId)
  }

  // User-input flush hook for the WS route: any orchestrator-queued writes
  // for this PTY that haven't dispatched yet are cancelled the moment the
  // user submits a prompt directly into the terminal. v1 keeps the cancel
  // semantics in the WS handler (drops in-flight orchestrator promises) — we
  // only need to expose the session so it can react.
  flushQueuedFor(spawnId: string): void {
    const s = this.sessions.get(spawnId)
    if (!s) return
    // No queue lives on the PTY itself in v1 — the orchestrator's childQueues
    // serializes turns and the next awaiter will resolve once user Enter
    // returns us to a ready prompt. Exposed for future per-PTY queue.
    void s
  }

  private async openSession(args: OpenSessionArgs): Promise<PtySessionState> {
    const spawnId = randomUUID()
    const mode: PermissionMode = args.runSettings.permissionMode ?? 'default'

    // Mirror ClaudeCodeAgent's per-spawn MCP bridge wiring — each broker
    // entry gets its OWN sub-spawnId so the loopback HTTP routes can scope
    // capabilities tightly. PTY lifetime = broker registration lifetime.
    const extraMcp: Record<string, McpServerEntry> = {}
    const {
      broker, terminalBroker, fileBroker, cleanupBroker, appBroker,
      askBroker, reportBroker, queueBroker, permissionBaseUrl,
    } = this.spawnOpts ?? {}

    let permissionSpawnId: string | undefined
    if (mode !== 'bypassPermissions' && broker && permissionBaseUrl) {
      permissionSpawnId = randomUUID()
      extraMcp.axel_permissions = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/permission/${permissionSpawnId}`,
        timeout: 600_000,
      }
    }

    let termSpawnId: string | undefined
    if (args.terminalHandler && terminalBroker && permissionBaseUrl) {
      termSpawnId = randomUUID()
      extraMcp.axel_terminals = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/terminal/${termSpawnId}`,
        timeout: 60_000,
      }
    }

    let fileSpawnId: string | undefined
    if (args.fileHandler && fileBroker && permissionBaseUrl) {
      fileSpawnId = randomUUID()
      extraMcp.axel_files = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/files/${fileSpawnId}`,
        timeout: 60_000,
      }
    }

    if (appBroker && permissionBaseUrl) {
      extraMcp.axel_apps = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/apps`,
        timeout: 60_000,
      }
    }

    let cleanupSpawnId: string | undefined
    if (args.cleanupHandler && cleanupBroker && permissionBaseUrl) {
      cleanupSpawnId = randomUUID()
      extraMcp.axel_cleanup = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/cleanup/${cleanupSpawnId}`,
        timeout: 60_000,
      }
    }

    let askSpawnId: string | undefined
    if (askBroker && permissionBaseUrl && args.queueRole?.role !== 'child') {
      askSpawnId = randomUUID()
      extraMcp.axel_ask = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/ask/${askSpawnId}`,
        timeout: 600_000,
      }
    }

    let queueSpawnId: string | undefined
    if (queueBroker && args.queueRole && permissionBaseUrl) {
      queueSpawnId = randomUUID()
      extraMcp.axel_queue = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/queue/${queueSpawnId}`,
        timeout: 600_000,
      }
    }

    // axel_report — CHILD only. Sole channel for a PTY child to deliver a
    // clean end-of-turn summary back to the orchestrator's childTranscripts
    // buffer (xterm bytes alone aren't usable as transcript text). Without
    // this the root agent's BACKGROUND TERMINALS section reads "(no output
    // yet)" and it tells the user "the terminal didn't send back any output".
    let reportSpawnId: string | undefined
    if (reportBroker && permissionBaseUrl && args.queueRole?.role === 'child') {
      reportSpawnId = randomUUID()
      extraMcp.axel_report = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/report/${reportSpawnId}`,
        timeout: 60_000,
      }
    }

    const mcp = await this.registry.generateConfig(Object.keys(extraMcp).length > 0 ? extraMcp : undefined)

    const claudeArgs: Array<string> = []
    if (mode === 'bypassPermissions') {
      claudeArgs.push('--dangerously-skip-permissions')
    } else {
      claudeArgs.push('--permission-mode', mode)
      if (permissionSpawnId) claudeArgs.push('--permission-prompt-tool', 'mcp__axel_permissions__approve')
    }
    if (args.runSettings.model)  claudeArgs.push('--model', args.runSettings.model)
    if (args.runSettings.effort) claudeArgs.push('--effort', args.runSettings.effort)
    if (args.systemPrompt) claudeArgs.push('--system-prompt', args.systemPrompt)
    if (mcp.configPath)    claudeArgs.push('--mcp-config', mcp.configPath)
    const allDirs = [...new Set([args.cwd, ...args.allowedDirs, ...mcp.addDirs])]
    for (const dir of allDirs) if (dir !== args.cwd) claudeArgs.push('--add-dir', dir)

    // Register brokers BEFORE spawn so the very first MCP roundtrip resolves.
    if (permissionSpawnId && broker) broker.register(permissionSpawnId, args.onEvent)
    if (termSpawnId && terminalBroker && args.terminalHandler) terminalBroker.register(termSpawnId, args.terminalHandler)
    if (fileSpawnId && fileBroker && args.fileHandler) fileBroker.register(fileSpawnId, args.fileHandler)
    if (cleanupSpawnId && cleanupBroker && args.cleanupHandler) cleanupBroker.register(cleanupSpawnId, args.cleanupHandler)
    if (askSpawnId && askBroker) askBroker.register(askSpawnId, args.onEvent)
    if (reportSpawnId && reportBroker) reportBroker.register(reportSpawnId, args.onEvent)
    if (queueSpawnId && queueBroker && args.queueRole) queueBroker.register(queueSpawnId, args.queueRole)

    // spawnEnv passes the parent env through (PATH, HOME, shell-exported
    // tokens) so user-installed CLIs and ~/.claude/settings.json mcpServers
    // are picked up — this is the "feels like your own claude" surface.
    const env = spawnEnv({
      CLAUDE_PATH: process.env.CLAUDE_PATH,
      ANTHROPIC_API_KEY: args.apiKey,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    })

    const pty = ptySpawn(this.claudeBin, claudeArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: args.cwd,
      env: env as { [key: string]: string },
    })

    const session: PtySessionState = {
      spawnId,
      pty,
      axelSessionId: args.axelSessionId,
      cwd: args.cwd,
      cleanupFns: [
        () => mcp.cleanup(),
        () => { if (permissionSpawnId && broker) broker.unregister(permissionSpawnId) },
        () => { if (termSpawnId && terminalBroker) terminalBroker.unregister(termSpawnId) },
        () => { if (fileSpawnId && fileBroker) fileBroker.unregister(fileSpawnId) },
        () => { if (cleanupSpawnId && cleanupBroker) cleanupBroker.unregister(cleanupSpawnId) },
        () => { if (askSpawnId && askBroker) askBroker.unregister(askSpawnId) },
        () => { if (reportSpawnId && reportBroker) reportBroker.unregister(reportSpawnId) },
        () => { if (queueSpawnId && queueBroker) queueBroker.unregister(queueSpawnId) },
      ],
      backlog: [],
      backlogBytes: 0,
      strippedTail: '',
      turnText: '',
      reportSpawnId,
      subscribers: new Set(),
      isClosed: false,
      lastOutputAt: Date.now(),
      pendingReady: [],
      inFlight: false,
    }

    pty.onData(data => this.onPtyData(session, data))
    pty.onExit(() => this.onPtyExit(session))

    this.sessions.set(spawnId, session)
    const ids = this.byAxelSession.get(args.axelSessionId) ?? new Set<string>()
    ids.add(spawnId)
    this.byAxelSession.set(args.axelSessionId, ids)

    return session
  }

  private onPtyData(session: PtySessionState, data: string): void {
    const buf = Buffer.from(data, 'utf8')
    session.backlog.push(buf)
    session.backlogBytes += buf.length
    while (session.backlogBytes > MAX_BACKLOG_BYTES) {
      const drop = session.backlog.shift()
      if (!drop) break
      session.backlogBytes -= drop.length
    }
    for (const sub of session.subscribers) sub(buf)

    const stripped = stripAnsi(data)
    session.strippedTail = (session.strippedTail + stripped).slice(-MAX_STRIPPED_TAIL)
    // Per-turn buffer: only meaningful while a turn is in flight. Capped to
    // bound memory on very long turns.
    if (session.inFlight) {
      session.turnText = (session.turnText + stripped).slice(-MAX_TURN_TEXT)
    }
    session.lastOutputAt = Date.now()
    this.scheduleReadyCheck(session)
  }

  private onPtyExit(session: PtySessionState): void {
    session.isClosed = true
    for (const fn of session.cleanupFns) try { fn() } catch { /* ignore */ }
    session.cleanupFns = []
    const t = this.readyTimers.get(session.spawnId)
    if (t) { clearTimeout(t); this.readyTimers.delete(session.spawnId) }
    // Anyone waiting on ready will hang forever otherwise — resolve them so
    // the caller's promise settles (caller can detect exit via isClosed).
    const waiters = session.pendingReady
    session.pendingReady = []
    for (const w of waiters) w()
    const ids = this.byAxelSession.get(session.axelSessionId)
    if (ids) ids.delete(session.spawnId)
  }

  // Poll-based ready detection. The naive "reset a timeout on every data
  // chunk" approach loses to claude's TUI spinner — the spinner re-renders
  // ~10 Hz, so the timeout never sees the configured silence window. Here we
  // instead run a steady poll while waiters exist, hashing the stripped tail
  // with spinner glyphs masked out; when the hash is stable across two
  // consecutive ticks AND the tail looks like a prompt box, we're idle.
  private scheduleReadyCheck(session: PtySessionState): void {
    if (this.readyTimers.has(session.spawnId)) return
    let lastHash = ''
    let stableTicks = 0
    const POLL_MS = Math.max(200, Math.floor(READY_SILENCE_MS / 2))
    const tick = (): void => {
      if (session.isClosed || session.pendingReady.length === 0) {
        const t = this.readyTimers.get(session.spawnId)
        if (t) { clearInterval(t); this.readyTimers.delete(session.spawnId) }
        return
      }
      const hash = session.strippedTail.replace(SPINNER_GLYPHS, '·').slice(-1024)
      if (hash === lastHash) stableTicks++
      else { stableTicks = 0; lastHash = hash }
      if (stableTicks >= 2 && isAtPrompt(session.strippedTail)) {
        if (DEBUG_PTY) {
          // eslint-disable-next-line no-console
          console.log('[pty] ready detected', {
            spawnId: session.spawnId.slice(0, 8),
            tailEnd: session.strippedTail.slice(-80).replace(/\n/g, '⏎'),
          })
        }
        const waiters = session.pendingReady
        session.pendingReady = []
        const t = this.readyTimers.get(session.spawnId)
        if (t) { clearInterval(t); this.readyTimers.delete(session.spawnId) }
        for (const w of waiters) w()
      }
    }
    const interval = setInterval(tick, POLL_MS)
    interval.unref?.()
    this.readyTimers.set(session.spawnId, interval)
  }

  private waitForReady(session: PtySessionState): Promise<void> {
    if (session.isClosed) return Promise.resolve()
    if (
      !session.inFlight &&
      Date.now() - session.lastOutputAt > READY_SILENCE_MS &&
      isAtPrompt(session.strippedTail)
    ) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      let settled = false
      const wrapped = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      session.pendingReady.push(wrapped)
      this.scheduleReadyCheck(session)
      // Escape hatch: never block the orchestrator queue forever, even if
      // ready-detection misses. Tunable via PTY_READY_MAX_WAIT_MS. On expiry
      // we just resolve — the live xterm view continues regardless.
      const cap = setTimeout(() => {
        if (settled) return
        if (DEBUG_PTY) {
          // eslint-disable-next-line no-console
          console.warn('[pty] ready wait expired, releasing queue', {
            spawnId: session.spawnId.slice(0, 8),
            lastOutputAgo: Date.now() - session.lastOutputAt,
            tail: session.strippedTail.slice(-160).replace(/\n/g, '⏎'),
          })
        }
        wrapped()
      }, READY_MAX_WAIT_MS)
      cap.unref?.()
    })
  }

  closeSession(spawnId: string): void {
    const session = this.sessions.get(spawnId)
    if (!session) return
    try { session.pty.kill() } catch { /* already dead */ }
    this.onPtyExit(session)
    this.sessions.delete(spawnId)
  }

  // Same probe as ClaudeCodeAgent — reads the user's claude config to decide
  // whether the UI needs to show a sign-in flow. No subprocess.
  async probe(): Promise<string | null> {
    const configPath = join(process.env.HOME ?? '/home/axel', '.claude.json')
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      const hasAccount = !!(cfg['oauthAccount'] as Record<string, unknown> | undefined)?.['accountUuid']
      if (hasAccount) return null
    } catch { /* file missing */ }
    return null
  }
}
