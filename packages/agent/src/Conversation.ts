export type ToolCall = { id: string; name: string; input: unknown }

export type ConvMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: Array<ToolCall> }
  | { role: 'tool'; toolCallId: string; content: string }

export class Conversation {
  messages: Array<ConvMessage> = []

  addUser(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }

  addAssistant(text: string, toolCalls?: Array<ToolCall>): void {
    const msg: ConvMessage = toolCalls && toolCalls.length > 0
      ? { role: 'assistant', content: text, toolCalls }
      : { role: 'assistant', content: text }
    this.messages.push(msg)
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', toolCallId, content })
  }

  toMessages(): Array<ConvMessage> {
    return this.messages
  }
}

const DEFAULT_TTL_MS = 60 * 60 * 1000

type Entry = { conv: Conversation; lastTouched: number }

export class SessionStore {
  private entries = new Map<string, Entry>()

  constructor(
    private clock: () => number = () => performance.now(),
    private ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  get(axelSessionId: string): Conversation {
    this.sweep()
    const now = this.clock()
    const existing = this.entries.get(axelSessionId)
    if (existing) {
      existing.lastTouched = now
      return existing.conv
    }
    const conv = new Conversation()
    this.entries.set(axelSessionId, { conv, lastTouched: now })
    return conv
  }

  private sweep(): void {
    const now = this.clock()
    for (const [id, entry] of this.entries) {
      if (now - entry.lastTouched > this.ttlMs) this.entries.delete(id)
    }
  }
}
