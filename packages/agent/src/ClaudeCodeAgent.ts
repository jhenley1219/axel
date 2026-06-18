import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { spawnEnv } from '@axel/core'
import type { AuditLogger, EffortLevel, PermissionMode } from '@axel/core'
import { McpRegistry } from './McpRegistry.js'
import type { McpServerEntry } from './McpRegistry.js'
import type { PermissionBroker } from './PermissionBroker.js'
import type { TerminalBroker, TerminalOpenHandler } from './TerminalBroker.js'
import type { TerminalReadBroker, TerminalReadHandler } from './TerminalReadBroker.js'
import type { FileOpenBroker, FileOpenHandler } from './FileOpenBroker.js'
import type { CleanupBroker, CleanupHandler } from './CleanupBroker.js'
import type { AppBroker } from './AppBroker.js'
import type { AskBroker } from './AskBroker.js'
import type { ReportBroker } from './ReportBroker.js'
import type { RequestQueue, QueueSpawnRole } from './RequestQueue.js'
import type { AgentWireMessage } from './types.js'
import type { AgentRuntime } from './AgentRuntime.js'

type StreamContentBlock = {
  type: string
  text?: string
  name?: string
  input?: unknown
  // tool_use blocks carry an id; the matching tool_result block carries
  // tool_use_id referencing the same value — that's the invocationId on the wire.
  id?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
type StreamEvent = {
  type: string
  session_id?: string
  message?: { content: Array<StreamContentBlock> }
  subtype?: string
}

export type AgentEvent = Exclude<AgentWireMessage, { type: 'done' | 'error' | 'auth_url' }>

// Per-spawn knobs read from app settings at invocation time.
export type RunSettings = {
  permissionMode?: PermissionMode
  model?: string
  effort?: EffortLevel
}

export type AgentSpawnOpts = {
  broker?: PermissionBroker
  terminalBroker?: TerminalBroker
  terminalReadBroker?: TerminalReadBroker
  fileBroker?: FileOpenBroker
  cleanupBroker?: CleanupBroker
  appBroker?: AppBroker
  askBroker?: AskBroker
  reportBroker?: ReportBroker
  queueBroker?: RequestQueue
  permissionBaseUrl?: string   // e.g. http://127.0.0.1:8080 — where /mcp/permission/:spawnId, /mcp/terminal/:spawnId, /mcp/files/:spawnId, /mcp/cleanup/:spawnId, /mcp/apps, /mcp/ask/:spawnId, /mcp/queue/:spawnId, /mcp/report/:spawnId live
  getRunSettings?: () => Promise<RunSettings>
}

// 256 KB ~= 40K words; large enough to paste a small file or long instructions
// without hitting the cap in normal use. Real ceiling is the model's context
// window — this is just a sanity check to prevent OOM-class payloads.
export const MAX_USER_MESSAGE_BYTES = 262144

export class ClaudeCodeAgent implements AgentRuntime {
  constructor(
    private projectsDir: string,
    private allowedDirs: string[],
    private logger: AuditLogger,
    private registry: McpRegistry,
    private claudeBin: string = 'claude',
    private getApiKey?: () => Promise<string | undefined>,
    private spawnOpts?: AgentSpawnOpts,
  ) {}

  async run(
    userMessage: string,
    claudeSessionId: string | undefined,
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
    const cwd = projectsDirOverride ?? this.projectsDir
    const allowedDirs = allowedDirsOverride ?? this.allowedDirs
    await this.logger.log({
      type: 'execute',
      sessionId: axelSessionId,
      tool: 'claude',
      input: { preview: userMessage.slice(0, 120), claudeSessionId },
    })

    const runSettings = (await this.spawnOpts?.getRunSettings?.()) ?? {}
    const mode = runSettings.permissionMode ?? 'default'

    // Strict modes route every permission prompt through our MCP bridge: a
    // per-spawn server entry whose unguessable spawnId doubles as the route's
    // auth capability. Bypass keeps the original flag — zero-regression path.
    let spawnId: string | undefined
    const extraMcp: Record<string, McpServerEntry> = {}
    const { broker, terminalBroker, terminalReadBroker, fileBroker, cleanupBroker, appBroker, askBroker, reportBroker, queueBroker, permissionBaseUrl } = this.spawnOpts ?? {}
    if (mode !== 'bypassPermissions' && broker && permissionBaseUrl) {
      spawnId = randomUUID()
      extraMcp.axel_permissions = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/permission/${spawnId}`,
        // A prompt can sit unanswered for a long time — the broker
        // auto-denies at 570s, before this transport timeout fires.
        timeout: 600_000,
      }
    }

    // The open_terminal bridge gets its OWN spawnId (independent of permission
    // mode — bypass spawns must never register with the permission broker).
    let termSpawnId: string | undefined
    if (terminalHandler && terminalBroker && permissionBaseUrl) {
      termSpawnId = randomUUID()
      extraMcp.axel_terminals = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/terminal/${termSpawnId}`,
        timeout: 60_000,
      }
    }

    // open_file bridge — independent spawnId, same capability model.
    let fileSpawnId: string | undefined
    if (fileHandler && fileBroker && permissionBaseUrl) {
      fileSpawnId = randomUUID()
      extraMcp.axel_files = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/files/${fileSpawnId}`,
        timeout: 60_000,
      }
    }

    // axel_apps bridge — shared in-process apps (timer, notes). No spawnId
    // because app state is shared across spawns; the route is loopback-only.
    if (appBroker && permissionBaseUrl) {
      extraMcp.axel_apps = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/apps`,
        timeout: 60_000,
      }
    }

    // close_idle_dirs bridge — only wired for root spawns (the orchestrator
    // omits cleanupHandler for child runs so sub-agents can't close dirs).
    let cleanupSpawnId: string | undefined
    if (cleanupHandler && cleanupBroker && permissionBaseUrl) {
      cleanupSpawnId = randomUUID()
      extraMcp.axel_cleanup = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/cleanup/${cleanupSpawnId}`,
        timeout: 60_000,
      }
    }

    // ask_user bridge — ROOT spawns only. Child sub-agents must not speak to
    // the user directly; they raise requests through axel_queue instead, which
    // routes via the root agent so the user has one coherent conversation.
    let askSpawnId: string | undefined
    if (askBroker && permissionBaseUrl && queueRole?.role !== 'child') {
      askSpawnId = randomUUID()
      extraMcp.axel_ask = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/ask/${askSpawnId}`,
        // The user has the full broker timeout (570s) to answer — the MCP
        // transport must outlast it so the call doesn't fail before the broker
        // auto-cancels.
        timeout: 600_000,
      }
    }

    // axel_queue bridge — child spawns get `request` (raise to root); root gets
    // `list` / `claim` / `resolve` to drain the queue and route answers back.
    let queueSpawnId: string | undefined
    if (queueBroker && queueRole && permissionBaseUrl) {
      queueSpawnId = randomUUID()
      extraMcp.axel_queue = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/queue/${queueSpawnId}`,
        // Child `request` blocks until root resolves — same 600s ceiling as
        // ask/permission so the broker's 570s auto-deny lands first.
        timeout: 600_000,
      }
    }

    // axel_report bridge — CHILD spawns only. The child's last act of every
    // task is a one-shot summary back to the root so the root has something to
    // tell the user. Without this, PTY-mode children leave the root's
    // BACKGROUND TERMINALS section reading "(no output yet)".
    let reportSpawnId: string | undefined
    if (reportBroker && permissionBaseUrl && queueRole?.role === 'child') {
      reportSpawnId = randomUUID()
      extraMcp.axel_report = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/report/${reportSpawnId}`,
        timeout: 60_000,
      }
    }

    // axel_terminal_read bridge — ROOT spawns only. Lets the root pull a
    // child's recent text on demand when the BACKGROUND TERMINALS prefill
    // looks empty or garbled. Children mustn't peek at sibling terminals.
    let termReadSpawnId: string | undefined
    if (terminalReadHandler && terminalReadBroker && permissionBaseUrl && queueRole?.role !== 'child') {
      termReadSpawnId = randomUUID()
      extraMcp.axel_terminal_read = {
        type: 'http',
        url: `${permissionBaseUrl}/mcp/terminal_read/${termReadSpawnId}`,
        timeout: 60_000,
      }
    }

    // Generate MCP config from registry (temp file, cleaned up after invocation)
    const mcp = await this.registry.generateConfig(Object.keys(extraMcp).length > 0 ? extraMcp : undefined)

    const args = [
      '-p', userMessage,
      '--output-format', 'stream-json',
      '--verbose',
    ]

    if (mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', mode)
      if (spawnId) args.push('--permission-prompt-tool', 'mcp__axel_permissions__approve')
    }

    if (runSettings.model)  args.push('--model', runSettings.model)
    if (runSettings.effort) args.push('--effort', runSettings.effort)

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt)
    }

    // Wire up all registered app MCP servers
    if (mcp.configPath) {
      args.push('--mcp-config', mcp.configPath)
    }

    // Grant file access to the effective allowlist + any app-specific dirs
    // from the MCP registry. Always include the active cwd so a
    // settings-picked directory is accessible.
    const allDirs = [...new Set([cwd, ...allowedDirs, ...mcp.addDirs])]
    for (const dir of allDirs) {
      if (dir !== cwd) args.push('--add-dir', dir)
    }

    if (claudeSessionId) args.push('--resume', claudeSessionId)

    // ANTHROPIC_API_KEY in the env makes the claude CLI authenticate with it
    // instead of its OAuth session — a key saved in Settings wins over both
    // the .env key and the Google sign-in.
    const apiKey = (await this.getApiKey?.()) ?? process.env.ANTHROPIC_API_KEY

    // Registered before spawn so the very first prompt can already resolve;
    // unregistered in the finally below, which denies anything still pending.
    if (spawnId && broker) broker.register(spawnId, onEvent)
    if (termSpawnId && terminalBroker && terminalHandler) terminalBroker.register(termSpawnId, terminalHandler)
    if (fileSpawnId && fileBroker && fileHandler) fileBroker.register(fileSpawnId, fileHandler)
    if (cleanupSpawnId && cleanupBroker && cleanupHandler) cleanupBroker.register(cleanupSpawnId, cleanupHandler)
    if (askSpawnId && askBroker) askBroker.register(askSpawnId, onEvent)
    if (reportSpawnId && reportBroker) reportBroker.register(reportSpawnId, onEvent)
    if (termReadSpawnId && terminalReadBroker && terminalReadHandler) terminalReadBroker.register(termReadSpawnId, terminalReadHandler)
    if (queueSpawnId && queueBroker && queueRole) queueBroker.register(queueSpawnId, queueRole)

    const proc = spawn(this.claudeBin, args, {
      // Run from the projects root so project-level .mcp.json files load
      cwd,
      // stdin must be closed/ignored: an open pipe makes the CLI wait 3s for
      // piped input ("no stdin data received in 3s") on every invocation.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv({
        CLAUDE_PATH: process.env.CLAUDE_PATH,
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      }),
    })

    let newSessionId: string | undefined
    let stdoutBuf = ''
    let stderrBuf = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as StreamEvent
          if (event.session_id) newSessionId = event.session_id
          if (event.type === 'assistant' && event.message?.content) {
            // An `assistant` event is one model turn. Stream all text-block
            // tokens first so the UI updates as text arrives, then emit
            // message_end so the client can speak this message immediately
            // while subsequent tool calls / model turns continue.
            let emittedText = false
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                onEvent({ type: 'token', value: block.text })
                emittedText = true
              } else if (block.type === 'tool_use' && block.name && block.id) {
                if (emittedText) {
                  onEvent({ type: 'message_end' })
                  emittedText = false
                }
                onEvent({ type: 'tool_use', name: block.name, invocationId: block.id, input: block.input })
              }
            }
            if (emittedText) onEvent({ type: 'message_end' })
          } else if (event.type === 'user' && event.message?.content) {
            // The claude CLI surfaces tool results as a `user` turn whose
            // content is one or more `tool_result` blocks. Each carries
            // `tool_use_id` (matching the original tool_use.id) so the UI can
            // settle the right bubble.
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const ok = block.is_error !== true
                onEvent(ok
                  ? { type: 'tool_end', invocationId: block.tool_use_id, ok: true,  result: block.content }
                  : { type: 'tool_end', invocationId: block.tool_use_id, ok: false, error: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) },
                )
              }
            }
          }
        } catch { /* non-JSON line */ }
      }
    })

    // Accumulate stderr (bounded) so a failing process reports WHY it failed —
    // resetting the buffer per chunk left exit errors with empty messages.
    let authUrlSent = false
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString()).slice(-8192)
      if (!authUrlSent) {
        const match = /https:\/\/[^\s]+(?:login|oauth|auth|authorize)[^\s]*/i.exec(stderrBuf)
        if (match) { onAuthUrl(match[0]); authUrlSent = true }
      }
    })

    try {
      await new Promise<void>((resolve, reject) => {
        proc.on('close', code => {
          if (code === 0) resolve()
          else reject(new Error(`claude process failed: ${stderrBuf.trim() || `exit code ${code}`}`))
        })
        proc.on('error', reject)
      })
    } finally {
      if (spawnId && broker) broker.unregister(spawnId)
      if (termSpawnId && terminalBroker) terminalBroker.unregister(termSpawnId)
      if (fileSpawnId && fileBroker) fileBroker.unregister(fileSpawnId)
      if (cleanupSpawnId && cleanupBroker) cleanupBroker.unregister(cleanupSpawnId)
      if (askSpawnId && askBroker) askBroker.unregister(askSpawnId)
      if (reportSpawnId && reportBroker) reportBroker.unregister(reportSpawnId)
      if (termReadSpawnId && terminalReadBroker) terminalReadBroker.unregister(termReadSpawnId)
      if (queueSpawnId && queueBroker) queueBroker.unregister(queueSpawnId)
      mcp.cleanup()
    }

    return newSessionId
  }

  // Spawns a minimal claude invocation to check if auth is required.
  // Returns null if credentials exist, or the auth URL if not logged in.
  // Reads the config file directly — no subprocess, no stdin warnings.
  async probe(): Promise<string | null> {
    const configPath = join(process.env.HOME ?? '/home/axel', '.claude.json')
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      const hasAccount = !!(cfg['oauthAccount'] as Record<string, unknown> | undefined)?.['accountUuid']
      if (hasAccount) return null  // authenticated
    } catch { /* file missing or unreadable */ }
    return null  // return null either way — UI handles sign-in flow separately
  }
}
