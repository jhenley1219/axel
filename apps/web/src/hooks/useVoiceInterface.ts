import { useState, useRef, useCallback, useEffect } from 'react'
import type { AgentWireMessage, InstalledToolView, TimerState, NotesState } from '@axel/agent'
import type { OrbState } from '../components/Voice/VoiceOrb.js'
import { appendToken, finalizeLast, finalizeTarget, termKey } from './messages.js'
import type { Message } from './messages.js'
import { useTtsEngine } from './useTtsEngine.js'
import type { TtsControls } from './useTtsEngine.js'
import { useSpeechRecognition } from './useSpeechRecognition.js'
import { useVoiceAsks } from './useVoiceAsks.js'
import { beepStart, beepEnd } from './earcons.js'
import { loadPersistedSession, savePersistedSession, clearPersistedSession } from './sessionPersistence.js'
import { resetSession } from '../api.js'

// A claude spawn paused on a tool call, waiting for the user's allow/deny.
export type PermissionRequest = { id: string; toolName: string; input?: unknown }

// Hooks the constellation provides so AxelAgent's UI-open tools can drive the
// same actions a user click would (open a dir-ring or a file window).
export type VoiceInterfaceOptions = {
  onUIOpenFile?: (path: string) => void
  onUIOpenDir?:  (path: string) => void
  // Return the orb to the projects root (backs the agent's go_home tool).
  onUIFocusRoot?: () => void
  // Human description of where the orb currently sits in the constellation,
  // read at send time and shipped with the prompt so the root agent knows
  // its own on-screen location.
  getLocation?:  () => string
}

// A claude spawn paused on a multiple-choice question, waiting for the user's
// pick (voice option or terminal click) or cancel.
export type QuestionRequest = { id: string; question: string; options: Array<string> }

// One in-flight (or recently-ended) tool call. Drives bubble-bar pulse/flash.
// `endedAt` set → bubble is in its flash window; cleared after FLASH_MS.
export type ToolInvocation = {
  invocationId: string
  toolName: string
  target: string       // '' = root agent; else child dir name (for persona tint)
  startedAt: number
  endedAt?: number
  ok?: boolean
  input?: unknown
  result?: unknown
}
const FLASH_MS = 900

// An agent's open_file tool call surfaced to the UI. Fire-and-forget on the
// agent side — the UI keeps the request around until it's dismissed (opened
// into the constellation, or explicitly closed).
export type FileOpenRequest = {
  id: string
  path: string
  highlights?: Array<{ snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }>
  suggestion?: { find: string; replace: string; reason?: string }
  prompt?: string
  target?: string
  term?: string
}

// Map a recognized utterance to allow/deny, or null if the user said something
// else and we should re-prompt rather than guess. Lowercased + stripped to word
// characters so "Yes!" and "yes." both hit. Compared as whole tokens — "no" in
// "go ahead now" must not trigger a deny.
function parseVoiceVerdict(transcript: string): 'allow' | 'deny' | null {
  const tokens = transcript.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const ALLOW = new Set(['yes', 'yeah', 'yep', 'yup', 'allow', 'allowed', 'ok', 'okay', 'sure', 'go', 'proceed', 'approve', 'approved', 'confirm', 'confirmed', 'do'])
  const DENY  = new Set(['no', 'nope', 'nah', 'deny', 'denied', 'cancel', 'stop', 'reject', 'rejected', 'block', 'blocked', 'never'])
  // First-token bias: "yes please" allows; "no thanks" denies. A bare verb in
  // the middle ("I think yes") still wins if it's the only matching token.
  for (const t of tokens) {
    if (ALLOW.has(t)) return 'allow'
    if (DENY.has(t))  return 'deny'
  }
  return null
}

// Short voice question for one permission request — natural language, no full
// file paths (just the basename) and a tool-specific verb so the user hears
// "write notes.txt" not "Write on /Users/.../notes.txt".
function voiceQuestion(toolName: string, input: unknown): string {
  return `Claude wants to ${describeToolCall(toolName, input)}. Allow or deny?`
}

function describeToolCall(toolName: string, input: unknown): string {
  const o = (input != null && typeof input === 'object') ? input as Record<string, unknown> : {}
  const basename = (v: unknown): string => {
    if (typeof v !== 'string' || !v) return ''
    return v.split('/').filter(Boolean).pop() ?? v
  }
  const cap = (s: string, n: number): string => s.length > n ? s.slice(0, n - 1) + '…' : s
  // mcp__axel_terminals__open_terminal → open_terminal
  const bare = toolName.startsWith('mcp__')
    ? (toolName.split('__').pop() ?? toolName)
    : toolName

  switch (bare.toLowerCase()) {
    case 'write': {
      const b = basename(o.file_path) || basename(o.path)
      return b ? `write ${b}` : 'write a file'
    }
    case 'edit': {
      const b = basename(o.file_path) || basename(o.path)
      return b ? `edit ${b}` : 'edit a file'
    }
    case 'multiedit': {
      const b = basename(o.file_path) || basename(o.path)
      return b ? `make multiple edits to ${b}` : 'make multiple edits'
    }
    case 'bash': {
      const c = typeof o.command === 'string' ? o.command : ''
      return c ? `run ${cap(c, 60)}` : 'run a command'
    }
    case 'webfetch': {
      const u = typeof o.url === 'string' ? o.url : ''
      try { const host = new URL(u).host; return host ? `fetch from ${host}` : 'fetch a URL' }
      catch { return 'fetch a URL' }
    }
    case 'open_terminal': {
      const d = typeof o.directory === 'string' ? o.directory : ''
      return d ? `open a terminal in ${d}` : 'open a terminal'
    }
    case 'start_timer': {
      const m = typeof o.minutes === 'number' ? o.minutes : undefined
      return m ? `start a ${m}-minute timer` : 'start a timer'
    }
    case 'pause_timer':  return 'pause the timer'
    case 'resume_timer': return 'resume the timer'
    case 'cancel_timer': return 'cancel the timer'
    case 'write_notes':  return 'write to your notes'
    case 'append_notes': return 'append to your notes'
    case 'clear_notes':  return 'clear your notes'
    default: {
      const pretty = bare.replace(/_/g, ' ')
      const detail = basename(o.file_path) || basename(o.path) || basename(o.url)
      return detail ? `use ${pretty} on ${detail}` : `use ${pretty}`
    }
  }
}

// Match a voice utterance to one of the question's options. Tries, in order:
//   1. an explicit ordinal ("one", "two", "first", "second", "number 3", "3")
//   2. a single-letter pick ("a", "b", "c", "option b")
//   3. a substring-of-option match — but only if it hits exactly one option, so
//      "the second one" doesn't ambiguously match "second" inside multiple
//      options.
// Returns the chosen index, 'cancel' for "never mind"-class phrases, or null
// for unclear (caller re-prompts).
const ORDINAL_WORDS: Record<string, number> = {
  one: 0, first: 0, '1st': 0,
  two: 1, second: 1, '2nd': 1,
  three: 2, third: 2, '3rd': 2,
  four: 3, fourth: 3, '4th': 3,
  five: 4, fifth: 4, '5th': 4,
  six: 5, sixth: 5, '6th': 5,
  seven: 6, seventh: 6, '7th': 6,
  eight: 7, eighth: 7, '8th': 7,
}
function parseQuestionPick(utterance: string, options: Array<string>): number | 'cancel' | null {
  const u = utterance.toLowerCase().trim()
  if (!u) return null
  if (/\b(cancel|never\s*mind|skip|forget it|none|nothing)\b/.test(u)) return 'cancel'
  const tokens = u.split(/[^a-z0-9]+/).filter(Boolean)
  // Plain digit: "3" → index 2. Also "number 3" / "option 3" patterns.
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10)
      if (n >= 1 && n <= options.length) return n - 1
    }
    if (t in ORDINAL_WORDS) {
      const i = ORDINAL_WORDS[t]
      if (i < options.length) return i
    }
  }
  // Single letter pick: "a", "option b", "let's go with c". Only fires when the
  // utterance is short (≤4 tokens) — otherwise stray letters in long answers
  // would dominate substring matching.
  if (tokens.length <= 4) {
    for (const t of tokens) {
      if (/^[a-h]$/.test(t)) {
        const i = t.charCodeAt(0) - 'a'.charCodeAt(0)
        if (i < options.length) return i
      }
    }
  }
  // Substring of option text. Normalize both sides to letters/digits to ignore
  // punctuation. Only commit if exactly one option matches — ambiguity returns
  // null so the user gets re-prompted instead of a wrong commit.
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const nu = norm(u)
  if (nu.length >= 3) {
    let hit = -1
    for (let i = 0; i < options.length; i++) {
      const no = norm(options[i])
      if (no.length < 3) continue
      if (nu.includes(no) || no.includes(nu)) {
        if (hit !== -1) return null  // ambiguous
        hit = i
      }
    }
    if (hit !== -1) return hit
  }
  return null
}

// Length above which the user is asked "full or summary?" before a transcript
// is read aloud. 600 chars ≈ 100 words ≈ half a minute of TTS — long enough
// to want a choice.
const TRANSCRIPT_READ_THRESHOLD = 600

// "rta-blueprint-api" → "rta blueprint api" — hyphens read as pauses on TTS.
function speakName(target: string): string {
  return target.replace(/[-_]/g, ' ')
}

// Pull the assistant lines out of a transcript and produce a full reading
// and a short (last-message) summary. Skips the user's own prompts.
function extractTranscript(messages: Array<Message>): { full: string; short: string } {
  const lines = messages
    .filter(m => m.role === 'axel')
    .map(m => m.text.trim())
    .filter(Boolean)
  const full = lines.join('. ')
  const short = lines[lines.length - 1] ?? ''
  return { full, short }
}

// Orchestrates the voice loop: WS agent stream → message state + TTS engine,
// orb taps → speech-recognition engine, barge-in VAD while Axel speaks.
export function useVoiceInterface(options: VoiceInterfaceOptions = {}) {
  // Keep callbacks behind a ref so the mount-once WS handler sees current
  // values without forcing the socket to re-mount when consumers re-render.
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])
  // Rehydrate from sessionStorage so an accidental tab reload (mobile Safari
  // backgrounding, address-bar pull-down) restores the visible transcript
  // instead of dropping the user back to an empty orb screen. Lazy init so
  // the parse only happens on first mount, not on every render.
  const [persisted] = useState(loadPersistedSession)
  const [orbState,  setOrbState]  = useState<OrbState>('idle')
  const [messages,  setMessages]  = useState<Array<Message>>(persisted.messages)
  const [statusMsg, setStatusMsg] = useState('')
  const [authUrl,   setAuthUrl]   = useState<string | null>(null)
  // Last tool_use event from the WS — id increments each time so downstream
  // consumers can react via useEffect without missing events that share the
  // same name. `input` is the tool call's args, used by specialized card
  // renderers (e.g. timer countdown).
  const [toolUseEvent, setToolUseEvent] = useState<{ name: string; input?: unknown; id: number; target?: string } | null>(null)
  const toolUseIdRef = useRef(0)
  // Bumped each time the server reports the projects directory set changed
  // (a dir was created/removed). Consumers watch this via useEffect to
  // surgically re-pull the constellation without a full page reload.
  const [fsChangeId, setFsChangeId] = useState(0)
  // Multi-target fan-out state. When the server detects the user's message
  // refers to multiple projects, it streams events tagged with `target`. We
  // track per-terminal status (for the dir-node pulse) and per-terminal
  // message buffers (so each terminal tab renders its own transcript).
  // Buffers and statuses are keyed by termKey(target, term) — a dir can host
  // several independent terminals; events without `term` are the 'main' one.
  const [fanOut, setFanOut] = useState<{
    targets: Array<{ id: string; name: string; dir: string }>
    status: Record<string, 'streaming' | 'done'>
  } | null>(persisted.fanOut)
  const [targetMessages, setTargetMessages] = useState<Record<string, Array<Message>>>(persisted.targetMessages)
  const [currentTarget,  setCurrentTarget]  = useState<string | null>(persisted.currentTarget)
  // Per-terminal lifecycle, fed to the constellation so each terminal can
  // show working / done / error instead of spinning forever.
  const [targetStatus, setTargetStatus] = useState<Record<string, 'working' | 'done' | 'error'>>(persisted.targetStatus)
  // Per-terminal PTY spawnId — present once the server emits `pty_ready` for
  // that (target, term). xterm.js in SessionWin uses it to connect to
  // /agent/pty/<spawnId>. Not persisted: spawnIds belong to a live server
  // PTY which dies on server restart.
  const [targetSpawnIds, setTargetSpawnIds] = useState<Record<string, string>>({})
  // Pending tool-permission prompts, keyed by termKey(target, term)
  // ('' = main session).
  const [permissionRequests, setPermissionRequests] = useState<Record<string, Array<PermissionRequest>>>({})
  // Pending multiple-choice questions, same keying scheme as permissions.
  const [questionRequests, setQuestionRequests] = useState<Record<string, Array<QuestionRequest>>>({})
  // Pending sub-agent queue requests (rendered as a per-dir-colored badge on
  // the constellation). Items move pending → claimed when the root agent
  // starts handling them, then drop off on resolve. Color is driven off the
  // sender's persona/file-cloud color downstream from this slice.
  const [queueItems, setQueueItems] = useState<Array<{
    id: string
    fromTarget: string
    fromTerm?: string
    kind: 'proposal' | 'question' | 'confirmation'
    prompt: string
    options?: Array<string>
    claimed: boolean
  }>>([])
  // Pending file-open requests from the agent's open_file tool. Drained by
  // ConstellationView, which materializes each into a popup tab.
  const [fileOpenRequests, setFileOpenRequests] = useState<Array<FileOpenRequest>>([])
  // dir_closed events from the agent's close_idle_dirs sweep. Drained by
  // ConstellationView, which resolves each target name to a system id and
  // calls the existing closeSystem animation.
  const [closedDirEvents, setClosedDirEvents] = useState<Array<{ id: string; target: string }>>([])
  // Bubble bar: tool catalog (replaced on tool_catalog) + per-call lifecycle.
  // `tool_use` adds an entry; `tool_end` flips it to flashing; a setTimeout
  // drops it after FLASH_MS so the bar empties on its own. Concurrent calls
  // to the same tool stack and animate independently.
  const [installedTools,    setInstalledTools]    = useState<Array<InstalledToolView>>([])
  const [activeInvocations, setActiveInvocations] = useState<Array<ToolInvocation>>([])
  // Per-app shared state, mirrored from the server's AppBroker via `app_state`
  // wire events. The bubble bar uses these to drive an "is-active" tint
  // (timer running, notes recently written), and the app popups read these
  // for their main UI. `timerState === null` means no timer is active.
  const [timerState, setTimerState] = useState<TimerState | null>(null)
  const [notesState, setNotesState] = useState<NotesState>({ content: '', updatedAt: 0 })
  const hasTaskPlanRef = useRef(false)
  // Mirror of targetStatus readable inside the (mount-once) WS handler.
  const targetStatusRef = useRef<Record<string, 'working' | 'done' | 'error'>>({})
  // Completion announcements. Background terminals report in here when they
  // finish; the flush effect below speaks them only once the user is idle, so
  // a child finishing never talks over an in-progress turn.

  const wsRef   = useRef<WebSocket | null>(null)
  const busyRef = useRef(false)
  // True once the current turn's `done` event has arrived. Axel may speak
  // several messages in one turn; the mic must re-arm only after the FINAL
  // one finishes — never in the gaps between messages, where Axel is still
  // talking and the user has nothing to say yet.
  const streamEndedRef = useRef(true)
  // Voice/chat ALWAYS routes to root — children are background workers the
  // root agent delegates to or reads remotely. activeDirRef is permanently
  // '' on purpose; the focus-check sites below (token TTS gating, announce
  // queuing, permission-voice gating) all degrade correctly to "user is on
  // root, route everything through here". setActiveContext is kept as an
  // exported no-op so future callers can't silently regress the invariant —
  // any non-empty arg is ignored.
  const activeDirRef = useRef<string>('')
  const setActiveContext = useCallback((_dirName: string) => { /* policy: voice always = root */ }, [])

  // Lets the TTS-done callback and barge-in VAD restart listening without a
  // dependency cycle (startListening is defined below the engines).
  const startListeningRef = useRef<() => void>(() => {})
  // Late-bound checks the TTS-drain callback uses without re-binding when
  // useVoiceAsks / respondPermission are created below the engines.
  const hasPendingAskRef     = useRef<() => boolean>(() => false)
  const respondPermissionRef = useRef<(id: string, behavior: 'allow' | 'deny') => void>(() => {})
  const respondQuestionRef   = useRef<(id: string, choice: number | 'cancel') => void>(() => {})
  // Background-terminal transcripts that haven't been read out to the user
  // yet. Populated alongside the spoken "transcript has the details" announce
  // (same condition: target_done, not focused, not errored). Drained when the
  // user says "read the transcript". The ref is read by recognition/TTS
  // callbacks (no re-render needed); the state mirror drives the QueueMenu.
  // Mutators ALWAYS write both in lockstep — use `setUnreadTranscripts` to
  // update the ref and state together (see writeUnread below).
  const unreadTranscriptsRef = useRef<Array<{ target: string; term: string; key: string }>>([])
  const [unreadTranscripts, setUnreadTranscriptsState] = useState<Array<{ target: string; term: string; key: string }>>([])
  const writeUnread = useCallback((next: Array<{ target: string; term: string; key: string }>) => {
    unreadTranscriptsRef.current = next
    setUnreadTranscriptsState(next)
  }, [])
  // Mirror of targetMessages so the (mount-once) handlers and read callbacks
  // can sample the latest buffers without recreation. Same pattern as
  // targetStatusRef above.
  const targetMessagesRef = useRef<Record<string, Array<Message>>>({})

  const tts = useTtsEngine(() => {
    // The TTS queue drained. Finalize whatever bubble just finished, but if
    // the turn itself hasn't ended this is merely the gap between two of
    // Axel's own messages — stay put: don't reset the orb, don't open the
    // mic. Only after the turn's final message do we hand the floor back —
    // OR when a voice ask is pending (the user is the only one who can
    // unblock it, regardless of agent-stream state).
    setMessages(finalizeLast)
    if (hasPendingAskRef.current()) {
      setOrbState('idle')
      setTimeout(() => startListeningRef.current(), 600)
      return
    }
    if (!streamEndedRef.current) return
    setOrbState('idle')
    setTimeout(() => startListeningRef.current(), 600)
  })

  // One-at-a-time pending voice question (permission allow/deny, transcript
  // pick, transcript-length choice). See useVoiceAsks for the contract.
  const voiceAsks = useVoiceAsks(tts, setOrbState)
  useEffect(() => { hasPendingAskRef.current = voiceAsks.hasPending }, [voiceAsks])
  useEffect(() => { targetMessagesRef.current = targetMessages }, [targetMessages])

  // ── Transcript reading — local handler ─────────────────────────────────────
  // Reads ONE entry's transcript out loud. Asks short-vs-full when long.
  // Removes the entry from the unread list after the answer plays so the
  // user can't get the same transcript twice from sequential "read it" asks.
  const readOneTranscript = useCallback((entry: { target: string; term: string; key: string }) => {
    const removeUnread = (): void => {
      writeUnread(unreadTranscriptsRef.current.filter(u => u.key !== entry.key))
    }
    const speakInline = (text: string): void => {
      // Bypass voiceAsks — we're not asking a question, just speaking.
      // The drain callback re-arms via hasPendingAskRef if another ask is
      // pending; otherwise streamEndedRef gating applies (which is fine when
      // the user invoked this between turns).
      setOrbState('responding')
      tts.flushMessage()
      tts.pushToken(text)
      tts.flushMessage()
      tts.endStream()
    }
    const msgs = targetMessagesRef.current[entry.key] ?? []
    const { full, short } = extractTranscript(msgs)
    if (!full) {
      speakInline(`The ${speakName(entry.target)} transcript is empty.`)
      removeUnread()
      return
    }
    if (full.length <= TRANSCRIPT_READ_THRESHOLD) {
      speakInline(`From ${speakName(entry.target)}. ${full}`)
      removeUnread()
      return
    }
    // Long transcript — ask the user before reading the wall of text.
    voiceAsks.ask({
      id: `transcript-length-${entry.key}`,
      question: `That transcript is long. Want the full version or a short summary?`,
      reprompt: `Sorry, full or short?`,
      parse: utterance => {
        const t = utterance.toLowerCase()
        if (/\b(full|long|all|entire|everything|complete)\b/.test(t)) {
          return { kind: 'answered', action: () => { speakInline(`From ${speakName(entry.target)}. ${full}`); removeUnread() } }
        }
        if (/\b(short|summary|brief|tldr|tl\s*dr|just|quick)\b/.test(t)) {
          return { kind: 'answered', action: () => { speakInline(`From ${speakName(entry.target)}. ${short}`); removeUnread() } }
        }
        if (/\b(cancel|never\s*mind|skip|forget it)\b/.test(t)) {
          return { kind: 'cancelled' }
        }
        return { kind: 'unclear' }
      },
    })
  }, [tts, voiceAsks])

  // ── Send transcript to agent ───────────────────────────────────────────────
  const sendTranscript = useCallback((text: string) => {
    tts.unlock()
    const trimmed = text.trim()
    if (!trimmed) { setOrbState('idle'); return }
    // No client-side intent matching. Every utterance — including questions
    // about background terminals — goes to the root agent, which gets a
    // "BACKGROUND TERMINALS" section in its system prompt (server-side
    // AgentOrchestrator.getChildStatusForRoot) describing what each sub-
    // agent has said. The agent itself decides whether/how to relay.
    // Verbatim playback is still reachable from the QueueMenu (click a row)
    // — that's UI-driven, not phrase-driven, and stays.
    setOrbState('thinking')
    busyRef.current = true
    streamEndedRef.current = false  // new turn — mic stays closed until it fully ends
    const ws = wsRef.current

    // Voice + main chat always go to the root orchestrator. The root agent
    // delegates to per-dir children on its own; the user never converses
    // directly with a sandboxed child here. Direct-talk-to-a-tab still works
    // through that terminal's own prompt bar (sendDirInput, below).
    setMessages(prev => [...prev, { role: 'user', text }])
    if (ws?.readyState === WebSocket.OPEN) {
      const location = optionsRef.current.getLocation?.() ?? ''
      ws.send(JSON.stringify({ type: 'main_input', text, location }))
    } else {
      busyRef.current = false
      setOrbState('idle')
      setStatusMsg('Reconnecting — try again in a moment')
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const sr = useSpeechRecognition(
    transcript => {
      // Capture-end earcon — fires on every stop (silence, manual, intent
      // captured) so the user knows the mic is no longer listening before any
      // routing decision happens.
      beepEnd()
      // Voice-ask gate: a pending question (permission, transcript pick,
      // transcript length) consumes the next utterance instead of starting
      // a new agent turn. See useVoiceAsks for the parser contract.
      if (transcript && voiceAsks.route(transcript) === 'handled') return
      if (transcript) sendTranscript(transcript)
      else setOrbState('idle')
    },
    setStatusMsg,
  )

  // ── Start / stop listening ─────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (orbState !== 'idle') return
    // busyRef gates the mic during a normal agent turn so we don't capture
    // speech while Axel is mid-stream. EXCEPTION: a pending voice ask
    // (permission allow/deny, question pick) means the agent is paused
    // EXPLICITLY waiting on the user — the mic must open even though
    // busyRef is still true, because the agent's "busy" state IS what's
    // waiting on the answer. Without this carve-out the user has to tap
    // the orb to answer every permission prompt.
    if (busyRef.current && !hasPendingAskRef.current()) return
    if (sr.start()) {
      // Capture-start earcon — confirms the mic actually opened. Critical for
      // the iPhone use case where the screen may be off-axis or out of view.
      beepStart()
      setOrbState('listening')
    }
  }, [orbState])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { startListeningRef.current = startListening }, [startListening])

  // ── WebSocket ──────────────────────────────────────────────────────────────
  // Self-healing connection: on close/error, schedule a reconnect with
  // exponential backoff (capped at 8s). The user never sees "reload the page"
  // anymore — flaky carrier networks, screen-lock NAT timeouts, and Safari
  // app-backgrounding all recover transparently.
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let unmounted = false

    const connect = (): void => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/agent/stream`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setStatusMsg('')
      }

      // Don't show anything on error — the close event that follows runs
      // the reconnect loop and updates status. Two messages would just race.
      ws.onerror = () => { /* handled by onclose */ }

      ws.onclose = ev => {
        if (unmounted) return
        // 4401 — server rejected auth. Looping would just spam; the lockscreen
        // will appear after the next /auth/status poll. Leave the user a hint.
        if (ev.code === 4401) {
          setStatusMsg('Session expired — please sign in again')
          return
        }
        const delay = Math.min(8_000, 500 * Math.pow(2, attempt))
        attempt += 1
        setStatusMsg(attempt > 1 ? `Reconnecting (attempt ${attempt})…` : 'Reconnecting…')
        reconnectTimer = setTimeout(connect, delay)
      }

      ws.onmessage = e => {
      const msg = JSON.parse(e.data as string) as AgentWireMessage

      // ── Fan-out lifecycle ────────────────────────────────────────────────
      if (msg.type === 'task_plan') {
        hasTaskPlanRef.current = true
        const names = msg.tasks.map(t => t.name).join(' → ')
        setMessages(prev => [...prev, {
          role: 'axel',
          text: `Sequential task plan (${msg.tasks.length}): ${names}`,
          streaming: false,
        }])
        setOrbState('thinking')
        return
      }

      if (msg.type === 'fan_out') {
        const status: Record<string, 'streaming' | 'done'> = {}
        const buffers: Record<string, Array<Message>> = {}
        for (const t of msg.targets) {
          status[t.id] = 'streaming'
          buffers[termKey(t.id)] = []
        }
        setFanOut({ targets: msg.targets, status })
        // Merge, don't replace: other dirs may have detached agents still
        // running — a new fan-out must not wipe their live transcripts.
        setTargetMessages(prev => ({ ...prev, ...buffers }))
        setCurrentTarget(null)
        if (!hasTaskPlanRef.current) {
          const names = msg.targets.map(t => t.name).join(', ')
          setMessages(prev => [...prev, {
            role: 'axel',
            text: `Spawning ${msg.targets.length} agents on: ${names}`,
            streaming: false,
          }])
        }
        hasTaskPlanRef.current = false
        setOrbState('thinking')
        return
      }

      if (msg.type === 'pty_ready') {
        // The server opened an interactive `claude` PTY for this (target, term).
        // Stash the spawnId so the SessionWin for that terminal mounts an
        // xterm view bound to /agent/pty/<spawnId>. Root agent PTYs
        // (no target) are intentionally invisible — they back the voice loop
        // and don't need a window.
        if (msg.target) {
          const key = termKey(msg.target, msg.term)
          setTargetSpawnIds(prev => prev[key] === msg.spawnId ? prev : { ...prev, [key]: msg.spawnId })
        }
        return
      }

      if (msg.type === 'target_start') {
        const key = termKey(msg.target, msg.term)
        setCurrentTarget(msg.target)
        targetStatusRef.current[key] = 'working'
        setTargetStatus(prev => ({ ...prev, [key]: 'working' }))
        // A re-run supersedes whatever transcript was sitting unread for the
        // same key — the user will hear about THIS run's outcome, not the
        // last one. (Drop the stale entry; don't speak a "this is stale"
        // line — the user already moved on by re-running.)
        writeUnread(unreadTranscriptsRef.current.filter(u => u.key !== key))
        return
      }

      if (msg.type === 'target_done') {
        const key = termKey(msg.target, msg.term)
        setFanOut(prev => prev ? {
          ...prev,
          status: { ...prev.status, [msg.target]: 'done' },
        } : prev)
        const errored = targetStatusRef.current[key] === 'error'
        if (!errored) targetStatusRef.current[key] = 'done'
        setTargetStatus(prev => prev[key] === 'error' ? prev : { ...prev, [key]: 'done' })
        // Finalize any streaming bubble in that terminal.
        setTargetMessages(prev => finalizeTarget(prev, key))
        // Track unread for the QueueMenu badge / click-to-read affordance.
        // NO client-generated TTS announce: all audio routes through the
        // root agent, which sees this child in its BACKGROUND TERMINALS
        // prompt section and decides when/how to mention it.
        if (!errored && msg.target !== activeDirRef.current) {
          writeUnread([...unreadTranscriptsRef.current, { target: msg.target, term: msg.term ?? 'main', key }])
        }
        return
      }

      if (msg.type === 'token') {
        // Child-agent tokens stream into their own terminal tab, not the main
        // session log. Skip TTS for child output — too noisy to speak when
        // several agents talk at once — EXCEPT the MAIN terminal of the dir
        // the user is actively focused on: that's a direct conversation.
        if (msg.target) {
          const key = termKey(msg.target, msg.term)
          setTargetMessages(prev => ({
            ...prev,
            [key]: appendToken(prev[key] ?? [], msg.value),
          }))
          // Background children must not touch the orb or TTS — flipping the
          // orb out of 'idle' here would block the mic from re-arming while
          // a detached child streams. Side terminals of the focused dir count
          // as background too.
          if (msg.target === activeDirRef.current && (msg.term ?? 'main') === 'main') {
            tts.pushToken(msg.value)
            setOrbState('responding')
          }
          return
        }

        tts.pushToken(msg.value)
        setMessages(prev => appendToken(prev, msg.value))
        setOrbState('responding')
        return
      }

      if (msg.type === 'message_end') {
        // For a child agent, finalize the current bubble in its own terminal.
        // Speak it only when its dir's MAIN terminal holds voice focus.
        if (msg.target) {
          setTargetMessages(prev => finalizeTarget(prev, termKey(msg.target!, msg.term)))
          if (msg.target === activeDirRef.current && (msg.term ?? 'main') === 'main') tts.flushMessage()
          return
        }
        // Main session: hand the accumulated message to TTS so it starts
        // speaking now, while the agent continues with tool calls / next message.
        tts.flushMessage()
        setMessages(finalizeLast)
        return
      }

      if (msg.type === 'tool_use') {
        toolUseIdRef.current += 1
        setToolUseEvent({ name: msg.name, input: msg.input, id: toolUseIdRef.current, target: msg.target })
        // Bubble-bar pulse: track each invocation independently so two
        // concurrent calls to the same tool animate side-by-side instead of
        // canceling each other. target = '' when the root agent calls it,
        // else the child's dir name — used for persona-color tint.
        setActiveInvocations(prev => [...prev, {
          invocationId: msg.invocationId,
          toolName: msg.name,
          target: msg.target ?? '',
          startedAt: performance.now(),
          input: msg.input,
        }])
        // Same focus rule as tokens: a background child's tool calls must not
        // flip the orb to 'thinking' and lock the mic.
        if (!msg.target || (msg.target === activeDirRef.current && (msg.term ?? 'main') === 'main')) setOrbState('thinking')
        return
      }

      if (msg.type === 'tool_end') {
        // Mark the matching invocation as flashing; schedule cleanup after
        // FLASH_MS so the bubble animates the success/error pulse then GCs.
        setActiveInvocations(prev => prev.map(inv =>
          inv.invocationId === msg.invocationId
            ? { ...inv, endedAt: performance.now(), ok: msg.ok, result: msg.result }
            : inv,
        ))
        setTimeout(() => {
          setActiveInvocations(prev => prev.filter(inv => inv.invocationId !== msg.invocationId))
        }, FLASH_MS)
        return
      }

      if (msg.type === 'tool_progress') {
        // Streaming progress patches the in-flight invocation's `result` slot
        // so renderers can show partial output. Deep-merge would be nice but
        // tools that need it can shape their patches accordingly.
        setActiveInvocations(prev => prev.map(inv =>
          inv.invocationId === msg.invocationId
            ? { ...inv, result: { ...(inv.result as Record<string, unknown> | undefined), ...msg.patch } }
            : inv,
        ))
        return
      }

      if (msg.type === 'tool_catalog') {
        // Full replacement of the bubble-bar list. Server emits this on WS
        // open AND on every registry-directory change, so we never need to
        // diff registrations on the client.
        setInstalledTools(msg.tools)
        return
      }

      if (msg.type === 'tool_registered') {
        setInstalledTools(prev => {
          const i = prev.findIndex(t => t.name === msg.tool.name)
          if (i === -1) return [...prev, msg.tool]
          const next = prev.slice()
          next[i] = msg.tool
          return next
        })
        return
      }

      if (msg.type === 'tool_unregistered') {
        setInstalledTools(prev => prev.filter(t => t.name !== msg.name))
        return
      }

      if (msg.type === 'app_state') {
        if (msg.app === 'timer') setTimerState(msg.state as TimerState | null)
        else if (msg.app === 'notes') setNotesState(msg.state as NotesState)
        return
      }

      if (msg.type === 'done') {
        busyRef.current = false
        streamEndedRef.current = true  // turn complete — the next drain may re-arm the mic
        setStatusMsg('')
        setCurrentTarget(null)
        // Keep fanOut + targetMessages in place after done so the user can
        // read each child agent's transcript. They'll reset on the next
        // multi-target turn.
        tts.endStream()
        return
      }

      if (msg.type === 'error') {
        // A target-tagged error belongs to one terminal: show it there
        // (instead of an eternal spinner) and let the turn's own `done`
        // event close out the stream.
        if (msg.target) {
          const key = termKey(msg.target, msg.term)
          targetStatusRef.current[key] = 'error'
          setTargetStatus(prev => ({ ...prev, [key]: 'error' }))
          setTargetMessages(prev => ({
            ...prev,
            [key]: [...(prev[key] ?? []), { role: 'axel', text: `Error: ${msg.message}` }],
          }))
          setStatusMsg(msg.message ?? 'agent error')
          // No client-generated TTS — root agent sees the error context via
          // BACKGROUND TERMINALS and decides whether to surface it.
          return
        }
        busyRef.current = false
        streamEndedRef.current = true
        tts.reset()
        setOrbState('idle')
        setStatusMsg(msg.message ?? 'agent error')
        return
      }

      if (msg.type === 'permission_request') {
        const key = msg.target ? termKey(msg.target, msg.term) : ''
        setPermissionRequests(prev => ({
          ...prev,
          [key]: [...(prev[key] ?? []), { id: msg.id, toolName: msg.toolName, input: msg.input }],
        }))
        // For a child-agent prompt, ensure the dir's terminal exists so the
        // prompt renders INSIDE that terminal (like a normal claude session)
        // instead of as a floating overlay over the constellation.
        if (msg.target) {
          const tKey = termKey(msg.target, msg.term)
          setTargetMessages(prev => tKey in prev ? prev : { ...prev, [tKey]: [] })
        }
        // Voice ONLY the root agent's own permission prompts. Child agents'
        // prompts render inline in their terminal tab but do NOT speak — when
        // multiple agents are running, layering each one's question over the
        // root agent's narrative produces a chaotic "two voices reading the
        // same thing" mash-up. The user can still answer a child's prompt by
        // clicking its inline card or focusing the tab. useVoiceAsks enforces
        // one-at-a-time; subsequent root requests stay inline-only.
        const target = msg.target ?? ''
        const term   = msg.term   ?? 'main'
        const isRoot = !target
        const focused = isRoot && term === 'main'
        if (focused) {
          voiceAsks.ask({
            id: msg.id,
            question: voiceQuestion(msg.toolName, msg.input),
            reprompt: `Sorry, yes or no?`,
            parse: utterance => {
              const v = parseVoiceVerdict(utterance)
              if (!v) return { kind: 'unclear' }
              // Voice readback (Lee & See trust calibration): speak what the
              // system PARSED before forwarding the decision. If "yes" was
              // misheard as "allow" of the wrong action, the user hears the
              // mismatch immediately instead of discovering it after the fact.
              const verb = v === 'allow' ? 'Allowing' : 'Denying'
              const readback = `${verb} ${describeToolCall(msg.toolName, msg.input)}.`
              return { kind: 'answered', action: () => {
                setOrbState('responding')
                tts.flushMessage()
                tts.pushToken(readback)
                tts.flushMessage()
                tts.endStream()
                respondPermissionRef.current(msg.id, v)
              }}
            },
          })
        }
        return
      }

      if (msg.type === 'terminal_open') {
        // The model opened a terminal — materialize an empty tab. The buffer
        // key's appearance also triggers the constellation to open the ring.
        const key = termKey(msg.target, msg.term)
        setTargetMessages(prev => key in prev ? prev : { ...prev, [key]: [] })
        // Always refocus the orb on this target — even on reuse, where the
        // buffer key already exists so the targetMessages trigger won't fire.
        // Same pattern as target_start / queue_claimed: setCurrentTarget drives
        // ensureSystemOpen, which drills into the (possibly nested) ring.
        setCurrentTarget(msg.target)
        return
      }

      if (msg.type === 'dir_closed') {
        const id = `c-${Math.random().toString(36).slice(2, 10)}`
        setClosedDirEvents(prev => [...prev, { id, target: msg.target }])
        return
      }

      if (msg.type === 'file_open_request') {
        // Agent asked the UI to surface a file. Buffer it for ConstellationView
        // to drain. Client-generated id is just for managing the list — the
        // wire event carries no id since the agent doesn't track replies.
        const id = `f-${Math.random().toString(36).slice(2, 10)}`
        setFileOpenRequests(prev => [...prev, {
          id, path: msg.path,
          highlights: msg.highlights,
          suggestion: msg.suggestion,
          prompt:     msg.prompt,
          target:     msg.target,
          term:       msg.term,
        }])
        return
      }

      if (msg.type === 'question_request') {
        const key = msg.target ? termKey(msg.target, msg.term) : ''
        setQuestionRequests(prev => ({
          ...prev,
          [key]: [...(prev[key] ?? []), { id: msg.id, question: msg.question, options: msg.options }],
        }))
        // For a child-agent question, materialize the owning terminal so the
        // prompt renders INSIDE that tab (matches the permission flow).
        if (msg.target) {
          const tKey = termKey(msg.target, msg.term)
          setTargetMessages(prev => tKey in prev ? prev : { ...prev, [tKey]: [] })
        }
        // Same root-only voice gate as permissions: only the root agent's
        // own questions reach the speaker. Child-agent questions still render
        // inline in their tab — the user can answer by click. Voicing every
        // child's prompt collides with root narrative and creates the
        // "two voices reading similar messages" bug. useVoiceAsks enforces
        // one-at-a-time; subsequent root questions stay inline-only.
        const target = msg.target ?? ''
        const term   = msg.term   ?? 'main'
        const isRoot = !target
        const focused = isRoot && term === 'main'
        if (focused) {
          // Read the question + options aloud: "Question. Option one: foo.
          // Option two: bar." The list lets the user pick by ordinal even
          // without seeing the screen (iPhone use case).
          const recited = msg.options
            .map((o, i) => `Option ${i + 1}: ${o}.`)
            .join(' ')
          voiceAsks.ask({
            id: msg.id,
            question: `${msg.question} ${recited}`,
            reprompt: `Sorry — pick one of: ${msg.options.map((o, i) => `${i + 1}, ${o}`).join('; ')}.`,
            parse: utterance => {
              const pick = parseQuestionPick(utterance, msg.options)
              if (pick === null) return { kind: 'unclear' }
              if (pick === 'cancel') {
                return { kind: 'answered', action: () => respondQuestionRef.current(msg.id, 'cancel') }
              }
              // Voice readback before commit — same Lee & See guard the
              // permission flow uses. "Picking option 2: bar."
              const readback = `Picking option ${pick + 1}: ${msg.options[pick]}.`
              return { kind: 'answered', action: () => {
                setOrbState('responding')
                tts.flushMessage()
                tts.pushToken(readback)
                tts.flushMessage()
                tts.endStream()
                respondQuestionRef.current(msg.id, pick)
              }}
            },
          })
        }
        return
      }

      if (msg.type === 'question_resolved') {
        setQuestionRequests(prev => {
          let changed = false
          const next: typeof prev = {}
          for (const [k, list] of Object.entries(prev)) {
            const filtered = list.filter(r => r.id !== msg.id)
            if (filtered.length !== list.length) changed = true
            next[k] = filtered
          }
          return changed ? next : prev
        })
        voiceAsks.cancel(msg.id)
        return
      }

      if (msg.type === 'queue_added') {
        setQueueItems(prev => prev.some(q => q.id === msg.id) ? prev : [...prev, {
          id: msg.id,
          fromTarget: msg.fromTarget,
          fromTerm: msg.fromTerm,
          kind: msg.kind,
          prompt: msg.prompt,
          options: msg.options,
          claimed: false,
        }])
        return
      }

      if (msg.type === 'queue_claimed') {
        setQueueItems(prev => prev.map(q => q.id === msg.id ? { ...q, claimed: true } : q))
        // Reuse the existing target_start path: setting currentTarget triggers
        // useConstellationTree.ensureSystemOpen(msg.fromTarget), which floats
        // the orb to the sender dir so the user sees where the request came from.
        setCurrentTarget(msg.fromTarget)
        return
      }

      if (msg.type === 'queue_resolved') {
        setQueueItems(prev => prev.filter(q => q.id !== msg.id))
        return
      }

      if (msg.type === 'permission_resolved') {
        // Settled server-side (user action elsewhere, timeout, or the spawn
        // exited) — strip the prompt wherever it lives.
        setPermissionRequests(prev => {
          let changed = false
          const next: typeof prev = {}
          for (const [k, list] of Object.entries(prev)) {
            const filtered = list.filter(r => r.id !== msg.id)
            if (filtered.length !== list.length) changed = true
            next[k] = filtered
          }
          return changed ? next : prev
        })
        // If this was the ask we voiced (inline-click or 570s timeout settled
        // it server-side), drop it so the next utterance returns to the
        // normal agent path. useVoiceAsks.cancel is a no-op when the id
        // doesn't match the pending ask, so spurious resolves are harmless.
        voiceAsks.cancel(msg.id)
        return
      }

      if (msg.type === 'fs_changed') {
        // A directory was added or removed under the projects root. Signal
        // consumers to re-pull the directory tree. Pure UI refresh — no effect
        // on the voice loop, the active session, or any running agents.
        setFsChangeId(n => n + 1)
        return
      }

      if (msg.type === 'ui_open_dir') {
        optionsRef.current.onUIOpenDir?.(msg.path)
        return
      }

      if (msg.type === 'ui_focus_root') {
        optionsRef.current.onUIFocusRoot?.()
        return
      }

      if (msg.type === 'ui_open_file') {
        optionsRef.current.onUIOpenFile?.(msg.path)
        return
      }

      if (msg.type === 'auth_url' && msg.url) setAuthUrl(msg.url)
      }
    }

    connect()

    return () => {
      unmounted = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist transcript + fan-out to sessionStorage ─────────────────────────
  // A mobile Safari reload (memory pressure, address-bar pull-down, tab
  // restore) would otherwise reset the orb to an empty screen. We snapshot
  // the user-visible state on every change so the next mount can rehydrate.
  // Stable WS events like tool_catalog and app_state are rebroadcast on
  // reconnect — no need to persist those.
  useEffect(() => {
    savePersistedSession({ messages, targetMessages, fanOut, currentTarget, targetStatus })
  }, [messages, targetMessages, fanOut, currentTarget, targetStatus])

  // ── Ship UI-state snapshots for observability ──────────────────────────────
  // Like the persistence effect above, but sends the live UI state to the
  // server (recorded only, never echoed) so the axel-observe MCP server can
  // diff what the UI rendered against what the backend actually produced. The
  // builder is reassigned every render so the throttled timer always flushes
  // the freshest state; throttling keeps token streaming from flooding the WS.
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Constellation nav state (which ring the orb is inside) lives in
  // useConstellationTree, a sibling hook. ConstellationView writes a summary
  // here each render so the snapshot can record WHERE THE ORB ACTUALLY IS —
  // the exact UI state that diverges from the backend's open target.
  const constellationRef = useRef<unknown>(null)
  const buildSnapshotRef = useRef<() => unknown>(() => null)
  buildSnapshotRef.current = () => ({
    capturedAt: new Date().toISOString(),
    orbState,
    messages: messages.map(m => ({ role: m.role, text: m.text, streaming: m.streaming, target: m.target })),
    targetMessages: Object.fromEntries(
      Object.entries(targetMessages).map(([k, list]) => [k, list.map(m => ({ role: m.role, text: m.text, streaming: m.streaming }))]),
    ),
    targetStatus,
    activeInvocations: activeInvocations.map(i => ({ invocationId: i.invocationId, name: i.toolName, target: i.target, ok: i.ok })),
    permissionRequests,
    questionRequests,
    fanOut,
    currentTarget,
    constellation: constellationRef.current,
    installedToolCount: installedTools.length,
  })
  const flushSnapshot = useCallback(() => {
    snapshotTimerRef.current = null
    const ws = wsRef.current
    const snapshot = buildSnapshotRef.current() as { messages: Array<unknown>; targetMessages: Record<string, unknown> }
    // Skip empty pre-interaction snapshots — nothing to diff yet.
    if (snapshot.messages.length === 0 && Object.keys(snapshot.targetMessages).length === 0) return
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ui_snapshot', snapshot }))
  }, [])
  // Arm the throttled send. Exposed so ConstellationView can request a snapshot
  // when orb/ring state settles (which happens async after an open, often after
  // the message-driven throttle window has already fired).
  const requestUiSnapshot = useCallback(() => {
    if (snapshotTimerRef.current) return
    snapshotTimerRef.current = setTimeout(flushSnapshot, 750)
  }, [flushSnapshot])
  useEffect(() => { requestUiSnapshot() }, [messages, targetMessages, targetStatus, fanOut, currentTarget, orbState, activeInvocations, permissionRequests, questionRequests, installedTools, requestUiSnapshot])
  useEffect(() => () => { if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current) }, [])

  // ── Answer a pending permission prompt ─────────────────────────────────────
  const respondPermission = useCallback((id: string, behavior: 'allow' | 'deny') => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'permission_response', id, behavior }))
    }
    // Optimistic removal — the server's permission_resolved echo is a no-op then.
    setPermissionRequests(prev => {
      const next: typeof prev = {}
      for (const [k, list] of Object.entries(prev)) next[k] = list.filter(r => r.id !== id)
      return next
    })
  }, [])

  // Late-bind ref the (mount-once) WS handler and recognition callback can
  // reach without a stale closure — same trick as startListeningRef.
  useEffect(() => { respondPermissionRef.current = respondPermission }, [respondPermission])

  // ── Answer a pending multiple-choice question ─────────────────────────────
  const respondQuestion = useCallback((id: string, choice: number | 'cancel') => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      if (choice === 'cancel') {
        ws.send(JSON.stringify({ type: 'question_response', id, behavior: 'cancel' }))
      } else {
        ws.send(JSON.stringify({ type: 'question_response', id, index: choice }))
      }
    }
    setQuestionRequests(prev => {
      const next: typeof prev = {}
      for (const [k, list] of Object.entries(prev)) next[k] = list.filter(r => r.id !== id)
      return next
    })
  }, [])
  useEffect(() => { respondQuestionRef.current = respondQuestion }, [respondQuestion])

  // ── Send input to a manually-opened dir terminal ──────────────────────────
  const sendDirInput = useCallback((target: string, text: string, term = 'main') => {
    if (!text.trim()) return
    const key = termKey(target, term)
    setTargetMessages(prev => ({
      ...prev,
      [key]: [...(prev[key] ?? []), { role: 'user', text }],
    }))
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'dir_input', target, term, text: text.trim() }))
    }
  }, [])

  // ── Open / close terminal tabs (user-initiated) ────────────────────────────
  // Opening just seeds an empty buffer — the session materializes client-side
  // and the conversation starts on the first send. Mirrors `terminal_open`.
  const openTerminal = useCallback((target: string, term: string) => {
    const key = termKey(target, term)
    setTargetMessages(prev => key in prev ? prev : { ...prev, [key]: [] })
  }, [])

  const clearTerminal = useCallback((key: string) => {
    setTargetMessages(prev => {
      if (!(key in prev)) return prev
      const { [key]: _gone, ...rest } = prev
      return rest
    })
    setTargetStatus(prev => {
      if (!(key in prev)) return prev
      const { [key]: _gone, ...rest } = prev
      return rest
    })
    delete targetStatusRef.current[key]
  }, [])

  // ── Barge-in voice activity detection ──────────────────────────────────
  // While Axel is responding, sample the mic stream's RMS energy on rAF. If
  // sustained voice energy is detected for ~350ms, interrupt the TTS and
  // start a fresh listening session. Echo cancellation (enabled in the mic
  // constraints) damps the TTS bleed enough that the speech threshold is
  // reliably distinguishable.
  //
  // The mic stream lives for the WHOLE turn (thinking ↔ responding flips
  // included): keying it on 'responding' alone re-acquired getUserMedia on
  // every tool call, which flashed the iOS mic indicator on/off mid-turn.
  // The VAD only FIRES while 'responding', so barge-in behavior is unchanged.
  const bargeStreamRef = useRef<MediaStream | null>(null)
  const bargeCtxRef    = useRef<AudioContext | null>(null)
  const bargeRafRef    = useRef<number | null>(null)
  const turnLive       = orbState === 'responding' || orbState === 'thinking'
  const orbStateRef    = useRef(orbState)
  useEffect(() => { orbStateRef.current = orbState }, [orbState])

  useEffect(() => {
    if (!turnLive) {
      // tear down
      if (bargeRafRef.current !== null) cancelAnimationFrame(bargeRafRef.current)
      bargeRafRef.current = null
      bargeStreamRef.current?.getTracks().forEach(t => t.stop())
      bargeStreamRef.current = null
      bargeCtxRef.current?.close().catch(() => {})
      bargeCtxRef.current = null
      return
    }

    let canceled = false
    let aboveSince = 0
    let ambient = 0                  // EMA of RMS during quiet moments
    const ABS_THRESHOLD = 0.055      // RMS amplitude; floor for "real speech" volume
    const REL_MULT      = 3.5        // must exceed ambient × this — kills room-noise false positives
    const AMBIENT_ALPHA = 0.04       // EMA smoothing: ambient = ambient*(1-α) + rms*α when quiet
    const SUSTAIN_MS    = 350        // continuous voice energy required to fire
    const COOLDOWN_MS   = 800        // ignore the first chunk so TTS startup doesn't trip us

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 44100 },
    }).then(stream => {
      if (canceled) { stream.getTracks().forEach(t => t.stop()); return }
      bargeStreamRef.current = stream
      const AC = window.AudioContext ?? window.webkitAudioContext
      if (!AC) return
      const ctx = new AC({ latencyHint: 'playback', sampleRate: 44100 })
      bargeCtxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.2
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const startedAt = performance.now()

      const tick = () => {
        if (canceled) return
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        const now = performance.now()
        const sinceStart = now - startedAt
        // Trigger only when RMS exceeds BOTH the absolute floor AND a multiple
        // of the running ambient baseline. Quiet rooms get a low effective
        // threshold; noisy rooms get a high one — barge-in only fires on
        // actual louder-than-ambient speech.
        const loudEnough = rms > ABS_THRESHOLD && rms > ambient * REL_MULT
        // Update the ambient EMA only when NOT currently loud — so a real
        // speech burst doesn't pollute the baseline.
        if (!loudEnough) ambient = ambient * (1 - AMBIENT_ALPHA) + rms * AMBIENT_ALPHA
        if (loudEnough && sinceStart > COOLDOWN_MS && orbStateRef.current === 'responding') {
          if (aboveSince === 0) aboveSince = now
          if (now - aboveSince >= SUSTAIN_MS) {
            // Sustained voice detected — barge-in.
            canceled = true
            tts.interrupt()
            setOrbState('idle')
            setTimeout(() => startListeningRef.current(), 80)
            return
          }
        } else {
          aboveSince = 0
        }
        bargeRafRef.current = requestAnimationFrame(tick)
      }
      bargeRafRef.current = requestAnimationFrame(tick)
    }).catch(() => { /* mic denied — barge-in disabled silently */ })

    return () => {
      canceled = true
      if (bargeRafRef.current !== null) cancelAnimationFrame(bargeRafRef.current)
      bargeRafRef.current = null
      bargeStreamRef.current?.getTracks().forEach(t => t.stop())
      bargeStreamRef.current = null
      bargeCtxRef.current?.close().catch(() => {})
      bargeCtxRef.current = null
    }
  }, [turnLive])  // eslint-disable-line react-hooks/exhaustive-deps

  const onTap = useCallback(() => {
    tts.unlock()
    if (orbState === 'idle') {
      startListening()
    } else if (orbState === 'listening') {
      sr.stop()
    } else if (orbState === 'responding') {
      tts.interrupt()
      setOrbState('idle')
      setTimeout(() => startListening(), 100)
    }
  }, [orbState, startListening])  // eslint-disable-line react-hooks/exhaustive-deps

  const dismissFileOpenRequest = useCallback((id: string) => {
    setFileOpenRequests(prev => prev.filter(r => r.id !== id))
  }, [])

  // User-initiated app action (from a bubble popup). Server mirrors the same
  // dispatch table, and broadcasts the resulting app_state to every client —
  // we'll see our own change come back through the WS, no need to optimistic-
  // update locally.
  const dispatchApp = useCallback((app: 'timer' | 'notes', action: string, payload?: Record<string, unknown>): void => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'app_action', app, action, payload }))
    }
  }, [])

  const dismissClosedDirEvent = useCallback((id: string) => {
    setClosedDirEvents(prev => prev.filter(r => r.id !== id))
  }, [])

  // Start a fresh session: wipe this tab's saved snapshot, tell the server to
  // forget the runtime conversation ids for this session, then reload. The
  // reload rehydrates from an empty snapshot — a clean slate for every hook —
  // and reconnects a fresh WebSocket. Server reset is awaited so the agent has
  // genuinely forgotten before the new page connects; reload runs regardless.
  const clearSession = useCallback(async (): Promise<void> => {
    clearPersistedSession()
    try { await resetSession() } catch { /* best-effort — reload to a clean UI anyway */ }
    window.location.reload()
  }, [])

  // Expose only the settings slice of the TTS engine — playback lifecycle
  // stays internal to this orchestrator.
  const ttsControls: TtsControls = tts

  return {
    orbState,
    messages, statusMsg, liveTranscript: sr.liveTranscript,
    tts: ttsControls,
    authUrl, dismissAuthUrl: () => setAuthUrl(null),
    toolUseEvent,
    fsChangeId,
    fanOut,
    targetMessages,
    targetStatus,
    targetSpawnIds,
    currentTarget,
    permissionRequests,
    respondPermission,
    questionRequests,
    respondQuestion,
    queueItems,
    // Snapshot of unread child transcripts for the QueueMenu — same data
    // backing voice "read the transcript", just rendered as a clickable list.
    unreadTranscripts,
    readTranscript: readOneTranscript,
    fileOpenRequests,
    dismissFileOpenRequest,
    closedDirEvents,
    dismissClosedDirEvent,
    installedTools,
    activeInvocations,
    timerState,
    notesState,
    dispatchApp,
    onTap,
    sendTranscript,
    sendDirInput,
    openTerminal,
    clearTerminal,
    setActiveContext,
    cancelListening: sr.cancel,
    clearSession,
    // Observability: ConstellationView feeds orb/ring state here + pokes a
    // snapshot when it settles, so recordings capture where the orb really is.
    constellationRef,
    requestUiSnapshot,
  }
}
