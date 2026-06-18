import type { AuditLogger } from './AuditLogger.js'
import type { PermissionGuard } from './PermissionGuard.js'

export type AgentToolResult = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type Dispatcher = (toolName: string, input: unknown) => Promise<string>

export class ToolExecutor {
  constructor(
    private guard: PermissionGuard,
    private logger: AuditLogger,
    private dispatch: Dispatcher,
  ) {}

  async execute(sessionId: string, toolName: string, toolId: string, input: unknown): Promise<AgentToolResult> {
    const guardResult = this.guard.check(toolName, input)

    if (!guardResult.ok) {
      await this.logger.log({ type: 'denied', sessionId, tool: toolName, input, reason: guardResult.reason })
      return { type: 'tool_result', tool_use_id: toolId, content: `[DENIED: ${guardResult.reason}]`, is_error: true }
    }

    await this.logger.log({ type: 'execute', sessionId, tool: toolName, input })

    try {
      const output = await this.dispatch(toolName, input)
      return { type: 'tool_result', tool_use_id: toolId, content: output }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await this.logger.log({ type: 'error', sessionId, tool: toolName, input, reason })
      return { type: 'tool_result', tool_use_id: toolId, content: `[ERROR: ${reason}]`, is_error: true }
    }
  }
}
