#!/usr/bin/env node
// axel CLI entry point — auto-configures and starts the server
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDist = path.join(__dirname, '..', 'apps', 'server', 'dist', 'index.js')

if (!existsSync(serverDist)) {
  console.error('\n  axel: server not built. Run: pnpm build\n')
  process.exit(1)
}

// ── Persistent config in ~/.axel/config.json ─────────────────────────────────
// Stores the auto-generated SESSION_SECRET so sessions survive restarts without
// the user ever having to configure anything.
const axelConfigDir = path.join(homedir(), '.axel')
const axelConfigPath = path.join(axelConfigDir, 'config.json')

let axelConfig = {}
try {
  axelConfig = JSON.parse(readFileSync(axelConfigPath, 'utf-8'))
} catch { /* first run — config doesn't exist yet */ }

if (!axelConfig.sessionSecret) {
  axelConfig.sessionSecret = randomBytes(32).toString('hex')
  mkdirSync(axelConfigDir, { recursive: true })
  writeFileSync(axelConfigPath, JSON.stringify(axelConfig, null, 2), { mode: 0o600 })
}

// ── Environment setup ─────────────────────────────────────────────────────────
// SESSION_SECRET: use the persisted one unless the user explicitly overrode it
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me') {
  process.env.SESSION_SECRET = axelConfig.sessionSecret
}

// WORKSPACE_ROOT: default to cwd so `cd myproject && npx axel` just works
if (!process.env.WORKSPACE_ROOT && !process.env.PROJECTS_DIR) {
  process.env.WORKSPACE_ROOT = process.cwd()
}

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
if (portFlag !== -1 && args[portFlag + 1]) {
  process.env.PORT = args[portFlag + 1]
}
const rootFlag = args.indexOf('--root')
if (rootFlag !== -1 && args[rootFlag + 1]) {
  process.env.WORKSPACE_ROOT = path.resolve(args[rootFlag + 1])
}

const port = process.env.PORT ?? '8080'
const url = `http://localhost:${port}`

// ── Start server ──────────────────────────────────────────────────────────────
console.log(`\n  axel starting on ${url}\n`)

const server = spawn(process.execPath, [serverDist], {
  env: process.env,
  stdio: 'inherit',
})

// Open browser once server is ready (give it 1.5s to bind)
setTimeout(() => {
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
}, 1500)

server.on('exit', code => process.exit(code ?? 0))
process.on('SIGINT', () => server.kill('SIGINT'))
process.on('SIGTERM', () => server.kill('SIGTERM'))
