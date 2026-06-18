import { randomUUID } from 'crypto'
import type { AgentEvent } from './ClaudeCodeAgent.js'
import { applyTierPolicy } from './permissionPolicy.js'
import type { Tier } from './promptTiers.js'

// Decision contract for claude's --permission-prompt-tool, verified against
// CLI 2.1.153: the prompt tool must return this object JSON-stringified as
// text content. Allow MUST echo the tool input back as updatedInput.
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string }

// What the in-process subscriber receives — enough to render a prompt and
// route a `permission_response` back through `resolve(id, behavior)`.
export type InProcessPermissionRequest = {
  id: string
  toolName: string
  input: unknown
  sessionId: string
  axelSessionId?: string
}

type McpPending = {
  kind: 'mcp'
  spawnId: string
  input: unknown
  resolve: (decision: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout>
}

type InProcessPending = {
  kind: 'in-process'
  resolve: (behavior: 'allow' | 'deny') => void
  timer: ReturnType<typeof setTimeout>
}

type PendingRequest = McpPending | InProcessPending

// If the user never answers, deny before the CLI's own MCP tool-call timeout
// (the injected server entry uses 600s) so the spawn fails soft, not hard.
const AUTO_DENY_MS = 570_000

// In-process callers (AxelAgent) don't share the MCP transport's 600s ceiling,
// so the default here is the spec'd 60s — short enough to keep a tool loop
// responsive when the user walks away.
const IN_PROCESS_AUTO_DENY_MS = 60_000

// Bridges permission prompts between a spawned claude process (via the MCP
// endpoint in apps/server) and the web client (via the agent WebSocket).
// One spawn registers its onEvent under an unguessable spawnId; each prompt
// becomes a pending promise resolved by the client's permission_response.
export class PermissionBroker {
  private spawns = new Map<string, (event: AgentEvent) => void>()
  private pending = new Map<string, PendingRequest>()
  private subscribers = new Set<(req: InProcessPermissionRequest) => void>()

  register(spawnId: string, onEvent: (event: AgentEvent) => void): void {
    this.spawns.set(spawnId, onEvent)
  }

  // Drops the spawn and denies anything still waiting — the process is gone,
  // so an answer could never be delivered.
  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
    for (const [id, req] of this.pending) {
      if (req.kind === 'mcp' && req.spawnId === spawnId) {
        this.settleMcp(id, { behavior: 'deny', message: 'Session ended before the user responded.' })
      }
    }
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  request(spawnId: string, toolName: string, input: unknown): Promise<PermissionDecision> {
    const onEvent = this.spawns.get(spawnId)
    if (!onEvent) {
      return Promise.resolve({ behavior: 'deny', message: 'Unknown session.' })
    }
    const id = randomUUID()
    return new Promise<PermissionDecision>(resolve => {
      const timer = setTimeout(
        () => this.settleMcp(id, { behavior: 'deny', message: 'No response from the user — denied after timeout.' }),
        AUTO_DENY_MS,
      )
      this.pending.set(id, { kind: 'mcp', spawnId, input, resolve, timer })
      onEvent({ type: 'permission_request', id, toolName, input })
    })
  }

  // Subscribe to in-process prompts. External code (server WS handler) bridges
  // these to the wire as `permission_request` events and routes the client's
  // `permission_response` back through `resolve(id, behavior)`. Returns an
  // unsubscribe fn.
  onRequest(cb: (req: InProcessPermissionRequest) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  // In-process variant for AxelAgent's native tool dispatch. No MCP transport,
  // no spawnId — the caller already has a session and just needs allow/deny.
  // When a tier is supplied, the tier policy gates the prompt: 'allow'/'deny'
  // short-circuit without ever notifying subscribers; 'ask' falls through to
  // the normal prompt flow.
  requestApproval(args: {
    toolName: string
    input: unknown
    sessionId: string
    axelSessionId?: string
    tier?: Tier
  }): Promise<'allow' | 'deny'> {
    if (args.tier) {
      const policy = applyTierPolicy(args.tier, args.toolName, args.input)
      if (policy === 'allow') return Promise.resolve('allow')
      if (policy === 'deny')  return Promise.resolve('deny')
    }
    const id = randomUUID()
    return new Promise<'allow' | 'deny'>(resolve => {
      const timer = setTimeout(() => this.settleInProcess(id, 'deny'), IN_PROCESS_AUTO_DENY_MS)
      this.pending.set(id, { kind: 'in-process', resolve, timer })
      const req: InProcessPermissionRequest = {
        id,
        toolName: args.toolName,
        input: args.input,
        sessionId: args.sessionId,
        axelSessionId: args.axelSessionId,
      }
      for (const cb of this.subscribers) cb(req)
    })
  }

  resolve(id: string, behavior: 'allow' | 'deny'): void {
    const req = this.pending.get(id)
    if (!req) return
    if (req.kind === 'mcp') {
      if (behavior === 'allow') {
        // The contract requires echoing the tool input back on allow.
        this.settleMcp(id, { behavior: 'allow', updatedInput: req.input })
      } else {
        this.settleMcp(id, { behavior: 'deny', message: 'The user denied this action.' })
      }
    } else {
      this.settleInProcess(id, behavior)
    }
  }

  private settleMcp(id: string, decision: PermissionDecision): void {
    const req = this.pending.get(id)
    if (!req || req.kind !== 'mcp') return
    this.pending.delete(id)
    clearTimeout(req.timer)
    this.spawns.get(req.spawnId)?.({ type: 'permission_resolved', id })
    req.resolve(decision)
  }

  private settleInProcess(id: string, behavior: 'allow' | 'deny'): void {
    const req = this.pending.get(id)
    if (!req || req.kind !== 'in-process') return
    this.pending.delete(id)
    clearTimeout(req.timer)
    req.resolve(behavior)
  }
}
