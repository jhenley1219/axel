import { PasscodeService, RateLimiter, SessionManager } from '@axel/auth'
import { AgentOrchestrator, AppBroker, AskBroker, AxelAgent, CleanupBroker, ClaudeCodeAgent, FileOpenBroker, McpRegistry, PermissionBroker, PtyAgent, ReportBroker, RequestQueue, SessionStore, TerminalBroker, TerminalReadBroker, buildDefaultRegistry, getProvider } from '@axel/agent'
import type { AgentRuntime, ModelProvider, Tier } from '@axel/agent'
import { AuditLogger } from '@axel/core'
import type { AppSettings, PermissionMode } from '@axel/core'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { performance } from 'node:perf_hooks'
import path from 'path'
import { config } from './config.js'
import { SettingsManager } from './services/SettingsManager.js'
import { ClaudeAuthService } from './services/ClaudeAuthService.js'
import { PairTokenStore } from './services/PairTokenStore.js'

export const passcodeService = new PasscodeService()
export const rateLimiter = new RateLimiter()
export const sessionManager = new SessionManager(config.sessionSecret)
export const settingsManager = new SettingsManager()
export const mcpRegistry = new McpRegistry(config.mcpRegistryDir)
export const claudeAuthService = new ClaudeAuthService(config)
export const permissionBroker = new PermissionBroker()
export const terminalBroker = new TerminalBroker()
export const terminalReadBroker = new TerminalReadBroker()
export const fileBroker = new FileOpenBroker()
export const cleanupBroker = new CleanupBroker()
export const appBroker = new AppBroker()
export const askBroker = new AskBroker()
export const reportBroker = new ReportBroker()
export const queueBroker = new RequestQueue()
export const pairTokenStore = new PairTokenStore()
export const sessionStore = new SessionStore(() => performance.now())
export const defaultToolRegistry = buildDefaultRegistry()

const getApiKey = async (): Promise<string | undefined> => (await settingsManager.getSettings()).apiKeys?.anthropic
const getRunSettings = async (): Promise<{ permissionMode?: AppSettings['permissionMode']; model?: string; effort?: AppSettings['effortLevel'] }> => {
  const s = await settingsManager.getSettings()
  const isAxel = (s.agentRuntime ?? 'claude-code') === 'axel'
  return {
    permissionMode: s.permissionMode,
    // claude-code spawns honour modelId; axel spawns honour runtimeModel.
    // Without this split, a stale modelId (e.g. 'claude-opus-4-7') leaks into
    // an Ollama call and the provider returns 404 for an unknown model.
    model: isAxel ? s.runtimeModel : s.modelId,
    effort: s.effortLevel,
  }
}

export const selectAgentRuntime = (settings: AppSettings): AgentRuntime => {
  if (settings.agentRuntime === 'axel') {
    // Refresh from the cache on each call so a runtimeProvider flip in
    // Settings takes effect on the next turn — no server restart.
    const getProviderForSettings = (): ModelProvider => getProvider(settingsManager.getCachedSettings())
    const getPermissionMode = (): PermissionMode => settingsManager.getCachedSettings().permissionMode ?? 'default'
    const getTier = (): Tier => settingsManager.getCachedSettings().modelTier ?? 'frontier'
    return new AxelAgent(
      config.projectsDir,
      config.allowedDirs,
      new AuditLogger(config.auditLogPath),
      getProviderForSettings,
      {
        registry: defaultToolRegistry,
        sessionStore,
        permissionBroker,
        getPermissionMode,
        getTier,
      },
      { getRunSettings },
    )
  }
  // 'claude-code' runtime is HYBRID:
  //   • ROOT spawns (no queueRole, or role==='root') → ClaudeCodeAgent
  //     (stream-json subprocess). Emits structured `token` / `message_end` /
  //     `tool_use` events so the voice loop can TTS the response and the
  //     constellation bubble bar can animate tool calls. This IS the voice
  //     agent — the whole point of axel — and must stay on the structured
  //     path or there's nothing for TTS to speak.
  //   • CHILD spawns (role==='child' — dir terminals) → PtyAgent. Each child
  //     is a long-lived interactive `claude` PTY rendered in xterm so the
  //     user sees the real TUI and can type slash commands / use any MCP
  //     server / inspect the conversation. No voice for child agents (the
  //     TUI bytes aren't reducible to clean speech text without a sidechannel).
  return hybridRuntime
}

// Singleton PTY-mode runtime for CHILD spawns. Held at module scope so
// /agent/pty/:spawnId can look up live sessions and pipe bytes both directions.
export const ptyAgent = new PtyAgent(
  config.projectsDir,
  config.allowedDirs,
  new AuditLogger(config.auditLogPath),
  mcpRegistry,
  config.claudeBin,
  getApiKey,
  {
    broker: permissionBroker,
    terminalBroker,
    terminalReadBroker,
    fileBroker,
    cleanupBroker,
    appBroker,
    askBroker,
    reportBroker,
    queueBroker,
    permissionBaseUrl: `http://127.0.0.1:${config.port}`,
    getRunSettings,
  },
)

// Singleton ClaudeCodeAgent for ROOT spawns — preserves voice TTS by routing
// the main conversational agent through the structured stream-json pipeline
// that emits `token` / `message_end` / `tool_use` events.
const claudeCodeAgent = new ClaudeCodeAgent(
  config.projectsDir,
  config.allowedDirs,
  new AuditLogger(config.auditLogPath),
  mcpRegistry,
  config.claudeBin,
  getApiKey,
  {
    broker: permissionBroker,
    terminalBroker,
    terminalReadBroker,
    fileBroker,
    cleanupBroker,
    appBroker,
    askBroker,
    reportBroker,
    queueBroker,
    permissionBaseUrl: `http://127.0.0.1:${config.port}`,
    getRunSettings,
  },
)

// Routes each orchestrator.run() call to the right backend by queueRole.
// runtimeSessionId namespaces don't collide: orchestrator stores root
// session ids in `this.sessions` (claude --resume ids) and child ids in
// `this.targetSessions` (PTY spawnIds), each looked up by disjoint key
// prefixes — so a stream-json id will never be fed back to PtyAgent.
const hybridRuntime: AgentRuntime = {
  run: (msg, runtimeSessionId, axelSessionId, onEvent, onAuthUrl, systemPrompt, projectsDirOverride, allowedDirsOverride, terminalHandler, fileHandler, cleanupHandler, queueRole, terminalReadHandler) => {
    const backend = queueRole?.role === 'child' ? ptyAgent : claudeCodeAgent
    return backend.run(
      msg, runtimeSessionId, axelSessionId, onEvent, onAuthUrl, systemPrompt,
      projectsDirOverride, allowedDirsOverride, terminalHandler, fileHandler,
      cleanupHandler, queueRole, terminalReadHandler,
    )
  },
  // Probe just checks whether the user is logged in to claude — either
  // backend reads the same ~/.claude.json so claudeCodeAgent answers for both.
  probe: () => claudeCodeAgent.probe(),
  // Peek into a live PTY child for the read_terminal tool. Only ptyAgent
  // holds session-bound byte buffers; root claude spawns are one-shot
  // subprocesses with no persistent state to peek.
  peek: (runtimeSessionId: string) => ptyAgent.peek(runtimeSessionId),
  // "New session" click — kill every child PTY this axel session opened so
  // the orphan `claude` TUIs don't pile up until server restart. Root
  // ClaudeCodeAgent spawns are one-shot and self-exit, so no teardown there.
  resetSession: (axelSessionId: string) => ptyAgent.resetSession(axelSessionId),
}

// Settings are already cached at boot (the SettingsManager loaded them above).
// The orchestrator re-resolves the runtime on every turn via getAgent(), so a
// settings change flips the backend without restart.
await settingsManager.getSettings()

export const orchestrator = new AgentOrchestrator({
  projectsDir: config.projectsDir,
  allowedDirs: config.allowedDirs,
  auditLogPath: config.auditLogPath,
  mcpRegistryDir: config.mcpRegistryDir,
  getAgent: () => selectAgentRuntime(settingsManager.getCachedSettings()),
  permissionBroker,
})
export type StoredCredentials = {
  username: string
  passwordHash: string
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(config.credentialsPath, 'utf-8')
    return JSON.parse(raw) as StoredCredentials
  } catch {
    return null
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(path.dirname(config.credentialsPath), { recursive: true })
  await writeFile(config.credentialsPath, JSON.stringify(creds), { encoding: 'utf-8', mode: 0o600 })
}
