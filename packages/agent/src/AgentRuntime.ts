import type { AgentEvent } from './ClaudeCodeAgent.js'
import type { TerminalOpenHandler } from './TerminalBroker.js'
import type { TerminalReadHandler } from './TerminalReadBroker.js'
import type { FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupHandler } from './CleanupBroker.js'
import type { QueueSpawnRole } from './RequestQueue.js'

export type AgentRuntime = {
  run: (
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
  ) => Promise<string | undefined>
  probe: () => Promise<string | null>
  // Optional peek hook — only PTY-backed runtimes implement it. Lets the
  // orchestrator surface a child terminal's raw recent output (4KB
  // ANSI-stripped window) on demand for the root agent's read_terminal tool.
  // Returns null when the runtime has no session-bound text buffer, or when
  // the runtimeSessionId doesn't resolve.
  peek?: (runtimeSessionId: string) => { strippedTail: string; turnText: string } | null
  // Optional teardown hook — called from AgentOrchestrator.resetSession so a
  // UI "new session" click can drop any long-lived child processes (e.g.
  // PtyAgent's per-terminal `claude` TUIs) belonging to this axel session.
  // Runtimes without persistent per-session state may omit it.
  resetSession?: (axelSessionId: string) => void
}
