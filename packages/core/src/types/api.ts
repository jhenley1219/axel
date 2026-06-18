// HTTP API shapes shared between the server routes and the web client.

export type ModelProvider = 'claude-code' | 'anthropic-api' | 'openai' | 'custom'

// Mirrors the claude CLI's --permission-mode choices we expose.
// Unset means 'default' (every write/command pauses for in-app approval).
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AppSettings = {
  modelProvider?: ModelProvider
  modelId?: string
  apiKeys?: Record<string, string>     // keyed by provider id
  customEndpoint?: string
  ttsVoice?: 'ava' | 'andrew'
  projectsRoot?: string
  permissionMode?: PermissionMode
  effortLevel?: EffortLevel
  // 'claude-code' = wraps the user's installed `claude` CLI. 'axel' = the
  // in-tree multi-provider runtime; no external binary required.
  agentRuntime?: 'claude-code' | 'axel'
  // Inlined from @axel/agent's Tier to avoid a core→agent cycle.
  modelTier?: 'frontier' | 'mid' | 'q4-local' | 'q2-local'
  // Used by agentRuntime='axel'. Keys for each provider live in apiKeys.
  runtimeProvider?: 'anthropic' | 'openai' | 'ollama'
  runtimeModel?: string
  runtimeBaseURL?: string
}

// GET/PUT /api/settings
export type SettingsResponse = {
  ok: boolean
  settings: AppSettings
  hasKeys: Record<string, boolean>
  projectsRoot: string | null
  mcpRegistryDir: string
}

// A file directly inside a browsed/scanned directory
export type FileEntry = { name: string; path: string; tracked: boolean }

// GET /api/fs/projects items
export type ProjectItem = { id: string; name: string; path: string; fileCount: number; lang?: string }

// GET /api/fs/browse
export type BrowseResponse =
  | { ok: true; path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; files?: Array<FileEntry>; fellBackFrom?: string }
  | { ok: false; error: string; path?: string }

// GET /auth/claude/status
export type ClaudeAuthState = { loggedIn: boolean; email?: string }

// GET /api/mcp/list items
export type McpListItem = {
  id: string
  name: string
  kind: 'http' | 'stdio'
  endpoint: string
  description: string | null
  addDir: string | null
}
