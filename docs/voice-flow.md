# Voice Conversational Pipeline

How a spoken request flows from the user's microphone to the agent and back,
and how the various queues, refs, and gates fit together. Read this before
touching `useVoiceInterface`, the TTS engine, or the agent WS handler — the
pipeline has several invariants that aren't obvious from any one file.

## High-level shape

```
                ┌────────────────────────────────────────────────────────┐
                │                       BROWSER                           │
                │                                                         │
  🎤 mic ─────► useSpeechRecognition ──► sr callback ──┐                  │
                                                       │                  │
                       ┌─────────────── voiceAsks.route ◄┘                │
                       │                   │                              │
                       │                   ▼  'handled'                   │
                       │           (permission yes/no,                    │
                       │            transcript pick,                      │
                       │            transcript length)                    │
                       │                   │                              │
                       ▼  'pass'           │                              │
                sendTranscript             │                              │
                       │                   ▼                              │
                       │            speak via TTS                         │
                       │                   │                              │
                       ▼                   │                              │
                    ws.send (main_input or dir_input)  ◄──────┐           │
                                  │        │                  │           │
                                  └────────┼──────────────────┼───────────┤
                                           │                  │           │
                                  WS ─────►│                  │           │
                                           ▼                  │           │
                                  ┌──────────────────┐        │           │
                                  │ apps/server      │        │           │
                                  │  routes/agent.ts │        │           │
                                  │                  │        │           │
                                  │  mainQueue       │        │           │
                                  │  dirQueues       │        │           │
                                  │       │          │        │           │
                                  │       ▼          │        │           │
                                  │  Orchestrator    │        │           │
                                  │   childQueues    │        │           │
                                  │       │          │        │           │
                                  │       ▼          │        │           │
                                  │  ClaudeCodeAgent │        │           │
                                  │   ↑ MCP permission        │           │
                                  │   ↕ broker (fan-out)      │           │
                                  └──────────────────┘        │           │
                                           │                  │           │
                                           ▼ events (WS)      │           │
                              ws.onmessage dispatcher         │           │
                                           │                  │           │
            ┌──────────────────────────────┼──────────────────┘           │
            │                              │                              │
            │ token,                       │ permission_request,           │
            │ message_end,                 │ permission_resolved           │
            │ target_*,                    │                               │
            │ done, error,                 │                               │
            │ fan_out, etc.                │                               │
            │                              │                               │
            ▼                              ▼                               │
       TTS engine                  voiceAsks.ask / .cancel                 │
       queueRef (audio)            pendingRef (one ask)                    │
       messageBufRef               │                                       │
       streamDoneRef               │                                       │
            │                      │                                       │
            ▼                      ▼                                       │
       onAllDone ◄── hasPendingAskRef ──► (re-arm mic regardless           │
            │                              of streamEndedRef)               │
            ▼                                                               │
       startListening ─── orb 'listening' ─── 🎤 next utterance ─────────────┘
```

## Queues — who owns what

| Queue / State | Owner | Location | Purpose |
|---|---|---|---|
| `mainQueue` | server | `apps/server/src/routes/agent.ts` (`mainQueue`) | Serializes root-agent turns per WS — one prompt at a time. |
| `dirQueues` | server | `apps/server/src/routes/agent.ts` (`dirQueues`) | Per-target-per-term queue; different dirs/terms run concurrently. |
| `childQueues` | agent | `packages/agent/src/AgentOrchestrator.ts` (`childQueues`) | Serializes same-child runs across detached delegations. |
| `tts.queueRef` | TTS | `useTtsEngine.ts:147` | Audio-buffer FIFO; `drain()` plays in order. |
| `tts.messageBufRef` | TTS | `useTtsEngine.ts:146` | Token accumulator between `message_end`s. |
| `tts.streamDoneRef` | TTS | `useTtsEngine.ts:149` | Gates `onAllDone` firing — true after `endStream()` until next `pushToken`. |
| `pendingAnnounceRef` | voice | `useVoiceInterface.ts` | Background completion lines waiting for idle floor. |
| `unreadTranscriptsRef` | voice | `useVoiceInterface.ts` | Child transcripts not yet read aloud; drained by a QueueMenu click (`readTranscript`). |
| `voiceAsks.pendingRef` | voice | `useVoiceAsks.ts` | One-at-a-time voice question awaiting an answer. |
| `busyRef` | voice | `useVoiceInterface.ts` | Turn in flight (set on send, cleared on `done`/`error`). |
| `streamEndedRef` | voice | `useVoiceInterface.ts` | Gates normal mic re-arm — true once `done` arrives. |

## The pending-ask abstraction

Three different "voice asks" exist today; they all share the same lifecycle:

1. **Permission allow/deny** — fired by `permission_request` from the server.
2. **Transcript pick** — fired from a QueueMenu click when there's more than
   one unread transcript to disambiguate.
3. **Transcript length (full vs summary)** — fired when the chosen transcript
   is past `TRANSCRIPT_READ_THRESHOLD` chars.

They're all instances of `VoiceAsk` (`useVoiceAsks.ts`):

```ts
type VoiceAsk = {
  id: string                                       // for external cancel
  question: string                                 // spoken via TTS
  reprompt?: string                                // spoken on unclear
  parse(utterance): 'answered' | 'unclear' | 'cancelled'
}
```

`useVoiceAsks` enforces:
- **One at a time** — `ask()` returns false if one is already pending.
- **TTS queueing, not interruption** — questions go BEHIND in-flight audio
  (`flushMessage` + push + flush + `endStream`).
- **Mic re-arm regardless of agent state** — `hasPending()` is read inside
  `useTtsEngine`'s `onAllDone` so the user can answer even while the agent
  is paused mid-turn.
- **External cancel** — `cancel(id)` clears the ask when something other
  than the user resolves it (e.g. inline-click on a `PermissionPrompt`
  card → server echoes `permission_resolved` → `cancel(msg.id)`).

## The one intercept point

There is exactly one place an utterance diverges from the "send to agent"
path:

### `voiceAsks.route(utterance)` (recognition callback)

Lives inside the `useSpeechRecognition` callback in `useVoiceInterface`. If
an ask is pending, the next utterance is routed through `parse()`. Unclear
answers re-prompt and stay listening; cancelled clears silently; answered
runs the ask's `action` (which may itself fire another ask, e.g. transcript
pick → transcript length). When no ask is pending, the utterance goes
straight to `sendTranscript`, which does NO client-side intent matching —
every prompt is shipped to the root agent as-is.

### Verbatim transcript playback (UI-driven, not phrase-driven)

There is no spoken "read the transcript" intent. (An earlier
`detectReadTranscriptIntent` matcher was removed.) Verbatim playback of a
background terminal's output survives only as a click in the QueueMenu: each
unread entry is a row that calls `readTranscript` → `readOneTranscript`:

- Length ≤ `TRANSCRIPT_READ_THRESHOLD` → speak full, drop from unread.
- Length > threshold → transcript-length `VoiceAsk` (full vs summary).

When the user instead *asks about* a background terminal by voice, that
utterance goes to the root agent like any other prompt. The server feeds the
root a `BACKGROUND TERMINALS` prompt section (`AgentOrchestrator`'s
child-status digest) describing what each sub-agent said, and the agent
decides whether and how to relay it — there is no client-side matcher.

## Server-side fan-out invariants

Three of the four most consequential invariants live in the server:

1. **`permission_request` / `permission_resolved` BROADCAST**, not unicast
   (`apps/server/src/routes/agent.ts` — `fanOutEvent`). The originating WS
   may have died (reload, navigation); the prompt must still surface.
2. **Other events stay unicast** to the originating WS — tokens belong to
   the asker.
3. **Spawn outlives WS** — closing a WS does NOT cancel the child claude
   process; this is intentional (detached children).
4. **PermissionBroker auto-denies at 570s** — keeps the spawn from hanging
   forever if no one answers. The MCP entry timeout is 600s so the deny
   wins.

## Adding a new voice-ask flow

To add a fourth kind of pending question:

1. **Define a `VoiceAsk`** somewhere it has access to the state it needs.
   The `parse()` function returns `'answered' | 'unclear' | 'cancelled'`.
2. **Call `voiceAsks.ask({...})`** when the question arises.
3. If the ask can be settled externally (server event, inline UI click),
   call `voiceAsks.cancel(id)` from the relevant handler.

That's it — the recognition gate, TTS queueing, and mic re-arm are already
wired for you.

## A note on local intents

`useVoiceInterface` deliberately has NO client-side spoken-intent matching:
every utterance that isn't consumed by a pending `voiceAsks` goes to the
root agent verbatim. Background-terminal questions are handled by the agent
itself (it sees the `BACKGROUND TERMINALS` prompt section), not by a client
matcher. Verbatim transcript playback is reachable only as a QueueMenu click
(`readTranscript`), not a spoken phrase.

If you ever need a local-only action, prefer wiring it as UI affordance plus,
where a spoken answer is required, a `VoiceAsk` (above) — don't reintroduce
phrase-detection inside `sendTranscript` or the recognition callback.
