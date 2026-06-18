import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js'
import type { ConvMessage } from '../Conversation.js'
import type { ModelProvider, ProviderOpts, StreamEvent, StreamRequest, ToolSpec } from './Provider.js'

// Anthropic's API requires max_tokens. 4096 is generous for chat; tools/longer
// completions arrive in Phase B and can override this.
const DEFAULT_MAX_TOKENS = 4096

type ToolUseAccum = { id: string; name: string; partialJson: string }

const toAnthropicTools = (tools: Array<ToolSpec> | undefined): Array<Tool> | undefined => {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t): Tool => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Tool.InputSchema,
  }))
}

const toAnthropicMessages = (messages: Array<ConvMessage>): Array<MessageParam> => {
  const out: Array<MessageParam> = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content })
      continue
    }
    if (msg.role === 'assistant') {
      if (!msg.toolCalls || msg.toolCalls.length === 0) {
        out.push({ role: 'assistant', content: msg.content })
        continue
      }
      const blocks: Array<ContentBlockParam> = []
      if (msg.content) blocks.push({ type: 'text', text: msg.content })
      for (const tc of msg.toolCalls) {
        const block: ToolUseBlockParam = { type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }
        blocks.push(block)
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    // tool result -> user message with tool_result block (Anthropic convention)
    const block: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: msg.toolCallId,
      content: msg.content,
    }
    out.push({ role: 'user', content: [block] })
  }
  return out
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic' as const
  private apiKey?: string
  private baseURL?: string

  constructor({ apiKey, baseURL }: ProviderOpts) {
    this.apiKey = apiKey
    this.baseURL = baseURL
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    try {
      const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL })
      const stream = await client.messages.create({
        model: req.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: req.systemPrompt,
        messages: toAnthropicMessages(req.messages),
        tools: toAnthropicTools(req.tools),
        stream: true,
      })

      const toolBlocks = new Map<number, ToolUseAccum>()

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              partialJson: '',
            })
          }
          continue
        }
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'token', value: event.delta.text }
          } else if (event.delta.type === 'input_json_delta') {
            const accum = toolBlocks.get(event.index)
            if (accum) accum.partialJson += event.delta.partial_json
          }
          continue
        }
        if (event.type === 'content_block_stop') {
          const accum = toolBlocks.get(event.index)
          if (accum) {
            const input = accum.partialJson === '' ? {} : JSON.parse(accum.partialJson) as unknown
            yield { type: 'tool_call', id: accum.id, name: accum.name, input }
            toolBlocks.delete(event.index)
          }
        }
      }
      yield { type: 'end' }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async probe(): Promise<string | null> {
    if (!this.apiKey) return 'missing apiKey'
    try {
      new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}
