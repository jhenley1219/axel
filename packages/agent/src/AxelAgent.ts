import { randomUUID } from 'node:crypto'
import type { AuditLogger, PermissionMode } from '@axel/core'
import type { AgentRuntime } from './AgentRuntime.js'
import type { AgentEvent, AgentSpawnOpts } from './ClaudeCodeAgent.js'
import type { SessionStore, ToolCall } from './Conversation.js'
import type { PermissionBroker } from './PermissionBroker.js'
import { composeSystemPrompt, type Tier } from './promptTiers.js'
import type { ModelProvider } from './providers/Provider.js'
import type { TerminalOpenHandler } from './TerminalBroker.js'
import type { FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupHandler } from './CleanupBroker.js'
import type { ToolContext, ToolRegistry } from './tools/index.js'

const MAX_TOOL_LOOP_ITERATIONS = 25

const defaultModel = (name: ModelProvider['name']): string => {
  switch (name) {
    case 'anthropic': return 'claude-opus-4-7'
    case 'openai':    return 'gpt-5'
    case 'ollama':    return 'llama3.1:8b'
  }
}

export type AxelAgentDeps = {
  registry: ToolRegistry
  sessionStore: SessionStore
  permissionBroker: PermissionBroker
  getPermissionMode: () => PermissionMode
  getTier: () => Tier
}

export class AxelAgent implements AgentRuntime {
  constructor(
    private projectsDir: string,
    private allowedDirs: Array<string>,
    private logger: AuditLogger,
    private getProvider: () => ModelProvider,
    private deps: AxelAgentDeps,
    private spawnOpts?: AgentSpawnOpts,
  ) {}

  async run(
    userMessage: string,
    runtimeSessionId: string | undefined,
    axelSessionId: string,
    onEvent: (event: AgentEvent) => void,
    onAuthUrl: (url: string) => void,
    systemPrompt?: string,
    projectsDirOverride?: string,
    allowedDirsOverride?: string[],
    terminalHandler?: TerminalOpenHandler,
    fileHandler?: FileOpenHandler,
    cleanupHandler?: CleanupHandler,
  ): Promise<string | undefined> {
    void runtimeSessionId       // axel uses axelSessionId as the conv key
    void terminalHandler        // open_terminal lives outside the tool registry for now
    void fileHandler            // axel opens files via its own ui_open_file tool, not the broker
    void cleanupHandler         // close_idle_dirs is a claude-code-only capability
    void onAuthUrl              // providers don't surface interactive OAuth

    await this.logger.log({
      type: 'execute',
      sessionId: axelSessionId,
      tool: 'axel',
      input: { preview: userMessage.slice(0, 120) },
    })

    const runSettings = (await this.spawnOpts?.getRunSettings?.()) ?? {}
    const provider = this.getProvider()
    const model = runSettings.model ?? defaultModel(provider.name)

    const conv = this.deps.sessionStore.get(axelSessionId)
    conv.addUser(userMessage)

    const tools = this.deps.registry.list().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))

    const ctx: ToolContext = {
      allowedDirs: allowedDirsOverride ?? this.allowedDirs,
      cwd: projectsDirOverride ?? this.projectsDir,
      emitEvent: onEvent,
    }

    const composedSystem = composeSystemPrompt(systemPrompt ?? '', this.deps.getTier())

    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
      let assistantText = ''
      const toolCalls: Array<ToolCall> = []
      let errored = false

      for await (const ev of provider.stream({
        messages: conv.toMessages(),
        tools,
        model,
        systemPrompt: composedSystem,
      })) {
        if (ev.type === 'token') {
          assistantText += ev.value
          onEvent({ type: 'token', value: ev.value })
        } else if (ev.type === 'tool_call') {
          toolCalls.push({ id: ev.id, name: ev.name, input: ev.input })
          onEvent({ type: 'tool_use', name: ev.name, invocationId: ev.id, input: ev.input })
        } else if (ev.type === 'end') {
          break
        } else if (ev.type === 'error') {
          errored = true
          throw new Error(ev.message)
        }
      }
      void errored

      conv.addAssistant(assistantText, toolCalls.length > 0 ? toolCalls : undefined)

      if (toolCalls.length === 0) {
        onEvent({ type: 'message_end' })
        return randomUUID()
      }

      const mode = this.deps.getPermissionMode()
      const tier = this.deps.getTier()
      for (const call of toolCalls) {
        if (mode !== 'bypassPermissions') {
          const decision = await this.deps.permissionBroker.requestApproval({
            toolName: call.name,
            input: call.input,
            sessionId: axelSessionId,
            axelSessionId,
            tier,
          })
          if (decision === 'deny') {
            conv.addToolResult(call.id, 'TOOL CALL DENIED BY USER.')
            continue
          }
        }
        const tool = this.deps.registry.get(call.name)
        if (!tool) {
          conv.addToolResult(call.id, 'unknown tool: ' + call.name)
          continue
        }
        const result = await tool.execute(call.input, ctx)
        conv.addToolResult(call.id, result.ok ? result.output : 'ERROR: ' + result.error)
      }
    }

    throw new Error('axel: tool loop exceeded ' + MAX_TOOL_LOOP_ITERATIONS + ' iterations')
  }

  probe(): Promise<string | null> {
    return this.getProvider().probe()
  }
}
