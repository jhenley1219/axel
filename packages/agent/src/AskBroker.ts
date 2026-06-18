import { randomUUID } from 'crypto'
import type { AgentEvent } from './ClaudeCodeAgent.js'

// Multiple-choice question raised by a spawned claude session and answered by
// the user (voice or in-terminal click). Mirrors PermissionBroker structurally:
// per-spawn registration under an unguessable spawnId, request returns a
// pending promise the client settles via a question_response control message.
//
// Answer shape — what the MCP tool stringifies back to claude. `cancelled`
// covers timeout, user-said-cancel, and spawn-exited-before-answer paths so the
// agent gets a single well-typed failure mode rather than three.
export type AskAnswer =
  | { kind: 'chose'; index: number; option: string }
  | { kind: 'cancelled'; message: string }

type Pending = {
  spawnId: string
  options: Array<string>
  resolve: (a: AskAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

// Same window as PermissionBroker — long enough that a user grabbing coffee
// doesn't lose their answer to a timeout, short enough to bound a stalled
// spawn. Stays under the CLI's own MCP tool-call timeout (600s).
const AUTO_TIMEOUT_MS = 570_000

export class AskBroker {
  private spawns = new Map<string, (event: AgentEvent) => void>()
  private pending = new Map<string, Pending>()

  register(spawnId: string, onEvent: (event: AgentEvent) => void): void {
    this.spawns.set(spawnId, onEvent)
  }

  unregister(spawnId: string): void {
    this.spawns.delete(spawnId)
    for (const [id, req] of this.pending) {
      if (req.spawnId === spawnId) {
        this.settle(id, { kind: 'cancelled', message: 'Session ended before the user responded.' })
      }
    }
  }

  has(spawnId: string): boolean {
    return this.spawns.has(spawnId)
  }

  request(
    spawnId: string,
    question: string,
    options: Array<string>,
    target?: string,
    term?: string,
  ): Promise<AskAnswer> {
    const onEvent = this.spawns.get(spawnId)
    if (!onEvent) return Promise.resolve({ kind: 'cancelled', message: 'Unknown session.' })
    if (options.length < 2) {
      return Promise.resolve({ kind: 'cancelled', message: 'Need at least two options to ask a question.' })
    }
    const id = randomUUID()
    return new Promise<AskAnswer>(resolve => {
      const timer = setTimeout(
        () => this.settle(id, { kind: 'cancelled', message: 'No response from the user — cancelled after timeout.' }),
        AUTO_TIMEOUT_MS,
      )
      this.pending.set(id, { spawnId, options, resolve, timer })
      onEvent({ type: 'question_request', id, question, options, target, term })
    })
  }

  // Caller passes the chosen option's index; bad indices are treated as a
  // cancel rather than silently coerced — better to fail loud than approve
  // a different answer than the user picked.
  resolve(id: string, index: number): void {
    const req = this.pending.get(id)
    if (!req) return
    if (!Number.isInteger(index) || index < 0 || index >= req.options.length) {
      this.settle(id, { kind: 'cancelled', message: 'Invalid choice index.' })
      return
    }
    this.settle(id, { kind: 'chose', index, option: req.options[index] })
  }

  cancel(id: string): void {
    this.settle(id, { kind: 'cancelled', message: 'The user cancelled this question.' })
  }

  private settle(id: string, ans: AskAnswer): void {
    const req = this.pending.get(id)
    if (!req) return
    this.pending.delete(id)
    clearTimeout(req.timer)
    this.spawns.get(req.spawnId)?.({ type: 'question_resolved', id })
    req.resolve(ans)
  }
}
