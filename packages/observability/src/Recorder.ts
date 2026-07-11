import fs from 'fs'
import path from 'path'
import type { AgentWireMessage, InstalledToolView } from '@axel/agent'
import { sanitizeSessionId } from './ids.js'
import type { ObsRecord, ObsRecordInput, ParsedToolCall, SessionMeta, UiSnapshot, UserInputSource } from './types.js'

const META_DEBOUNCE_MS = 500

type SessionState = {
  stream: fs.WriteStream
  dir: string
  seq: number
  meta: SessionMeta
  metaTimer: ReturnType<typeof setTimeout> | null
}

// Append-only per-session recorder. Modeled on @axel/core's AuditLogger: one
// WriteStream per session in append mode, a `healthy`/per-session guard, and
// fire-and-forget writes that never throw into the caller's request path. A
// debounced meta.json keeps `list_sessions` cheap without an fsync per record.
export class ObservabilityRecorder {
  private sessions = new Map<string, SessionState>()

  constructor(private rootDir: string, private enabled: boolean = true) {}

  private ensure(sessionId: string): SessionState | null {
    if (!this.enabled) return null
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    try {
      const dir = path.join(this.rootDir, 'sessions', sanitizeSessionId(sessionId))
      fs.mkdirSync(dir, { recursive: true })
      const metaPath = path.join(dir, 'meta.json')
      let meta: SessionMeta
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
      } catch {
        meta = { sessionId, createdAt: new Date().toISOString(), updatedAt: '', recordCount: 0, lastSeq: 0 }
      }
      const stream = fs.createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' })
      stream.on('error', err => {
        console.error('[observability] write error — recording disabled for', sessionId, err.message)
        this.sessions.delete(sessionId)
      })
      const state: SessionState = { stream, dir, seq: meta.lastSeq, meta, metaTimer: null }
      this.sessions.set(sessionId, state)
      return state
    } catch (err) {
      console.error('[observability] failed to open session', sessionId, (err as Error).message)
      return null
    }
  }

  private write(sessionId: string, input: ObsRecordInput): void {
    const st = this.ensure(sessionId)
    if (!st) return
    st.seq += 1
    const rec = { seq: st.seq, ts: new Date().toISOString(), sessionId, ...input } as ObsRecord
    try {
      st.stream.write(JSON.stringify(rec) + '\n')
    } catch (err) {
      console.error('[observability] record dropped for', sessionId, (err as Error).message)
      return
    }
    st.meta.recordCount += 1
    st.meta.lastSeq = st.seq
    st.meta.updatedAt = rec.ts
    if (rec.kind === 'user_input') st.meta.lastUserInput = rec.text.slice(0, 200)
    if (rec.kind === 'ui_snapshot') st.meta.lastUiSnapshotAt = rec.ts
    this.scheduleMeta(st)
  }

  private scheduleMeta(st: SessionState): void {
    if (st.metaTimer !== null) return
    st.metaTimer = setTimeout(() => {
      st.metaTimer = null
      this.flushMeta(st)
    }, META_DEBOUNCE_MS)
    st.metaTimer.unref?.()
  }

  private flushMeta(st: SessionState): void {
    try {
      fs.writeFileSync(path.join(st.dir, 'meta.json'), JSON.stringify(st.meta, null, 2))
    } catch (err) {
      console.error('[observability] meta write failed for', st.meta.sessionId, (err as Error).message)
    }
  }

  sessionStart(sessionId: string, opts: { auth: boolean; tools: Array<InstalledToolView> }): void {
    this.write(sessionId, { kind: 'session_start', auth: opts.auth, tools: opts.tools })
  }

  userInput(sessionId: string, opts: { text: string; source: UserInputSource; uiLocation?: string; target?: string; term?: string }): void {
    this.write(sessionId, { kind: 'user_input', ...opts })
  }

  controlInput(sessionId: string, controlType: string, payload: unknown): void {
    this.write(sessionId, { kind: 'control_input', controlType, payload })
  }

  wireEvent(sessionId: string, event: AgentWireMessage): void {
    const target = (event as { target?: string }).target
    const term = (event as { term?: string }).term
    this.write(sessionId, { kind: 'wire_event', event, ...(target ? { target } : {}), ...(term ? { term } : {}) })
  }

  turn(sessionId: string, rec: { iteration: number; rawModelOutput: string; parsedToolCalls: Array<ParsedToolCall>; model: string; provider: string; tier: string; target?: string; term?: string }): void {
    this.write(sessionId, { kind: 'turn', ...rec })
  }

  uiSnapshot(sessionId: string, snapshot: UiSnapshot): void {
    this.write(sessionId, { kind: 'ui_snapshot', snapshot })
  }

  sessionReset(sessionId: string): void {
    this.write(sessionId, { kind: 'session_reset' })
  }

  // Test/shutdown helper: synchronously persist meta and wait for queued line
  // writes to drain so a reader in the same process sees a complete feed.
  async flush(): Promise<void> {
    const drains: Array<Promise<void>> = []
    for (const st of this.sessions.values()) {
      if (st.metaTimer !== null) {
        clearTimeout(st.metaTimer)
        st.metaTimer = null
      }
      this.flushMeta(st)
      drains.push(new Promise<void>(resolve => st.stream.write('', () => resolve())))
    }
    await Promise.all(drains)
  }
}
