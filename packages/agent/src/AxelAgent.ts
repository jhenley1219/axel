import { randomUUID } from 'node:crypto'
import type { AuditLogger, PermissionMode } from '@axel/core'
import type { AgentRuntime } from './AgentRuntime.js'
import type { AgentEvent, AgentSpawnOpts } from './ClaudeCodeAgent.js'
import type { SessionStore, ToolCall } from './Conversation.js'
import type { PermissionBroker } from './PermissionBroker.js'
import { composeSystemPrompt, type Tier } from './promptTiers.js'
import type { ModelProvider } from './providers/Provider.js'
import type { TerminalOpenHandler } from './TerminalBroker.js'
import type { TerminalReadHandler } from './TerminalReadBroker.js'
import type { FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupHandler } from './CleanupBroker.js'
import type { QueueSpawnRole } from './RequestQueue.js'
import { buildRootOrchestrationTools, type Tool, type ToolContext, type ToolRegistry } from './tools/index.js'

const MAX_TOOL_LOOP_ITERATIONS = 25

const defaultModel = (name: ModelProvider['name']): string => {
  switch (name) {
    case 'anthropic': return 'claude-opus-4-7'
    case 'openai':    return 'gpt-5'
    case 'ollama':    return 'llama3.1:8b'
  }
}

// Emitted once per provider-stream iteration so observers can compare the raw
// text the model produced against the tool calls actually parsed out of it.
export type AxelTurnRecord = {
  iteration: number
  rawModelOutput: string
  parsedToolCalls: Array<ToolCall>
  model: string
  provider: string
  tier: string
}

export type AxelAgentDeps = {
  registry: ToolRegistry
  sessionStore: SessionStore
  permissionBroker: PermissionBroker
  getPermissionMode: () => PermissionMode
  getTier: () => Tier
  // Optional turn observer (wired to @axel/observability in the server). When
  // unset the agent behaves identically — zero overhead, no behavior change.
  onTurn?: (axelSessionId: string, rec: AxelTurnRecord) => void
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
    queueRole?: QueueSpawnRole,
    terminalReadHandler?: TerminalReadHandler,
  ): Promise<string | undefined> {
    void runtimeSessionId       // axel uses axelSessionId as the conv key
    void fileHandler            // axel opens files via its own ui_open_file tool, not the broker
    void onAuthUrl              // providers don't surface interactive OAuth

    // The local model acts as the root controller: it socializes with the user
    // and delegates project work by spawning sub-terminals of itself. Those
    // capabilities are the terminal/read/cleanup handlers the orchestrator
    // passes here — exposed as real tools only on the root spawn so the model
    // can CALL open_terminal instead of describing it in text.
    const isRoot = queueRole?.role === 'root'
    const orchestrationTools: Array<Tool> = isRoot
      ? buildRootOrchestrationTools({ open: terminalHandler, read: terminalReadHandler, cleanup: cleanupHandler })
      : []

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

    // Root controller delegates ALL project work — it gets ONLY the
    // orchestration tools, never the file/search/bash tools (those would tempt
    // it to do work inline instead of handing off). A worker/child spawn gets
    // the file tools to actually do the task.
    const activeTools: Array<Tool> = isRoot ? orchestrationTools : this.deps.registry.list()
    const toolByName = new Map(activeTools.map(t => [t.name, t]))
    const tools = activeTools.map(t => ({
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

      this.deps.onTurn?.(axelSessionId, {
        iteration: iter,
        rawModelOutput: assistantText,
        parsedToolCalls: toolCalls,
        model,
        provider: provider.name,
        tier: this.deps.getTier(),
      })

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
        const tool = toolByName.get(call.name)
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
