import OpenAI from 'openai'
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { ConvMessage } from '../Conversation.js'
import type { ModelProvider, ProviderOpts, StreamEvent, StreamRequest, ToolSpec } from './Provider.js'

type ToolCallAccum = { id: string; name: string; argsJson: string }

const toOpenAITools = (tools: Array<ToolSpec> | undefined): Array<ChatCompletionTool> | undefined => {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t): ChatCompletionTool => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }))
}

const toOpenAIMessages = (
  messages: Array<ConvMessage>,
  systemPrompt: string | undefined,
): Array<ChatCompletionMessageParam> => {
  const out: Array<ChatCompletionMessageParam> = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })
  for (const msg of messages) {
    if (msg.role === 'system') { out.push({ role: 'system', content: msg.content }); continue }
    if (msg.role === 'user')   { out.push({ role: 'user', content: msg.content }); continue }
    if (msg.role === 'assistant') {
      if (!msg.toolCalls || msg.toolCalls.length === 0) {
        out.push({ role: 'assistant', content: msg.content })
        continue
      }
      const tool_calls: Array<ChatCompletionMessageToolCall> = msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      }))
      const assistant: ChatCompletionAssistantMessageParam = msg.content
        ? { role: 'assistant', content: msg.content, tool_calls }
        : { role: 'assistant', tool_calls }
      out.push(assistant)
      continue
    }
    // tool result
    out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content })
  }
  return out
}

export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai' as const
  private apiKey?: string
  private baseURL?: string

  constructor({ apiKey, baseURL }: ProviderOpts) {
    this.apiKey = apiKey
    this.baseURL = baseURL
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    try {
      const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL })
      const stream = await client.chat.completions.create({
        model: req.model,
        messages: toOpenAIMessages(req.messages, req.systemPrompt),
        tools: toOpenAITools(req.tools),
        stream: true,
      })

      // OpenAI streams tool_calls in fragments keyed by `index`. We accumulate
      // each slot's id/name/arguments and flush when the stream ends.
      const accum = new Map<number, ToolCallAccum>()

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) yield { type: 'token', value: delta.content }
        if (delta.tool_calls) {
          for (const part of delta.tool_calls) {
            const cur = accum.get(part.index) ?? { id: '', name: '', argsJson: '' }
            if (part.id) cur.id = part.id
            if (part.function?.name) cur.name = part.function.name
            if (part.function?.arguments) cur.argsJson += part.function.arguments
            accum.set(part.index, cur)
          }
        }
      }
      // Flush completed tool calls in slot order.
      const indices = [...accum.keys()].sort((a, b) => a - b)
      for (const i of indices) {
        const tc = accum.get(i)
        if (!tc || !tc.name) continue
        const input = tc.argsJson === '' ? {} : JSON.parse(tc.argsJson) as unknown
        yield { type: 'tool_call', id: tc.id, name: tc.name, input }
      }
      yield { type: 'end' }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async probe(): Promise<string | null> {
    if (!this.apiKey) return 'missing apiKey'
    try {
      new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}
