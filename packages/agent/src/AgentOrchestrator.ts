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
import { listProjects } from './projects.js'

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
}

type TaggedEvent = AgentEvent & { target?: string; term?: string }
type FanOutEvent =
  | TaggedEvent
  | { type: 'fan_out'; targets: Array<{ id: string; name: string; dir: string }> }
  | { type: 'target_done'; target: string; term?: string }
  | { type: 'error'; message: string; target?: string; term?: string }

// Score one project against the message. Higher = more confident the user
// meant this directory. Tiers (ordered, first hit wins):
//   100 — full dir name appears verbatim, OR its squashed (separator-stripped)
//         form appears in the squashed message. Direct, unambiguous reference.
//    80 — every ≥4-char hyphen/underscore token from the dir name appears in
//         the message (requires the dir name to have ≥2 meaningful tokens).
//    60 — ≥75% of meaningful tokens match AND at least 2 tokens hit.
//     0 — anything weaker. Deliberately no suffix-fragment or single-token
//         "leaf" matches: those collapse onto every dir sharing a common word
//         (e.g. "blueprint" matched 11 dirs and spawned 11 terminals).
function scoreProject(message: string, proj: string): number {
  const m = message.toLowerCase()
  const p = proj.toLowerCase()
  if (m.includes(p)) return 100

  // Spoken un-hyphenated form ("paul the robot baby" → "paultherobotbaby").
  // ≥6 chars so tiny names can't match inside unrelated words.
  const mSquash = m.replace(/[^a-z0-9]+/g, '')
  const pSquash = p.replace(/[^a-z0-9]+/g, '')
  if (pSquash.length >= 6 && mSquash.includes(pSquash)) return 100

  const mWords = m.split(/[^a-z0-9]+/).filter(w => w.length >= 3)
  const tokens = p.split(/[-_]+/).filter(t => t.length >= 4)
  if (tokens.length < 2 || mWords.length === 0) return 0

  let hit = 0
  for (const token of tokens) {
    // Containment requires ≥5-char words: with ≥3 a stopword inside an
    // un-hyphenated name matched everything ("the" ⊂ "paultherobotbaby").
    if (mWords.some(w =>
      w === token ||
      (token.length >= 6 && (w.includes(token) || (w.length >= 5 && token.includes(w))))
    )) hit++
  }
  if (hit === tokens.length) return 80
  if (hit >= 2 && hit / tokens.length >= 0.75) return 60
  return 0
}

// Heuristic target detection. Given the user's free-text message and the list
// of available project directory names, decide which (if any) projects to
// delegate to. Returns:
//   []              → no confident match. The root agent handles the message
//                     and asks for clarification if it sees an implicit dir
//                     reference (per its [F] AMBIGUOUS rule).
//   [single]        → one clear best match. Caller delegates to it.
//   [a, b, …]       → only when MULTIPLE projects each hit the strongest tier
//                     (verbatim/squashed full-name), i.e. the user explicitly
//                     named more than one dir ("audit X and Y"). Caller fans
//                     out one sub-agent per project.
// Soft signal that the user is asking for work in MORE THAN ONE project even
// if our deterministic matcher only locked onto one. Speech-to-text mishearing
// of a second project name is the common failure mode — e.g. the user says
// "audit X as well as Y" but STT garbles Y into something detectTargets can't
// match; we'd then single-target dispatch on X only and the child would get a
// "fix two things" prompt it can only half-honor.
// Triggers: explicit multi-conjunctions, "both", or two+ mentions of repo-like
// nouns. False positives just incur an extra root-agent turn (the root sees
// the full message + dir list and decides how to dispatch).
export function looksLikeMultiTarget(message: string): boolean {
  const m = message.toLowerCase()
  if (/\b(as well as|along with|together with|in addition to)\b/.test(m)) return true
  if (/\bboth\b/.test(m)) return true
  if (/\b(two|three|four|several|multiple)\b.*\b(repo|repository|project|directory|terminal)s?\b/.test(m)) return true
  const repoMentions = (m.match(/\b(repo|repository|project|directory)\b/g) ?? []).length
  if (repoMentions >= 2) return true
  return false
}

// Weak-tier ties intentionally collapse to [] rather than fan out — a single
// generic word like "blueprint" used to match 11 dirs and spawn 11 terminals.
export function detectTargets(message: string, available: Array<string>): Array<string> {
  const scored = available
    .map(proj => ({ proj, score: scoreProject(message, proj) }))
    .filter(x => x.score > 0)
  if (scored.length === 0) return []

  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

  // Strong tier: verbatim or squashed full-name match. When two such matches
  // overlap as prefix/suffix, the user clearly said the longer one and the
  // shorter just shares letters — drop it. ("rta-blueprint-react-ui-azure"
  // wins over "rta-blueprint-react-ui" in the same spoken phrase.)
  const strong = scored.filter(s => s.score >= 100)
  const strongDeduped = strong.filter(({ proj }) => {
    const me = squash(proj)
    return !strong.some(({ proj: other }) =>
      other !== proj && squash(other).length > me.length && squash(other).includes(me),
    )
  })
  if (strongDeduped.length >= 1) return strongDeduped.map(x => x.proj)

  // No strong match: take the single best weak match. Tied weak matches stay
  // unrouted so the root agent can ask which dir the user meant.
  const weak = scored.filter(s => s.score < 100).sort((a, b) => b.score - a.score)
  const best = weak[0].score
  const top = weak.filter(x => x.score === best)
  return top.length === 1 ? [top[0].proj] : []
}

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

  async handleMessage(
    userMessage: string,
    sessionId: string,
    onEvent: (event: FanOutEvent) => void,
    onAuthUrl: (url: string) => void,
    // forceRoot: bypass detectTargets and run the root agent unconditionally.
    // Used by server-initiated synthetic turns (e.g. the queue auto-wake) whose
    // text may incidentally contain a project name and must NOT be re-routed
    // to that project as a child terminal.
    opts?: { projectsDir?: string; uiLocation?: string; forceRoot?: boolean },
  ): Promise<void> {
    if (Buffer.byteLength(userMessage, 'utf-8') > MAX_USER_MESSAGE_BYTES) {
      const kb = Math.round(MAX_USER_MESSAGE_BYTES / 1024)
      throw new Error(`Message too long (max ${kb} KB)`)
    }

    const effectiveAllowedDirs = opts?.projectsDir ? [opts.projectsDir] : this.opts.allowedDirs
    const rootForTargets       = opts?.projectsDir ?? this.opts.projectsDir

    // Detect which project directories the user is referring to. Skipped when
    // the caller has explicitly demanded the root path (forceRoot).
    const availableProjects = opts?.forceRoot ? [] : await listProjects(rootForTargets)
    const targets           = opts?.forceRoot ? [] : detectTargets(userMessage, availableProjects)

    if (targets.length >= 2) {
      // Multi-target: spawn independent sub-agents in parallel, one per project.
      console.log(`[orchestrator] parallel fan-out → ${targets.length} targets:`, targets.join(', '))
      this.runFanOut(userMessage, sessionId, targets, rootForTargets, onEvent, onAuthUrl)
      return
    }

    if (targets.length === 1 && !opts?.forceRoot && !looksLikeMultiTarget(userMessage)) {
      // Single identified target: route straight to a sub-agent in that directory.
      // The root orchestrator never edits files itself — it delegates.
      // Guard: if the message wording implies MORE THAN ONE target (e.g. "X as
      // well as Y") and we only matched one, fall through to the root agent
      // path so it can parse the full message and call open_terminal per dir.
      // Speech-to-text errors on the second dir name are the common cause.
      const [targetName] = targets
      const targetDir = path.join(rootForTargets, targetName)
      console.log(`[orchestrator] single-target sub-agent → ${targetName} (detached)`)
      // Untagged token → spoken by the main session's TTS and shown in the
      // main chat, so the user hears the hand-off instead of silence.
      onEvent({ type: 'token', value: `Opening a terminal in ${targetName} — it'll work in the background and I'll let you know when it's done.` })
      onEvent({ type: 'message_end' })
      // Emit terminal_open so the client materializes the tab immediately —
      // matches the explicit open_terminal and fan-out paths. Without this the
      // tab was invisible until the child finally emitted a token at end-of-
      // turn (PTY children don't emit tokens during the turn) and the user
      // saw a "tabless ring" for the entire run. term='main' matches what
      // handleDirMessage tags its events with so the key collapses.
      onEvent({ type: 'terminal_open', target: targetName, term: 'main' })
      onEvent({ type: 'target_start', target: targetName })
      // Deliberately NOT awaited: the root turn ends as soon as the hand-off is
      // announced, freeing the user to issue the next task. The child keeps
      // streaming target-tagged events until its target_done arrives.
      void this.handleDirMessage(userMessage, sessionId, targetName, targetDir, onEvent, onAuthUrl)
        .finally(() => onEvent({ type: 'target_done', target: targetName }))
        .catch(err => console.error('[orchestrator] sub-agent error:', err))
      return
    }

    // No specific project detected — run the main agent (general Q&A, planning, etc.).
    const claudeSessionId    = this.sessions.get(sessionId)
    // Background-terminal status feeds into the system prompt so the root
    // agent always knows what its sub-agents have said — no client-side
    // phrase matcher needed to surface "read the transcript" intents.
    const childStatus        = this.getChildStatusForRoot(sessionId)
    const systemPrompt       = await this.promptBuilder.build(effectiveAllowedDirs, {
      root: true,
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
    const childPrompt = await this.promptBuilder.build(childAllowed)
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
        // within one project) — detectTargets routes "open two terminals in X"
        // straight to X's child, so the capability must exist here too.
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

  // Builds the per-spawn open_terminal handler. Root runs may open a terminal
  // in any TOP-LEVEL project under `root` (nested dirs would dead-end: the UI
  // only auto-opens root children). Child runs are restricted to their own dir.
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
        const rel = path.relative(rootAbs, resolved)
        if (!rel || rel.includes(path.sep)) {
          return { ok: false, error: 'Only top-level project directories can host terminals.' }
        }
        const available = await listProjects(rootAbs)
        if (!available.includes(rel)) {
          return { ok: false, error: `No project named "${rel}" — available: ${available.join(', ')}` }
        }
        targetName = rel
        targetDir  = resolved
      }

      // Reuse path: when the caller passes `term` AND a runtime session for
      // (sessionId, target, term) already exists, send the new prompt to that
      // PTY instead of spawning a fresh one. This is the model's way to do
      // follow-up work in an already-open terminal — same conversation, same
      // visible tab — instead of stacking up a new tab per request.
      const reqTerm = typeof args.term === 'string' ? args.term.trim() : ''
      const existingKey = reqTerm ? `${ctx.sessionId}:${targetName}:${reqTerm}` : ''
      const reused = !!(reqTerm && this.targetSessions.has(existingKey))
      const term = reused ? reqTerm : `t-${randomUUID().slice(0, 8)}`
      // terminal_open is idempotent on the client (it ignores already-present
      // keys), but for a clean reuse we skip it — the tab is already on screen
      // and emitting it again would only burn a wire round-trip.
      if (!reused) ctx.onEvent({ type: 'terminal_open', target: targetName, term })

      const prompt = args.prompt?.trim()
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

  // Builds the per-spawn read_terminal handler. Resolves a (target, term?) into
  // the child's recent text — either the orchestrator's cleaned childTranscripts
  // buffer (default; populated by mcp__axel_report__report or end-of-turn
  // scrape) or the live PTY's 4KB ANSI-stripped tail (`raw: true`; only
  // applicable when the runtime is PtyAgent). Root spawns only — children
  // mustn't peek at sibling terminals.
  private makeTerminalReadHandler(ctx: { sessionId: string }): TerminalReadHandler {
    return async args => {
      const target = (args.target ?? '').trim()
      if (!target) return { ok: false, error: '`target` is required: the dir name of the terminal to read.' }
      const term = (args.term ?? '').trim() || 'main'
      const childKey = `${ctx.sessionId}:${target}:${term}`

      let rawText: string | null = null
      const spawnId = this.targetSessions.get(childKey)
      if (spawnId) {
        const peek = this.getAgent().peek?.(spawnId)
        if (peek) rawText = peek.strippedTail.trim() || peek.turnText.trim() || null
      }

      const transcript = (this.childTranscripts.get(childKey)?.text ?? '').trim()

      if (args.raw) {
        if (rawText) return { ok: true, target, term, text: rawText, source: 'raw' }
        if (transcript) return { ok: true, target, term, text: transcript, source: 'transcript' }
        return { ok: false, error: `No text yet for ${target} [${term}] — terminal may be idle or just opened.` }
      }

      // Default: prefer the cleaned transcript (it's structured prose from
      // report() or a noise-filtered scrape). If empty, fall back to raw —
      // better to hand the model messy bytes than say "no output".
      if (transcript) {
        // If we ALSO have raw and they diverge meaningfully, include both —
        // sometimes the cleaner stripped findings the raw kept.
        if (rawText && rawText.length > transcript.length * 1.5) {
          return { ok: true, target, term, text: `${transcript}\n\n--- raw terminal tail (less filtered) ---\n${rawText}`, source: 'mixed' }
        }
        return { ok: true, target, term, text: transcript, source: 'transcript' }
      }
      if (rawText) return { ok: true, target, term, text: rawText, source: 'raw' }
      return { ok: false, error: `No text yet for ${target} [${term}] — terminal may be idle or just opened.` }
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
    return async () => {
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

  private runFanOut(
    userMessage: string,
    sessionId: string,
    targetNames: Array<string>,
    root: string,
    onEvent: (event: FanOutEvent) => void,
    onAuthUrl: (url: string) => void,
  ): void {
    const targets = targetNames.map((name, order) => ({
      id: name, name, dir: path.join(root, name), order,
    }))

    // Spoken hand-off so the user hears the fan-out instead of silence.
    onEvent({ type: 'token', value: `Spinning up ${targets.length} terminals — I'll let you know as each one finishes.` })
    onEvent({ type: 'message_end' })

    // Announce the plan so the UI can set up star systems.
    onEvent({ type: 'task_plan', tasks: targets })
    onEvent({ type: 'fan_out', targets })

    // Stagger target_start events so the UI orb travels to each star system
    // one by one (animation), but ALL sub-agents launch simultaneously —
    // "go to first place, open session, move on to next place".
    const ORB_TRAVEL_MS = 750
    targets.forEach((t, i) => {
      setTimeout(() => onEvent({ type: 'target_start', target: t.id }), i * ORB_TRAVEL_MS)
    })

    // Detached, like the single-target path: every sub-agent runs in its own
    // directory with its own Claude session; the root turn ends immediately.
    // Failures in one don't stop the others.
    void Promise.allSettled(
      targets.map(async t => {
        try {
          await this.handleDirMessage(userMessage, sessionId, t.id, t.dir, onEvent, onAuthUrl)
        } finally {
          onEvent({ type: 'target_done', target: t.id })
        }
      }),
    ).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[orchestrator] sub-agent error:', r.reason)
        }
      }
    })
  }
}
