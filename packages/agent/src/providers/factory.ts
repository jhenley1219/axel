import type { AppSettings } from '@axel/core'
import { AnthropicProvider } from './AnthropicProvider.js'
import { OpenAIProvider } from './OpenAIProvider.js'
import { OllamaProvider } from './OllamaProvider.js'
import type { ModelProvider } from './Provider.js'

export const getProvider = (settings: AppSettings): ModelProvider => {
  const provider = settings.runtimeProvider ?? 'anthropic'
  const baseURL = settings.runtimeBaseURL || undefined
  const apiKey = settings.apiKeys?.[provider]
  switch (provider) {
    case 'anthropic': return new AnthropicProvider({ apiKey, baseURL })
    case 'openai':    return new OpenAIProvider({ apiKey, baseURL })
    case 'ollama':    return new OllamaProvider({ baseURL })
  }
}
