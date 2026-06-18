import type { ConvMessage } from '../Conversation.js'

export type ToolSpec = {
  name: string
  description: string
  inputSchema: object
}

export type StreamEvent =
  | { type: 'token'; value: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'end' }
  | { type: 'error'; message: string }

export type StreamRequest = {
  messages: Array<ConvMessage>
  model: string
  systemPrompt?: string
  tools?: Array<ToolSpec>
  abortSignal?: AbortSignal
}

export type ProviderOpts = {
  apiKey?: string
  baseURL?: string
}

export type ModelProvider = {
  readonly name: 'anthropic' | 'openai' | 'ollama'
  stream(req: StreamRequest): AsyncIterable<StreamEvent>
  probe(): Promise<string | null>
}
