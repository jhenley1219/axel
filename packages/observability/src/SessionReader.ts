import fs from 'fs'
import path from 'path'
import { sanitizeSessionId } from './ids.js'
import type { ObsRecord, SessionMeta, UiSnapshot } from './types.js'

export type FeedFilter = { kinds?: Array<string>; limit?: number; sinceSeq?: number }

// Read side of the recorder. A separate process (the stdio MCP server) uses
// this to inspect feeds written by the running app — JSONL append + read is
// safe across processes.
export class SessionReader {
  constructor(private rootDir: string) {}

  private sessionsDir(): string {
    return path.join(this.rootDir, 'sessions')
  }

  listSessions(): Array<SessionMeta> {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(this.sessionsDir(), { withFileTypes: true })
    } catch {
      return []
    }
    const metas: Array<SessionMeta> = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        metas.push(JSON.parse(fs.readFileSync(path.join(this.sessionsDir(), e.name, 'meta.json'), 'utf-8')) as SessionMeta)
      } catch {
        metas.push({ sessionId: e.name, createdAt: '', updatedAt: '', recordCount: 0, lastSeq: 0 })
      }
    }
    metas.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return metas
  }

  latestSessionId(): string | null {
    const list = this.listSessions()
    return list.length > 0 ? list[0].sessionId : null
  }

  readFeed(sessionId: string, filter: FeedFilter = {}): Array<ObsRecord> {
    const file = path.join(this.sessionsDir(), sanitizeSessionId(sessionId), 'events.jsonl')
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      return []
    }
    const out: Array<ObsRecord> = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let rec: ObsRecord
      try {
        rec = JSON.parse(line) as ObsRecord
      } catch {
        continue
      }
      if (filter.sinceSeq !== undefined && rec.seq <= filter.sinceSeq) continue
      if (filter.kinds && !filter.kinds.includes(rec.kind)) continue
      out.push(rec)
    }
    if (filter.limit !== undefined && out.length > filter.limit) {
      return out.slice(out.length - filter.limit)
    }
    return out
  }

  latestUiSnapshot(sessionId: string): UiSnapshot | null {
    const recs = this.readFeed(sessionId, { kinds: ['ui_snapshot'] })
    const last = recs[recs.length - 1]
    return last && last.kind === 'ui_snapshot' ? last.snapshot : null
  }
}
