import { randomUUID } from 'crypto'
import type { AgentEvent } from './ClaudeCodeAgent.js'

// Bridges sub-agent requests that must route through the root agent on their
// way to the user. A child spawn calls `mcp__axel_queue__request` (which lands
// here as `push`), blocks on the returned promise, and unblocks when the root
// agent calls `resolve` — after presenting the item to the user and reading
// their answer. Subscribers receive every queue event so the WS layer can
// broadcast them — feeding the constellation badge and driving the orb to the
// sender dir on claim.
//
// Mirrors PermissionBroker's MCP-timeout posture: auto-deny just under the
// CLI transport ceiling so the spawn fails soft rather than hard.

export type QueueRequestKind = 'proposal' | 'question' | 'confirmation'

export type QueueRequestArgs = {
  kind: QueueRequestKind
  prompt: string
  options?: Array<string>
}

export type QueueResolution = { accepted: boolean; answer?: string }

export type QueueItem = QueueRequestArgs & {
  id: string
  fromTarget: string
  fromTerm?: string
  createdAt: number
  status: 'pending' | 'claimed' | 'resolved'
}

export type QueueSpawnRole =
  | { role: 'root' }
  | { role: 'child'; target: string; term?: string }

type Listener = (event: AgentEvent) => void

const AUTO_DENY_MS = 570_000

type Pending = {
  item: QueueItem
  resolve: (res: QueueResolution) => void
  timer: ReturnType<typeof setTimeout>
}

export class RequestQueue {
  private pending = new Map<string, Pending>()
  private spawns = new Map<string, QueueSpawnRole>()
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  register(spawnId: string, info: QueueSpawnRole): void {
    this.spawns.set(spawnId, info)
  }

  // Drops the spawn and cancels anything it had in-flight. A child spawn's
  // pending requests can never be answered after it exits, so auto-deny them.
  unregister(spawnId: string): void {
    const info = this.spawns.get(spawnId)
    this.spawns.delete(spawnId)
    if (info?.role === 'child') {
      for (const [id, p] of this.pending) {
        if (p.item.fromTarget === info.target && p.item.fromTerm === info.term) {
          this.settle(id, { accepted: false })
        }
      }
    }
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  roleOf(spawnId: string): QueueSpawnRole | undefined {
    return this.spawns.get(spawnId)
  }

  // Child-side entry point. The route looks up the spawn's target/term from
  // the broker rather than trusting child-supplied values.
  push(spawnId: string, args: QueueRequestArgs): Promise<QueueResolution> {
    const info = this.spawns.get(spawnId)
    if (!info || info.role !== 'child') {
      return Promise.resolve({ accepted: false, answer: 'Unknown or non-child session.' })
    }
    const id = randomUUID()
    const item: QueueItem = {
      ...args,
      id,
      fromTarget: info.target,
      fromTerm: info.term,
      createdAt: Date.now(),
      status: 'pending',
    }
    return new Promise<QueueResolution>(resolve => {
      const timer = setTimeout(() => this.settle(id, { accepted: false }), AUTO_DENY_MS)
      this.pending.set(id, { item, resolve, timer })
      this.emit({
        type: 'queue_added',
        id,
        fromTarget: item.fromTarget,
        fromTerm: item.fromTerm,
        kind: item.kind,
        prompt: item.prompt,
        options: item.options,
      })
    })
  }

  list(): Array<QueueItem> {
    return [...this.pending.values()]
      .map(p => p.item)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  claim(id: string): QueueItem | undefined {
    const pending = this.pending.get(id)
    if (!pending || pending.item.status !== 'pending') return undefined
    pending.item.status = 'claimed'
    this.emit({
      type: 'queue_claimed',
      id,
      fromTarget: pending.item.fromTarget,
      fromTerm: pending.item.fromTerm,
    })
    return pending.item
  }

  resolve(id: string, resolution: QueueResolution): void {
    this.settle(id, resolution)
  }

  private settle(id: string, resolution: QueueResolution): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.item.status = 'resolved'
    this.emit({
      type: 'queue_resolved',
      id,
      fromTarget: pending.item.fromTarget,
      fromTerm: pending.item.fromTerm,
      accepted: resolution.accepted,
      answer: resolution.answer,
    })
    pending.resolve(resolution)
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try { l(event) } catch { /* one bad listener can't break the rest */ }
    }
  }
}
