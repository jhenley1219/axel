import path, { resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Locate the bundled python/ dir. Layouts differ across deployments:
//   • repo / pnpm dev:  apps/server/dist/config.js  →  ../../../python
//   • Docker runtime:   /app/dist/config.js          →  ../python
// First existing candidate wins; /app/python kept as a final legacy fallback.
function findPythonScriptDir(): string {
  const candidates = [
    resolve(__dirname, '..', '..', '..', 'python'),
    resolve(__dirname, '..', 'python'),
  ]
  return candidates.find(existsSync) ?? '/app/python'
}

// Locate the claude CLI. Docker bakes it at /usr/local/bin/claude; macOS arm
// puts it under /opt/homebrew/bin. Falls back to `which claude` so any PATH
// install works without configuration.
function findClaudeBin(): string {
  const candidates = ['/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  const found = candidates.find(existsSync)
  if (found) return found
  try {
    const which = execSync('command -v claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (which) return which
  } catch { /* not on PATH */ }
  return 'claude'  // last-resort: let spawn resolve via PATH at runtime
}

// If WORKSPACE_ROOT is set, unset path env vars derive from it.
// If not set, each path falls back to its own env var then the hardcoded default.
// This is fully backward-compatible — existing Docker deployments without
// WORKSPACE_ROOT continue to work identically.
const workspaceRoot = process.env.WORKSPACE_ROOT
  ? resolve(process.env.WORKSPACE_ROOT)
  : undefined

// Resolve projectsDir once so allowedDirs can derive from it.
const resolvedProjectsDir: string = process.env.PROJECTS_DIR
  ? resolve(process.env.PROJECTS_DIR)
  : workspaceRoot
    ? resolve(workspaceRoot, 'projects')
    : '/projects'  // keep Docker default

export const config = {
  port: Number(process.env.PORT ?? 8080),
  requireAuth: process.env.REQUIRE_AUTH === 'true' || process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',

  credentialsPath: process.env.CREDENTIALS_PATH
    ? resolve(process.env.CREDENTIALS_PATH)
    : workspaceRoot
      ? resolve(workspaceRoot, 'data/credentials.json')
      : resolve('./data/credentials.json'),

  // projectsDir: cwd for claude invocations — common parent of all projects
  projectsDir: resolvedProjectsDir,

  // allowedDirs: dirs Claude may read/write. When ALLOWED_DIRS is not set,
  // derives from projectsDir so WORKSPACE_ROOT is honoured automatically.
  allowedDirs: (() => {
    const raw = (process.env.ALLOWED_DIRS ?? '').split(':').filter(Boolean)
    if (raw.length > 0) return raw.map(d => resolve(d))
    // Derive from projectsDir (which already accounts for WORKSPACE_ROOT)
    return [resolvedProjectsDir]
  })(),

  auditLogPath: process.env.AUDIT_LOG_PATH
    ? resolve(process.env.AUDIT_LOG_PATH)
    : workspaceRoot
      ? resolve(workspaceRoot, 'data/audit/commands.jsonl')
      : resolve('./data/audit/commands.jsonl'),

  // mcpRegistryDir: apps drop their registration JSON here to connect to Axel
  mcpRegistryDir: process.env.MCP_REGISTRY_DIR
    ? resolve(process.env.MCP_REGISTRY_DIR)
    : workspaceRoot
      ? resolve(workspaceRoot, '.axel/mcp-registry')
      : path.join(homedir(), '.axel', 'mcp-registry'),

  // observabilityDir: per-session interaction recordings (UI snapshots +
  // backend conversation feed) the axel-observe MCP server reads back.
  observabilityDir: process.env.OBSERVABILITY_DIR
    ? resolve(process.env.OBSERVABILITY_DIR)
    : workspaceRoot
      ? resolve(workspaceRoot, 'data/observability')
      : resolve('./data/observability'),

  // OBSERVABILITY_ENABLED=false turns off recording entirely.
  observabilityEnabled: process.env.OBSERVABILITY_ENABLED !== 'false',

  pythonPath: process.env.PYTHON_PATH ?? 'python3',
  pythonScriptDir: process.env.PYTHON_SCRIPT_DIR
    ? resolve(process.env.PYTHON_SCRIPT_DIR)
    : findPythonScriptDir(),
  claudeBin: process.env.CLAUDE_PATH ?? findClaudeBin(),
}

export function logConfig(): void {
  console.log('[axel] config:')
  console.log(`  projectsDir:    ${config.projectsDir}`)
  console.log(`  mcpRegistryDir: ${config.mcpRegistryDir}`)
  console.log(`  auditLogPath:   ${config.auditLogPath}`)
}
