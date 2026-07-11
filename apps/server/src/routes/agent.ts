import path from 'path'
import type { IncomingMessage } from 'http'
import { parse as parseCookie } from 'cookie'
import { WebSocketServer, WebSocket } from 'ws'
import type { AgentWireMessage } from '@axel/agent'
import { isPathUnder } from '@axel/core'
import { config } from '../config.js'
import { sessionManager, orchestrator, settingsManager, permissionBroker, askBroker, mcpRegistry, appBroker, queueBroker, observability } from '../services.js'
import type { UiSnapshot } from '@axel/observability'

function send(ws: WebSocket, msg: AgentWireMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// Push a message to every connected client (not tied to one prompt/session).
// Used for server-initiated events like filesystem changes.
export function broadcast(wss: WebSocketServer, msg: AgentWireMessage): void {
  const payload = JSON.stringify(msg)
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

export function createAgentWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  // Heartbeat: ping every 25s, terminate clients that didn't pong since the
  // last sweep. iOS Safari silently breaks idle WS connections (carrier NAT
  // timeouts, app backgrounding) without firing close on the client; without
  // pings the server would keep half-open sockets around forever and the
  // client's reconnect loop wouldn't fire fast enough.
  const HEARTBEAT_MS = 25_000
  const aliveSet = new WeakSet<WebSocket>()
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSet.has(ws)) { ws.terminate(); continue }
      aliveSet.delete(ws)
      try { ws.ping() } catch { /* socket already torn down */ }
    }
  }, HEARTBEAT_MS)
  interval.unref?.()
  wss.on('close', () => clearInterval(interval))

  // Permission events are tied to a spawn, not to the WS that started it —
  // if the originating tab reloads, prompts must still reach whoever is
  // watching. Unicast everything else (tokens stream to the asker).
  const fanOutEvent = (ws: WebSocket, event: AgentWireMessage): void => {
    if (
      event.type === 'permission_request' ||
      event.type === 'permission_resolved' ||
      event.type === 'question_request' ||
      event.type === 'question_resolved'
    ) {
      broadcast(wss, event)
    } else {
      send(ws, event)
    }
  }

  wss.on('connection', (ws, req) => {
    aliveSet.add(ws)
    ws.on('pong', () => aliveSet.add(ws))
    let sessionId = 'no-auth'
    if (config.requireAuth) {
      const cookieHeader = req.headers.cookie ?? ''
      const cookies = parseCookie(cookieHeader)
      const token = cookies['session']
      const session = token ? sessionManager.verify(token) : null
      if (!session) {
        send(ws, { type: 'error', message: 'not_authenticated' })
        ws.close(4401, 'not_authenticated')
        return
      }
      sessionId = session.sessionId
    }

    console.log('[ws] connection accepted, session:', sessionId.slice(0, 8) + '...')
    orchestrator.probeAuth().then(url => {
      if (url) send(ws, { type: 'auth_url', url })
    }).catch(() => {})

    // Snapshot the tool catalog so the bubble bar renders before any agent
    // turn. Cheap (reads ~/.axel/mcp-registry once); broadcast updates are
    // handled separately by the registry watcher at boot.
    mcpRegistry.listView()
      .then(tools => {
        observability.sessionStart(sessionId, { auth: sessionId !== 'no-auth', tools })
        send(ws, { type: 'tool_catalog', tools })
      })
      .catch(err => console.error('[ws] failed to send tool catalog:', err))

    // Snapshot the current app state so a freshly-opened tab shows the
    // running timer / current notes without waiting for the next mutation.
    const snap = appBroker.snapshot()
    send(ws, { type: 'app_state', app: 'timer', state: snap.timer })
    send(ws, { type: 'app_state', app: 'notes', state: snap.notes })

    // ── Two-queue model ───────────────────────────────────────────────────────
    // mainQueue   — serializes user prompts (one main-agent turn at a time)
    // dirQueues   — one queue per target; messages to the SAME target are
    //               serialized, but DIFFERENT targets run concurrently.
    //               This lets you type into outdoor-kitchen while rta-blueprint
    //               is still running — no waiting.
    let mainQueue = Promise.resolve()
    const dirQueues = new Map<string, Promise<void>>()
    // Tracks scheduled-or-running main turns so the wake below can tell whether
    // the root agent is actually idle. Bumped at runMain enqueue time (not when
    // the turn starts) so a wake fired between enqueue and start still sees
    // "busy" and bails.
    let mainInFlight = 0

    // ── Auto-wake (single mechanism, two trigger sources) ─────────────────────
    // The root agent only checks the queue / acknowledges child completions at
    // the start of a turn. Two kinds of events can land while the root is idle:
    //   • 'queue'  — a sub-agent pushed a request via mcp__axel_queue__request
    //   • 'child'  — a sub-terminal finished its task (target_done)
    // Either should pull the root in to surface it. wakeReasons accumulates
    // pending kinds; the wake fires once after a short debounce, picking a
    // message tailored to which kinds are pending. Cleared on fire — if the
    // model ignores the wake we don't loop; the next genuine signal re-arms it.
    const wakeReasons = new Set<'queue' | 'child'>()
    let wakeTimer: ReturnType<typeof setTimeout> | null = null
    const noteSignal = (reason: 'queue' | 'child'): void => {
      wakeReasons.add(reason)
      maybeScheduleWake()
    }
    const maybeScheduleWake = (): void => {
      if (mainInFlight > 0 || wakeTimer !== null || wakeReasons.size === 0) return
      // Short debounce so a burst of signals (two terminals finishing at once,
      // a queue add plus a target_done in the same tick) coalesces into one wake.
      // 50ms is the perceptual floor — anything coarser shows up as audible
      // lag between "the child finished" and "the root starts speaking".
      wakeTimer = setTimeout(() => {
        wakeTimer = null
        if (mainInFlight > 0 || wakeReasons.size === 0) return
        const both    = wakeReasons.has('queue') && wakeReasons.has('child')
        const onlyQ   = !both && wakeReasons.has('queue')
        wakeReasons.clear()
        const text = both
          ? 'Background terminals have updates for you. For EACH terminal in your BACKGROUND TERMINALS section that is finished and NEW, surface what it did to the user in plain English — read the entry\'s tail; if it shows "(no output yet)" or garbled fragments, call mcp__axel_terminal_read__read_terminal with that terminal\'s dir (and term id if shown) BEFORE you respond. Do NOT tell the user "no output" until you have tried read_terminal. After surfacing finished work, handle any pending queue items ONE AT A TIME — claim a single item, present, end your turn, wait for the user. Do not delegate, do not open a new terminal.'
          : onlyQ
            ? 'A pending request from a background terminal is waiting. Call mcp__axel_queue__list, then claim EXACTLY ONE item, present it to the user in a sentence or two, and END YOUR TURN. Do NOT claim or read additional items in this same turn — the user has to actually answer the one you present before you can hand them the next. Once they answer, you\'ll call resolve() and the next turn will surface the next item. Do not delegate, do not open a new terminal.'
            : 'One or more background terminals just finished. Look at the BACKGROUND TERMINALS section: for EACH entry tagged FINISHED (NEW), surface what they did to the user in plain English. If an entry\'s tail says "(no output yet)" or looks garbled, you MUST call mcp__axel_terminal_read__read_terminal with that terminal\'s dir (and term id if shown) to fetch the actual text before responding. NEVER tell the user "the terminal sent back no output" without trying read_terminal first. Surface every NEW finish — if two terminals finished, mention both. Do not delegate, do not open a new terminal.'
        runMain(text, undefined, { forceRoot: true, source: 'wake' })
      }, 50)
    }

    // Single fan-out point: every event leaving for the client goes through
    // here so the wake-on-child-done trigger can observe target_done.
    const handleEvent = (event: AgentWireMessage): void => {
      observability.wireEvent(sessionId, event)
      fanOutEvent(ws, event)
      // Wake the root when a child has genuinely finished with output to
      // surface. Candidates: a `reported` message_end (the report tool — the
      // authoritative signal), a plain child message_end (the TUI scrape, which
      // PtyAgent now emits ONLY on true output-silence, never mid-stream), or a
      // target_done. hasFreshChildOutput is the gate: it blocks the premature
      // hard-cap target_done where the child is still streaming and the
      // transcript is empty — the worst original symptom (empty early queries).
      // A child that pauses for sub-workers may ping once with partial output;
      // the root then honestly says "still working", which beats going silent.
      const childTarget = (event as { target?: string }).target
      const childDone = event.type === 'target_done' || (event.type === 'message_end' && (event.reported || !!childTarget))
      if (childDone && orchestrator.hasFreshChildOutput(sessionId)) noteSignal('child')
    }

    // Serialize a user prompt onto the main-agent queue. uiLocation is an
    // optional human description of where the orb sits in the constellation
    // UI, threaded into the root system prompt so the agent can answer "where
    // are you?" from the same view the user is looking at. forceRoot bypasses
    // target-detection routing — used by the synthetic wake whose text would
    // otherwise risk matching a project name.
    const runMain = (userMessage: string, uiLocation?: string, opts?: { forceRoot?: boolean; source?: 'main' | 'plain' | 'wake' }): void => {
      observability.userInput(sessionId, { text: userMessage, source: opts?.source ?? 'main', uiLocation })
      mainInFlight++
      mainQueue = mainQueue.then(async () => {
        try {
          const settings = await settingsManager.getSettings()
          await orchestrator.handleMessage(
            userMessage,
            sessionId,
            event => handleEvent(event as AgentWireMessage),
            url   => send(ws, { type: 'auth_url', url }),
            { projectsDir: settings.projectsRoot, uiLocation, forceRoot: opts?.forceRoot },
          )
          send(ws, { type: 'done' })
        } catch (err) {
          console.error('[agent] handleMessage error:', err)
          const message = err instanceof Error ? err.message : 'agent_error'
          send(ws, { type: 'error', message })
        } finally {
          mainInFlight--
          // Signals may have landed while this turn was running — re-evaluate
          // whenever we transition toward idle.
          maybeScheduleWake()
        }
      })
    }

    const unsubscribeQueue = queueBroker.subscribe(event => {
      if (event.type === 'queue_added') noteSignal('queue')
    })
    ws.on('close', () => {
      unsubscribeQueue()
      if (wakeTimer !== null) { clearTimeout(wakeTimer); wakeTimer = null }
    })

    ws.on('message', raw => {
      const text = raw.toString().trim()
      if (!text) return

      // JSON control messages (dir_input etc.)
      if (text.startsWith('{')) {
        let ctrl: Record<string, unknown> | null = null
        try { ctrl = JSON.parse(text) } catch { /* fall through to plain text */ }

        // Approve/deny answer for a pending permission_request. Resolution is
        // global by request id — whichever client answers first wins.
        if (
          ctrl?.type === 'permission_response' &&
          typeof ctrl.id === 'string' &&
          (ctrl.behavior === 'allow' || ctrl.behavior === 'deny')
        ) {
          observability.controlInput(sessionId, 'permission_response', ctrl)
          permissionBroker.resolve(ctrl.id, ctrl.behavior)
          return
        }

        // Answer to a pending question_request — either a chosen index or an
        // explicit cancel. Same resolve-by-id-globally model as permissions.
        if (ctrl?.type === 'question_response' && typeof ctrl.id === 'string') {
          observability.controlInput(sessionId, 'question_response', ctrl)
          if (ctrl.behavior === 'cancel') {
            askBroker.cancel(ctrl.id)
          } else if (typeof ctrl.index === 'number') {
            askBroker.resolve(ctrl.id, ctrl.index)
          }
          return
        }

        // User-side app action (from a bubble popup). Same dispatch table as
        // the MCP route — both ultimately call AppBroker methods and emit
        // app_state to every client.
        if (ctrl?.type === 'app_action' && typeof ctrl.app === 'string' && typeof ctrl.action === 'string') {
          observability.controlInput(sessionId, 'app_action', ctrl)
          const a = (ctrl.payload ?? {}) as Record<string, unknown>
          if (ctrl.app === 'timer') {
            if (ctrl.action === 'start')   appBroker.startTimer(Number(a.minutes))
            else if (ctrl.action === 'pause')  appBroker.pauseTimer()
            else if (ctrl.action === 'resume') appBroker.resumeTimer()
            else if (ctrl.action === 'cancel') appBroker.cancelTimer()
          } else if (ctrl.app === 'notes') {
            if (ctrl.action === 'write')  appBroker.writeNotes(String(a.content ?? ''))
            else if (ctrl.action === 'append') appBroker.appendNotes(String(a.text ?? ''))
            else if (ctrl.action === 'clear')  appBroker.clearNotes()
          }
          return
        }

        // Client UI-state snapshot — recorded only, never forwarded. Lets the
        // axel-observe MCP server diff what the UI rendered against what the
        // backend actually produced.
        if (ctrl?.type === 'ui_snapshot' && ctrl.snapshot && typeof ctrl.snapshot === 'object') {
          observability.uiSnapshot(sessionId, ctrl.snapshot as UiSnapshot)
          return
        }

        if (
          ctrl?.type === 'dir_input' &&
          typeof ctrl.target === 'string' &&
          typeof ctrl.text === 'string'
        ) {
          const target  = ctrl.target as string
          const dirText = ctrl.text   as string
          // Which terminal of the target dir this input belongs to — each
          // terminal is an independent claude conversation (tab in the UI).
          const term    = typeof ctrl.term === 'string' && ctrl.term ? ctrl.term : 'main'
          observability.userInput(sessionId, { text: dirText, source: 'dir', target, term })

          // Enqueue on the per-terminal queue (independent from mainQueue,
          // from other targets, and from the same dir's other terminals).
          const queueKey = `${target} ${term}`
          const prev = dirQueues.get(queueKey) ?? Promise.resolve()
          const next = prev.then(async () => {
            try {
              const settings = await settingsManager.getSettings()
              // Same fallback as the fs routes — the constellation is built from
              // allowedDirs[0] when no projectsRoot is saved, so dir targets must
              // resolve against the identical root or every dir_input dead-ends.
              const root = settings.projectsRoot ?? config.allowedDirs[0]
              if (!root) {
                send(ws, { type: 'error', message: 'no_projects_root', target, term } as AgentWireMessage)
                send(ws, { type: 'done' })
                return
              }
              // target may be a root-relative path ("axel/apps/web") for nested
              // rings — resolve it and refuse anything escaping the root.
              const rootAbs   = path.resolve(root)
              const targetDir = path.resolve(rootAbs, target)
              if (!isPathUnder(targetDir, [rootAbs])) {
                send(ws, { type: 'error', message: 'target_outside_root', target, term } as AgentWireMessage)
                send(ws, { type: 'done' })
                return
              }
              send(ws, { type: 'target_start', target, term })
              await orchestrator.handleDirMessage(
                dirText, sessionId, target, targetDir,
                event => handleEvent(event as AgentWireMessage),
                url   => send(ws, { type: 'auth_url', url }),
                term,
              )
              handleEvent({ type: 'target_done', target, term } as AgentWireMessage)
              send(ws, { type: 'done' })
            } catch (err) {
              const message = err instanceof Error ? err.message : 'agent_error'
              send(ws, { type: 'error', message, target, term } as AgentWireMessage)
              send(ws, { type: 'done' })
            }
          })
          dirQueues.set(queueKey, next)
          return
        }

        // Main user prompt with optional UI context. Carries the orb's
        // on-screen location alongside the text so the root agent knows where
        // it is. text-only plain messages still work via the fallback below.
        if (ctrl?.type === 'main_input' && typeof ctrl.text === 'string') {
          const userMessage = (ctrl.text as string).trim()
          if (userMessage) {
            const uiLocation = typeof ctrl.location === 'string' && ctrl.location ? ctrl.location : undefined
            runMain(userMessage, uiLocation)
          }
          return
        }

        if (ctrl !== null) return  // unknown JSON — ignore
      }

      // Plain-text user prompt → main orchestrator (serialized)
      runMain(text, undefined, { source: 'plain' })
    })
  })

  return wss
}

export function handleAgentUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
): void {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
}
