import { randomUUID } from 'node:crypto'
import type { ConvMessage } from '../Conversation.js'
import type { ModelProvider, ProviderOpts, StreamEvent, StreamRequest, ToolSpec } from './Provider.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'

// Ollama tool_calls (v0.4+) deliver `arguments` as an object, not a JSON
// string. Models may also omit `id` — we mint one so downstream tool-result
// plumbing has something to correlate.
type OllamaToolCall = {
  id?: string
  function?: { name?: string; arguments?: unknown }
}

type OllamaChatLine = {
  message?: { role: string; content?: string; tool_calls?: Array<OllamaToolCall> }
  done: boolean
}

type OllamaTool = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

type OllamaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<OllamaToolCall> }
  | { role: 'tool'; content: string; tool_call_id?: string }

export type PullEvent =
  | { type: 'progress'; status: string; digest?: string; total?: number; completed?: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

const toOllamaTools = (tools: Array<ToolSpec> | undefined): Array<OllamaTool> | undefined => {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t): OllamaTool => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

const toOllamaMessages = (
  messages: Array<ConvMessage>,
  systemPrompt: string | undefined,
): Array<OllamaMessage> => {
  const out: Array<OllamaMessage> = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })
  for (const msg of messages) {
    if (msg.role === 'system') { out.push({ role: 'system', content: msg.content }); continue }
    if (msg.role === 'user')   { out.push({ role: 'user', content: msg.content }); continue }
    if (msg.role === 'assistant') {
      if (!msg.toolCalls || msg.toolCalls.length === 0) {
        out.push({ role: 'assistant', content: msg.content })
        continue
      }
      const tool_calls: Array<OllamaToolCall> = msg.toolCalls.map(tc => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.input },
      }))
      out.push({ role: 'assistant', content: msg.content, tool_calls })
      continue
    }
    out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId })
  }
  return out
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama' as const
  private baseURL: string

  constructor({ baseURL }: ProviderOpts) {
    this.baseURL = baseURL ?? DEFAULT_BASE_URL
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    try {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOllamaMessages(req.messages, req.systemPrompt),
        stream: true,
      }
      const tools = toOllamaTools(req.tools)
      if (tools) body.tools = tools
      const res = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        yield { type: 'error', message: `ollama http ${res.status}: ${await res.text().catch(() => '')}` }
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as OllamaChatLine
          if (parsed.message?.content) yield { type: 'token', value: parsed.message.content }
          if (parsed.message?.tool_calls) {
            for (const tc of parsed.message.tool_calls) {
              const name = tc.function?.name
              if (!name) continue
              yield { type: 'tool_call', id: tc.id ?? randomUUID(), name, input: tc.function?.arguments ?? {} }
            }
          }
          if (parsed.done) {
            yield { type: 'end' }
            return
          }
        }
      }
      yield { type: 'end' }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async probe(): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(`${this.baseURL}/api/tags`, { signal: controller.signal })
      return res.ok ? null : `ollama http ${res.status}`
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timer)
    }
  }

  async *pullModel(name: string, signal?: AbortSignal): AsyncGenerator<PullEvent> {
    let res: Response
    try {
      res = await fetch(`${this.baseURL}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
        signal,
      })
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }
    if (!res.ok || !res.body) {
      yield { type: 'error', message: `ollama http ${res.status}: ${await res.text().catch(() => '')}` }
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as { status?: string; digest?: string; total?: number; completed?: number; error?: string }
        if (parsed.error) { yield { type: 'error', message: parsed.error }; return }
        yield {
          type: 'progress',
          status: parsed.status ?? '',
          digest: parsed.digest,
          total: typeof parsed.total === 'number' ? parsed.total : undefined,
          completed: typeof parsed.completed === 'number' ? parsed.completed : undefined,
        }
        if (parsed.status === 'success') { yield { type: 'done' }; return }
      }
    }
    yield { type: 'done' }
  }

  async listModels(): Promise<Array<{ id: string; sizeBytes?: number }>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(`${this.baseURL}/api/tags`, { signal: controller.signal })
      if (!res.ok) throw new Error(`ollama http ${res.status}`)
      const body = await res.json() as { models?: Array<{ name?: string; size?: number }> }
      return (body.models ?? [])
        .filter((m): m is { name: string; size?: number } => typeof m.name === 'string' && m.name.length > 0)
        .map(m => ({ id: m.name, sizeBytes: typeof m.size === 'number' ? m.size : undefined }))
    } finally {
      clearTimeout(timer)
    }
  }
}
