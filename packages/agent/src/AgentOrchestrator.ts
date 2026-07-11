import path from 'path'
import { randomUUID } from 'crypto'
import { AuditLogger, isPathUnder } from '@axel/core'
import { MAX_USER_MESSAGE_BYTES } from './ClaudeCodeAgent.js'
import type { AgentEvent } from './ClaudeCodeAgent.js'
import type { AgentRuntime } from './AgentRuntime.js'
import type { PermissionBroker } from './PermissionBroker.js'
import type { TerminalOpenHandler } from './TerminalBroker.js'
import type { TerminalReadHandler, ReadTerminalResult } from './TerminalReadBroker.js'
import type { FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupHandler } from './CleanupBroker.js'
import { McpRegistry } from './McpRegistry.js'
import { PromptBuilder } from './PromptBuilder.js'
import { readClaudeTranscript } from './ClaudeTranscript.js'
import { stat } from 'node:fs/promises'

export type OrchestratorOpts = {
  projectsDir: string      // cwd for runtime invocations — common parent of all projects
  allowedDirs: string[]    // dirs the runtime may read/write
  auditLogPath: string
  mcpRegistryDir?: string  // path to ~/.axel/mcp-registry/
  // Resolved per-call so a settings change (agentRuntime / runtimeProvider)
  // takes effect on the next turn — no server restart needed. The factory
  // (services.ts) constructs the selected runtime and wires its brokers
  // (terminal / file / cleanup / app / ask) — the orchestrator stays agent-agnostic.
  getAgent: () => AgentRuntime
  // When provided, the orchestrator subscribes to in-process permission requests
  // and bridges them onto the wire as `permission_request` events for the
  // session that triggered the request. The web client answers via the existing
  // `permission_response` control channel routed back through broker.resolve().
  permissionBroker?: PermissionBroker
  // Resolved per-call. True when the active runtime is a small local model
  // (q4-local / q2-local tier) that needs the compact PromptBuilder prompt
  // instead of the full ~17k-char Claude prompt. Defaults to false.
  isCompactModel?: () => boolean
}

// Cap on a single read_terminal result. The full conversation always exists on
// disk; when it exceeds this we return the most recent slice with a marker so
// the root's context isn't blown by one enormous terminal. Generous by default.
const TERMINAL_READ_MAX_CHARS = Number(process.env.AXEL_TERMINAL_READ_MAX_CHARS ?? 80_000)

type TaggedEvent = AgentEvent & { target?: string; term?: string }
type FanOutEvent =
  | TaggedEvent
  | { type: 'fan_out'; targets: Array<{ id: string; name: string; dir: string }> }
  | { type: 'target_done'; target: string; term?: string }
  | { type: 'error'; message: string; target?: string; term?: string }

// NOTE: directory resolution is no longer done here. The root agent (Claude)
// receives the raw user message plus the full project list (see PromptBuilder)
// and decides which repo to open, calling open_terminal itself. An earlier
// keyword/fuzzy matcher that guessed the target before the model saw the request
// lived here and was removed — it routinely guessed wrong (parent vs nested
// child, the assistant's own name, build-output dirs).

export class AgentOrchestrator {
  private logger: AuditLogger
  private getAgent: () => AgentRuntime
  private promptBuilder: PromptBuilder
  private sessions = new Map<string, string>()  // axelSessionId → runtimeSessionId
  // Per-terminal runtime session ids so a multi-turn conversation can resume the
  // same child agent across invocations. A dir can host several independent
  // terminals — each is its own runtime conversation.
  private targetSessions = new Map<string, string>()  // `${axelSessionId}:${targetId}:${term}` → runtimeSessionId
  // Per-terminal run chains. Detached children mean two root turns can hand work
  // to the SAME terminal before the first finishes — same-terminal runs must
  // serialize (they resume one runtime session) while different terminals and
  // dirs stay concurrent.
  private childQueues = new Map<string, Promise<void>>()
  // axelSessionId → live wire callback for that session. Populated for the
  // duration of each in-flight run so in-process permission requests can be
  // bridged onto the right WebSocket.
  private sessionSinks = new Map<string, (event: FanOutEvent) => void>()
  // Per-dir in-flight count, aggregated across that dir's terminals. A dir is
  // idle (and cleanup-eligible) only when its count is zero — i.e. no terminal
  // of that dir is currently inside an agent.run(). Keyed by
  // `${axelSessionId}:${targetName}`.
  private inFlightByDir = new Map<string, number>()
  // Server-side child-agent transcript buffers. The root agent needs to know
  // what a child said so it can summarize / relay naturally when the user asks
  // — without this, the root has no idea a child finished and the client used
  // to depend on regex phrase matching ("read the transcript") to surface the
  // data. Keyed by `${axelSessionId}:${targetName}:${term}`. `text` is the
  // concatenated assistant-only output; `lastUpdatedAt` is for ordering /
  // pruning. `doneAt` is set on the child's last `message_end` of a run and
  // cleared when a new run starts on the same key (re-run supersedes).
  private childTranscripts = new Map<string, { text: string; lastUpdatedAt: number; doneAt: number | null }>()
  // Tracks which finished children the root agent has already "consumed" in a
  // prior turn's system prompt. Keyed identically. Lets the prompt builder
  // distinguish "new since you last looked" from "stale, you've already seen
  // this" so the root agent isn't endlessly re-told about the same finish.
  private acknowledgedDoneAt = new Map<string, number>()
  // Last terminal id opened per (session, target) — including idle terminals
  // that never ran a task. Lets a repeat "open X" REUSE the existing tab/term
  // instead of minting a new id every time (which stacked duplicate terminals).
  // Keyed `${axelSessionId}:${targetName}`.
  private openedTerminals = new Map<string, string>()
  // Per-terminal Claude transcript locator: the cwd + session-id chain needed to
  // read that terminal's COMPLETE persisted conversation from disk. Populated
  // from each `pty_ready`, keyed `${axelSessionId}:${targetName}:${term}`. Unlike
  // childTranscripts (per-run summary buffer) this is NOT reset per run and NOT
  // cleared on PTY exit — the transcript file persists, so the root can always
  // read the full history, mid-run or long after a terminal finished or died.
  private terminalTranscripts = new Map<string, { cwd: string; sessionIds: Array<string>; lastAt: number }>()

  constructor(private opts: OrchestratorOpts) {
    if (opts.allowedDirs.length === 0) {
      throw new Error('[AgentOrchestrator] ALLOWED_DIRS is empty — set it before starting the agent')
    }
    this.logger = new AuditLogger(opts.auditLogPath)
    const registry = new McpRegistry(opts.mcpRegistryDir)
    this.getAgent = opts.getAgent
    this.promptBuilder = new PromptBuilder(registry)
    opts.permissionBroker?.onRequest(req => {
      const key = req.axelSessionId ?? req.sessionId
      const sink = this.sessionSinks.get(key)
      if (!sink) return
      sink({ type: 'permission_request', id: req.id, toolName: req.toolName, input: req.input })
    })
  }

  async probeAuth(): Promise<string | null> {
    console.log('[probeAuth] starting')
    const result = await this.getAgent().probe()
    console.log('[probeAuth] done:', result ?? 'null')
    return result
  }

  // Forget all conversation state for one axel (auth) session so the next
  // message starts a fresh runtime conversation instead of resuming the prior
  // one. Backs the UI's "new session" control. The runtime's own history on
  // disk is left untouched — we only drop the in-memory resume ids (and any
  // per-terminal queues / in-flight counters) for this session.
  resetSession(sessionId: string): void {
    // Tear down backend-owned child processes (PTY `claude` TUIs) BEFORE we
    // forget the session — otherwise we lose the mapping the runtime needs
    // to find them and they leak until server restart.
    this.getAgent().resetSession?.(sessionId)
    this.sessions.delete(sessionId)
    this.sessionSinks.delete(sessionId)
    const prefix = `${sessionId}:`
    for (const key of [...this.targetSessions.keys()])    if (key.startsWith(prefix)) this.targetSessions.delete(key)
    for (const key of [...this.childQueues.keys()])       if (key.startsWith(prefix)) this.childQueues.delete(key)
    for (const key of [...this.inFlightByDir.keys()])     if (key.startsWith(prefix)) this.inFlightByDir.delete(key)
    for (const key of [...this.childTranscripts.keys()])  if (key.startsWith(prefix)) this.childTranscripts.delete(key)
    for (const key of [...this.acknowledgedDoneAt.keys()]) if (key.startsWith(prefix)) this.acknowledgedDoneAt.delete(key)
    for (const key of [...this.openedTerminals.keys()])   if (key.startsWith(prefix)) this.openedTerminals.delete(key)
    for (const key of [...this.terminalTranscripts.keys()]) if (key.startsWith(prefix)) this.terminalTranscripts.delete(key)
  }

  // Record where a terminal's persisted Claude transcript lives, from its
  // pty_ready. Appends to the session-id chain (a --resume that forks writes a
  // new file) so reads span the whole conversation across PTY restarts.
  private recordTerminalTranscript(childKey: string, claudeSessionId: string, cwd: string): void {
    const entry = this.terminalTranscripts.get(childKey)
    if (!entry) {
      this.terminalTranscripts.set(childKey, { cwd, sessionIds: [claudeSessionId], lastAt: Date.now() })
      return
    }
    entry.cwd = cwd
    entry.lastAt = Date.now()
    if (!entry.sessionIds.includes(claudeSessionId)) entry.sessionIds.push(claudeSessionId)
  }

  // Snapshot of child terminals worth telling the root agent about on its
  // next turn: anything currently running, plus anything that finished since
  // the root last looked (acknowledgedDoneAt[key] !== doneAt). Marks finished
  // entries as acknowledged so subsequent turns only mention them if a fresh
  // run lands. The text payload is truncated to last MAX_TAIL chars per child
  // — full retrieval is a future tool; this is the always-on summary.
  private getChildStatusForRoot(sessionId: string): Array<{
    target: string; term: string; status: 'running' | 'finished'; tail: string; fresh: boolean
  }> {
    const prefix = `${sessionId}:`
    // 2000 chars ≈ a couple paragraphs — enough for a clean report() summary
    // PLUS the cleanTuiTail scrape if both fired, so the truncation window
    // doesn't drop one in favor of the other. Was 800; "garbled fragments"
    // bug stemmed from the scrape pushing the clean report past this line.
    const MAX_TAIL = 2000
    const out: Array<{ target: string; term: string; status: 'running' | 'finished'; tail: string; fresh: boolean }> = []
    for (const [key, buf] of this.childTranscripts) {
      if (!key.startsWith(prefix)) continue
      const tail = key.slice(prefix.length)
      const colon = tail.lastIndexOf(':')
      if (colon === -1) continue
      const target = tail.slice(0, colon)
      const term   = tail.slice(colon + 1)
      const dirKey = `${sessionId}:${target}`
      const running = (this.inFlightByDir.get(dirKey) ?? 0) > 0
      // A done run is "fresh" if its doneAt is newer than what the root last
      // acknowledged. Running runs are always included (mid-stream state may
      // be useful), and we DO NOT mark them acknowledged — that flip happens
      // when they finish.
      const fresh = buf.doneAt !== null && buf.doneAt !== (this.acknowledgedDoneAt.get(key) ?? 0)
      if (!running && !fresh) continue
      const status: 'running' | 'finished' = running ? 'running' : 'finished'
      const text = buf.text.length > MAX_TAIL ? `…${buf.text.slice(-MAX_TAIL)}` : buf.text
      out.push({ target, term, status, tail: text.trim(), fresh })
      if (status === 'finished' && buf.doneAt !== null) this.acknowledgedDoneAt.set(key, buf.doneAt)
    }
    return out
  }

  // Whether any child of this session has FINISHED with surface-worthy output
  // the root hasn't acknowledged yet. Gates the auto-wake so the root is pinged
  // only on real completion (non-empty transcript / report), never on the
  // premature ready-cap target_done where the transcript is still empty —
  // which had the root querying mid-work and going silent when work truly
  // finished. Read-only: does NOT mark anything acknowledged (that stays with
  // getChildStatusForRoot, which runs when the woken root actually looks).
  hasFreshChildOutput(sessionId: string): boolean {
    const prefix = `${sessionId}:`
    for (const [key, buf] of this.childTranscripts) {
      if (!key.startsWith(prefix)) continue
      if (!buf.text.trim()) continue
      if (buf.doneAt === null) continue
      if (buf.doneAt !== (this.acknowledgedDoneAt.get(key) ?? 0)) return true
    }
    return false
  }

  async handleMessage(
    userMessage: string,
    sessionId: string,
    onEvent: (event: FanOutEvent) => void,
    onAuthUrl: (url: string) => void,
    // forceRoot is retained for wire-compatibility (the server's auto-wake passes
    // it) but is now a no-op: every message already runs the root agent, since
    // directory routing was moved into the model itself.
    opts?: { projectsDir?: string; uiLocation?: string; forceRoot?: boolean },
  ): Promise<void> {
    if (Buffer.byteLength(userMessage, 'utf-8') > MAX_USER_MESSAGE_BYTES) {
      const kb = Math.round(MAX_USER_MESSAGE_BYTES / 1024)
      throw new Error(`Message too long (max ${kb} KB)`)
    }

    const effectiveAllowedDirs = opts?.projectsDir ? [opts.projectsDir] : this.opts.allowedDirs
    const rootForTargets       = opts?.projectsDir ?? this.opts.projectsDir

    // No deterministic pre-routing. Every user message goes to the root agent
    // (Claude), which decides what the user wants: it has the full project list
    // (including nested repos) in its system prompt plus filesystem search tools,
    // so it finds the repo the user named — however fuzzily — and opens it itself
    // by calling open_terminal with the resolved path. open_terminal materializes
    // the ring in the UI, so the open is reflected on screen. Letting the model
    // do the finding-and-opening replaced an earlier keyword matcher that guessed
    // the directory before Claude ever saw the request and routinely guessed
    // wrong (parent instead of nested child, the assistant's own name, etc.).
    const claudeSessionId    = this.sessions.get(sessionId)
    // Background-terminal status feeds into the system prompt so the root
    // agent always knows what its sub-agents have said — no client-side
    // phrase matcher needed to surface "read the transcript" intents.
    const childStatus        = this.getChildStatusForRoot(sessionId)
    const systemPrompt       = await this.promptBuilder.build(effectiveAllowedDirs, {
      root: true,
      compact: this.opts.isCompactModel?.() ?? false,
      uiLocation: opts?.uiLocation,
      childStatus,
    })
    this.sessionSinks.set(sessionId, onEvent)
    try {
      const newClaudeSessionId = await this.getAgent().run(
        userMessage,
        claudeSessionId,
        sessionId,
        onEvent,
        onAuthUrl,
        systemPrompt,
        opts?.projectsDir,
        effectiveAllowedDirs,
        this.makeTerminalHandler({ sessionId, root: rootForTargets, onEvent, onAuthUrl }),
        this.makeFileOpenHandler({ allowedDirs: effectiveAllowedDirs, baseDir: rootForTargets, onEvent }),
        // Cleanup tool is only wired for ROOT spawns — child sub-agents inside
        // a dir have no business closing other dirs.
        this.makeCleanupHandler({ sessionId, onEvent }),
        // Root role: queue tools surface as list/claim/resolve so the root
        // agent can drain sub-agent requests and route answers back.
        { role: 'root' },
        // Root-only: read_terminal lets the agent pull a child's recent text
        // on demand, bypassing the BACKGROUND TERMINALS prefill when it's
        // empty / garbled (the common failure mode when a PTY child forgot
        // to call report and the cleaner over-stripped).
        this.makeTerminalReadHandler({ sessionId }),
      )
      if (newClaudeSessionId) this.sessions.set(sessionId, newClaudeSessionId)
    } finally {
      this.sessionSinks.delete(sessionId)
    }
  }

  // Run a single sub-agent in targetDir, tagging all events with targetName
  // and term. Used by fan-out, manual dir-input sessions, and model-opened
  // terminals. Queued per terminal.
  async handleDirMessage(
    text: string,
    sessionId: string,
    targetName: string,
    targetDir: string,
    onEvent: (event: FanOutEvent) => void,
    onAuthUrl: (url: string) => void,
    term = 'main',
  ): Promise<void> {
    const childKey = `${sessionId}:${targetName}:${term}`
    const prev = this.childQueues.get(childKey) ?? Promise.resolve()
    // catch(): one failed run must not poison the chain for every later task.
    const next = prev.catch(() => {}).then(() =>
      this.runDirMessage(text, sessionId, targetName, targetDir, onEvent, onAuthUrl, term),
    )
    this.childQueues.set(childKey, next)
    return next
  }

  private async runDirMessage(
    text: string,
    sessionId: string,
    targetName: string,
    targetDir: string,
    onEvent: (event: FanOutEvent) => void,
    onAuthUrl: (url: string) => void,
    term: string,
  ): Promise<void> {
    const childKey = `${sessionId}:${targetName}:${term}`
    const dirKey = `${sessionId}:${targetName}`
    const prevClaudeId = this.targetSessions.get(childKey)
    const childAllowed = [targetDir]
    const childPrompt = await this.promptBuilder.build(childAllowed, {
      compact: this.opts.isCompactModel?.() ?? false,
    })
    this.inFlightByDir.set(dirKey, (this.inFlightByDir.get(dirKey) ?? 0) + 1)
    // Fresh run: reset the buffer so the root agent's "BACKGROUND TERMINALS"
    // section reflects THIS run, not the previous one's stale output. Also
    // clear the acknowledged marker so the new finish reads as fresh.
    this.childTranscripts.set(childKey, { text: '', lastUpdatedAt: Date.now(), doneAt: null })
    this.acknowledgedDoneAt.delete(childKey)
    // Wrap the event stream so we (a) accumulate child assistant text into
    // the server-side buffer for later root agent consumption, and (b) tag
    // every event with the child's target/term as before.
    const wrappedOnEvent = (ev: AgentEvent): void => {
      if (ev.type === 'pty_ready') {
        // Make this terminal addressable + reusable the MOMENT its PTY exists —
        // not only when its turn ends. Without this, a terminal still mid-work
        // (or one whose turn-end detection missed) can't be found for a
        // follow-up, so the agent wrongly spawns a new tab. targetSessions maps
        // the live PTY spawnId (used to resume the same conversation);
        // openedTerminals marks it as the target's current terminal so a bare
        // follow-up reuses it. Covers the user's own `main` terminal too.
        this.targetSessions.set(childKey, ev.spawnId)
        this.openedTerminals.set(dirKey, term)
        if (ev.claudeSessionId && ev.cwd) this.recordTerminalTranscript(childKey, ev.claudeSessionId, ev.cwd)
      }
      if (ev.type === 'token' && typeof ev.value === 'string') {
        const buf = this.childTranscripts.get(childKey)
        if (buf) {
          buf.text += ev.value
          buf.lastUpdatedAt = Date.now()
        }
      } else if (ev.type === 'message_end') {
        // A child run can span several message_end events (claude emits one
        // per assistant message between tool calls). The "done" stamp is set
        // when the run as a whole exits, below in the finally block — here
        // we just add a newline so concatenated text reads naturally.
        const buf = this.childTranscripts.get(childKey)
        if (buf && buf.text && !buf.text.endsWith('\n')) buf.text += '\n'
      }
      onEvent({ ...ev, target: targetName, term } as TaggedEvent)
    }
    try {
      const newClaudeId = await this.getAgent().run(
        text,
        prevClaudeId,
        sessionId,
        wrappedOnEvent,
        onAuthUrl,
        childPrompt,
        targetDir,
        childAllowed,
        // A child may open extra terminals in its OWN dir only (parallel work
        // within one project), so the open_terminal capability must exist here
        // too — restricted to its own dir.
        this.makeTerminalHandler({ sessionId, root: path.dirname(targetDir), restrictTo: { targetName, targetDir }, onEvent, onAuthUrl }),
        // Child agents may only open files inside their own project dir; the
        // root run can open any file under allowedDirs. Per-target tagging on
        // the wire event is handled by the wrapped onEvent at line above.
        this.makeFileOpenHandler({ allowedDirs: [targetDir], baseDir: targetDir, onEvent: ev => onEvent({ ...ev, target: targetName, term } as TaggedEvent) }),
        // Children don't get cleanup — they can't close sibling dirs.
        undefined,
        // Child role: queue surfaces only `request`, which routes back to the
        // root agent (and through to the user) tagged with this target/term.
        { role: 'child', target: targetName, term },
      )
      if (newClaudeId) this.targetSessions.set(childKey, newClaudeId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'child_agent_error'
      onEvent({ type: 'error', message, target: targetName, term })
    } finally {
      const n = (this.inFlightByDir.get(dirKey) ?? 1) - 1
      if (n <= 0) this.inFlightByDir.delete(dirKey)
      else this.inFlightByDir.set(dirKey, n)
      // Stamp the finished moment so the next root turn sees it as fresh.
      // We mark `doneAt` even on the catch path — root should be told the
      // child errored, not pretend it's still running.
      const buf = this.childTranscripts.get(childKey)
      if (buf) buf.doneAt = Date.now()
    }
  }

  // Builds the per-spawn open_terminal handler. Root runs may open a terminal in
  // any real directory under `root`, including NESTED project paths like
  // "clients/acme-web-app" — the UI renders nested rings. Child runs are
  // restricted to their own dir.
  private makeTerminalHandler(ctx: {
    sessionId: string
    root: string
    restrictTo?: { targetName: string; targetDir: string }
    onEvent: (event: FanOutEvent) => void
    onAuthUrl: (url: string) => void
  }): TerminalOpenHandler {
    return async args => {
      let targetName: string
      let targetDir: string
      const dirArg = args.directory?.trim()

      if (ctx.restrictTo) {
        if (dirArg && dirArg !== '.' && dirArg !== ctx.restrictTo.targetName) {
          return { ok: false, error: 'This terminal can only open terminals in its own project directory — omit `directory`.' }
        }
        targetName = ctx.restrictTo.targetName
        targetDir  = ctx.restrictTo.targetDir
      } else {
        if (!dirArg) return { ok: false, error: '`directory` is required: the name of a project under the projects root.' }
        const rootAbs  = path.resolve(ctx.root)
        const resolved = path.resolve(rootAbs, dirArg)
        if (!isPathUnder(resolved, [rootAbs])) {
          return { ok: false, error: 'Directory is outside the projects root.' }
        }
        const rel = path.relative(rootAbs, resolved).split(path.sep).join('/')
        if (!rel) {
          return { ok: false, error: 'Cannot host a terminal on the projects root itself — name a project directory.' }
        }
        // Nested projects are allowed: repos are grouped in folders (e.g.
        // clients/acme-web-app), so `directory` may be a multi-segment
        // path. The model named it explicitly, so just require it to be a real
        // directory under the root — no second-guessing whether we'd have
        // surfaced it via fuzzy discovery.
        const isDir = await stat(resolved).then(s => s.isDirectory()).catch(() => false)
        if (!isDir) {
          return { ok: false, error: `No directory "${rel}" under the projects root.` }
        }
        targetName = rel
        targetDir  = resolved
      }

      // Term selection. REUSE IS THE DEFAULT: a prompt continues the target's
      // existing terminal (same conversation) unless the caller explicitly asks
      // for a fresh one. This is the whole point of the tool — you talk TO your
      // terminals, you don't stack a new tab per message.
      //   1. explicit `term` → that specific terminal (main, or a t-xxxx id).
      //   2. `new: true` → force a brand-new parallel terminal (user asked to
      //      work on something separate alongside the existing one).
      //   3. otherwise, if a terminal already exists for this target → REUSE it
      //      (feed the follow-up in), whether or not there's a prompt.
      //   4. no terminal exists yet → open the first one.
      const reqTerm = typeof args.term === 'string' ? args.term.trim() : ''
      const wantNew = args.new === true
      const openKey = `${ctx.sessionId}:${targetName}`
      const existingForTarget = this.openedTerminals.get(openKey)
      const prompt = args.prompt?.trim()
      const isKnownTerm = (t: string): boolean =>
        existingForTarget === t ||
        this.targetSessions.has(`${ctx.sessionId}:${targetName}:${t}`) ||
        this.terminalTranscripts.has(`${ctx.sessionId}:${targetName}:${t}`)
      let term: string
      let reused: boolean
      if (reqTerm) {
        term = reqTerm
        reused = isKnownTerm(reqTerm)
      } else if (existingForTarget && !wantNew) {
        term = existingForTarget
        reused = true
      } else {
        term = `t-${randomUUID().slice(0, 8)}`
        reused = false
      }
      this.openedTerminals.set(openKey, term)
      // terminal_open is idempotent on the client (dedup by key) AND re-triggers
      // the orb to refocus on this target — so emit it every time, including
      // reuse, where it's how a repeat "open X" pulls the orb back without
      // spawning a second tab.
      ctx.onEvent({ type: 'terminal_open', target: targetName, term })

      if (prompt) {
        // Detached, like delegation: the tool returns immediately while the
        // terminal streams term-tagged events until its target_done.
        ctx.onEvent({ type: 'target_start', target: targetName, term })
        void this.handleDirMessage(prompt, ctx.sessionId, targetName, targetDir, ctx.onEvent, ctx.onAuthUrl, term)
          .finally(() => ctx.onEvent({ type: 'target_done', target: targetName, term }))
          .catch(err => console.error('[orchestrator] terminal sub-agent error:', err))
      }

      return { ok: true, target: targetName, term, reused }
    }
  }

  // All terminal terms known for a (session, target), most-recently-active
  // first. Draws from the transcript locators (readable full history) and any
  // live runtime sessions (just-opened terminals with no transcript yet), so
  // enumeration reaches EVERY terminal — the agent-spawned t-xxxx ones and the
  // user's own "main" tab alike.
  private listTerms(sessionId: string, target: string): Array<string> {
    const prefix = `${sessionId}:${target}:`
    const seen = new Map<string, number>()
    for (const [key, entry] of this.terminalTranscripts) {
      if (key.startsWith(prefix)) seen.set(key.slice(prefix.length), entry.lastAt)
    }
    for (const key of this.targetSessions.keys()) {
      if (key.startsWith(prefix) && !seen.has(key.slice(prefix.length))) seen.set(key.slice(prefix.length), 0)
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }

  // Resolve one terminal's readable content, best source first. Returns null
  // when the terminal has nothing yet. Peeking the live PTY yields both its raw
  // tail AND its claude session id — the session id lets us read the FULL
  // transcript even for a terminal we have no recorded locator for: one the user
  // drove by hand (dir_input / typing straight into the xterm) or whose
  // pty_ready we never saw. Recording it keeps it readable after the PTY dies.
  private readTerminalContent(
    sessionId: string, target: string, term: string, raw: boolean,
  ): { text: string; source: 'full' | 'transcript' | 'raw' | 'mixed' } | null {
    const childKey = `${sessionId}:${target}:${term}`
    let rawText: string | null = null
    const spawnId = this.targetSessions.get(childKey)
    if (spawnId) {
      const peek = this.getAgent().peek?.(spawnId)
      if (peek) {
        rawText = peek.strippedTail.trim() || peek.turnText.trim() || null
        if (peek.claudeSessionId && peek.cwd) this.recordTerminalTranscript(childKey, peek.claudeSessionId, peek.cwd)
      }
    }
    // The complete persisted conversation — the authoritative source. Works
    // mid-run too: claude appends each user/assistant/tool message to the
    // transcript as it happens, so a "working" terminal is fully readable.
    const locator = this.terminalTranscripts.get(childKey)
    const full = locator
      ? readClaudeTranscript({ cwd: locator.cwd, sessionIds: locator.sessionIds, maxChars: TERMINAL_READ_MAX_CHARS }).trim()
      : ''
    const summary = (this.childTranscripts.get(childKey)?.text ?? '').trim()

    if (raw) {
      if (rawText) return { text: rawText, source: 'raw' }
      if (full) return { text: full, source: 'full' }
      if (summary) return { text: summary, source: 'transcript' }
      return null
    }
    if (full) return { text: full, source: 'full' }
    if (summary) {
      if (rawText && rawText.length > summary.length * 1.5) {
        return { text: `${summary}\n\n--- raw terminal tail (less filtered) ---\n${rawText}`, source: 'mixed' }
      }
      return { text: summary, source: 'transcript' }
    }
    if (rawText) return { text: rawText, source: 'raw' }
    return null
  }

  // Builds the per-spawn read_terminal handler. Resolves a (target, term?) into
  // that terminal's COMPLETE conversation, read from Claude Code's persisted
  // JSONL transcript (authoritative, clean, survives PTY death). Falls back to
  // the cleaned childTranscripts summary, then the live PTY's raw ANSI-stripped
  // tail (`raw: true` prefers that live tail). Omitting `term` reads whichever
  // of the target's terminals actually has content (most-recent first) and lists
  // the rest. Root spawns only — children mustn't peek at sibling terminals.
  private makeTerminalReadHandler(ctx: { sessionId: string }): TerminalReadHandler {
    return async args => {
      const target = (args.target ?? '').trim()
      if (!target) return { ok: false, error: '`target` is required: the dir name of the terminal to read.' }

      const reqTerm = (args.term ?? '').trim()
      const known = this.listTerms(ctx.sessionId, target)
      // When a specific term is asked for, honour it. Otherwise try the known
      // terminals most-recent first and return the first with real content —
      // so "read the terminal" surfaces the meaningful one even when a newer but
      // empty terminal was opened after it (the exact original failure).
      const candidates = reqTerm ? [reqTerm] : (known.length ? known : ['main'])
      const enumerating = !reqTerm && known.length > 1

      for (const term of candidates) {
        const content = this.readTerminalContent(ctx.sessionId, target, term, !!args.raw)
        if (!content) continue
        const header = enumerating
          ? `[${known.length} terminals open for ${target}: ${known.join(', ')} — showing ${term}. Pass \`term\` to read a specific one.]\n\n`
          : ''
        return { ok: true, target, term, text: header + content.text, source: content.source }
      }
      return { ok: false, error: `No text yet for ${target} [${candidates[0]}] — terminal may be idle or just opened.` }
    }
  }

  // Builds the per-spawn open_file handler. Resolves the agent's path argument
  // against the spawn's baseDir, then enforces that the result lives under one
  // of allowedDirs (the same allowlist that bounds claude's own file access).
  // Fire-and-forget: emit the wire event and return.
  private makeFileOpenHandler(ctx: {
    allowedDirs: Array<string>
    baseDir: string
    onEvent: (event: FanOutEvent) => void
  }): FileOpenHandler {
    return async args => {
      const raw = args.path?.trim()
      if (!raw) return { ok: false, error: '`path` is required.' }
      const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.baseDir, raw)
      if (!isPathUnder(resolved, ctx.allowedDirs)) {
        return { ok: false, error: 'File is outside the allowed directories.' }
      }
      ctx.onEvent({
        type: 'file_open_request',
        path: resolved,
        highlights: args.highlights,
        suggestion: args.suggestion,
        prompt: args.prompt,
      })
      return { ok: true, path: resolved }
    }
  }

  // Builds the per-spawn close_idle_dirs handler. Only wired for the ROOT
  // spawn — child sub-agents must not close other dirs. Sweeps the dirs
  // currently tracked for this session (targetSessions) and drops those with
  // zero in-flight runs. Emits dir_closed for each closed dir so the UI can
  // play the close animation.
  //
  // Note: only dirs the orchestrator KNOWS about are considered. A dir the
  // user opened in the UI without ever delegating work to it isn't tracked
  // here and won't be touched — the user can close it manually.
  private makeCleanupHandler(ctx: {
    sessionId: string
    onEvent: (event: FanOutEvent) => void
  }): CleanupHandler {
    return async args => {
      // go_home: not a cleanup — just return the orb to the projects root.
      if (args?.action === 'go_home') {
        ctx.onEvent({ type: 'ui_focus_root' })
        return { ok: true, closed: [] }
      }
      const prefix = `${ctx.sessionId}:`
      const byDir = new Map<string, Array<string>>()  // targetName → child-keys for this session
      for (const key of this.targetSessions.keys()) {
        if (!key.startsWith(prefix)) continue
        // key shape: `${sessionId}:${targetName}:${term}` — targetName has no ':'
        const tail = key.slice(prefix.length)
        const colon = tail.lastIndexOf(':')
        if (colon === -1) continue
        const targetName = tail.slice(0, colon)
        const list = byDir.get(targetName) ?? []
        list.push(key)
        byDir.set(targetName, list)
      }

      const closed: Array<string> = []
      for (const [targetName, childKeys] of byDir) {
        const dirKey = `${ctx.sessionId}:${targetName}`
        if ((this.inFlightByDir.get(dirKey) ?? 0) > 0) continue
        for (const k of childKeys) {
          this.targetSessions.delete(k)
          this.childQueues.delete(k)
        }
        ctx.onEvent({ type: 'dir_closed', target: targetName })
        closed.push(targetName)
      }
      return { ok: true, closed }
    }
  }

}
