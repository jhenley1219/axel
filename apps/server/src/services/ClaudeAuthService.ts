import { execSync, spawn } from 'child_process'
import { existsSync, unlinkSync, readFileSync, writeFileSync, readdirSync, copyFileSync, chownSync } from 'fs'
import path, { resolve } from 'path'
import { isPathUnder, spawnEnv } from '@axel/core'
import type { ClaudeAuthState } from '@axel/core'

type ClaudeConfig = {
  oauthAccount?: { accountUuid?: string; emailAddress?: string } | null
  claudeAiOauth?: { accessToken?: string } | null
}

type ClaudeAuthStatus = { loggedIn?: boolean; email?: string; authMethod?: string; apiProvider?: string }

export type StartOauthResult =
  | { status: 'url'; url: string; port: number }
  | { status: 'pending' }
  | { status: 'error'; code: 'oauth_script_missing' | 'spawn_error' | 'exited' | 'timeout'; detail?: string }

const SESSION_TTL_MS = 6 * 60 * 1000
const START_TIMEOUT_MS = 35000

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Owns the claude CLI auth lifecycle: reading credential state from
// ~/.claude.json, driving the PTY-based OAuth flow (one in-flight session at
// a time), logout, and backup restore.
export class ClaudeAuthService {
  private proc: ReturnType<typeof spawn> | null = null
  private callbackPort: number | null = null
  private loginUrl: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private cfg: { pythonPath: string; pythonScriptDir: string; claudeBin: string }) {}

  get configPath(): string {
    return path.join(process.env.HOME ?? '/home/axel', '.claude.json')
  }

  private get scriptPath(): string {
    return path.join(this.cfg.pythonScriptDir, 'claude_oauth.py')
  }

  isActive(): boolean { return this.proc !== null }

  cleanup(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.proc) { try { this.proc.kill() } catch { /* ignore */ }; this.proc = null }
    this.callbackPort = null
    this.loginUrl = null
  }

  readAuth(): ClaudeAuthState {
    // Authoritative: ask claude itself. Falls back to reading .claude.json
    // (for the baked-credentials path during container boot).
    try {
      const out = execSync(`${this.cfg.claudeBin} auth status --json`, {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const s = JSON.parse(out) as ClaudeAuthStatus
      if (s.loggedIn) return { loggedIn: true, email: s.email }
      return { loggedIn: false }
    } catch { /* claude binary missing / errored — fall through */ }

    try {
      const raw = readFileSync(this.configPath, 'utf8')
      const cfg = JSON.parse(raw) as ClaudeConfig
      if (cfg.oauthAccount?.accountUuid) {
        return { loggedIn: true, email: cfg.oauthAccount.emailAddress }
      }
      return { loggedIn: false }
    } catch {
      return { loggedIn: false }
    }
  }

  status(): ClaudeAuthState {
    try {
      const cfg = JSON.parse(readFileSync(this.configPath, 'utf8')) as Record<string, unknown>
      const setKeys = Object.keys(cfg).filter(k => Boolean(cfg[k]))
      console.log('[claude-status] config keys set:', setKeys.join(', '))
    } catch { /* file missing */ }
    return this.readAuth()
  }

  checkEnv(): Record<string, unknown> {
    try {
      const pyVer = execSync(`${this.cfg.pythonPath} --version 2>&1`, { encoding: 'utf8' }).trim()
      return {
        python: pyVer,
        scriptExists: existsSync(this.scriptPath),
        script: this.scriptPath,
        claudeExists: existsSync(this.cfg.claudeBin),
        claudeBin: this.cfg.claudeBin,
        home: process.env.HOME,
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  private spawnOauthScript(stdin: 'pipe' | 'ignore'): ReturnType<typeof spawn> {
    return spawn(this.cfg.pythonPath, [this.scriptPath], {
      cwd: '/tmp',
      env: spawnEnv({ TERM: 'xterm-256color', CLAUDE_PATH: this.cfg.claudeBin }),
      stdio: [stdin, 'pipe', 'pipe'],
    })
  }

  // Debug endpoint helper: run the PTY script for 90s and capture raw output.
  ptyTest(): Promise<{ stdout: string; stderr: string }> {
    return new Promise(resolvePromise => {
      const proc = this.spawnOauthScript('ignore')
      let out = '', err = ''
      proc.stdout?.on('data', (c: Buffer) => { out += c.toString() })
      proc.stderr?.on('data', (c: Buffer) => { err += c.toString() })
      setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        resolvePromise({ stdout: out, stderr: err.slice(-5000) })
      }, 90000)
    })
  }

  // Runs claude_oauth.py which spawns claude in a pseudo-TTY, sends /login,
  // and captures the OAuth URL. Keeps the proc alive so the callback port
  // stays open. Idempotent: a second call while a session is in flight
  // returns the existing URL (or pending) instead of restarting — rapid
  // re-clicks would otherwise SIGTERM the python proc before it can flush
  // the URL line on stdout.
  startOauth(): Promise<StartOauthResult> {
    if (this.isActive()) {
      if (this.loginUrl) {
        return Promise.resolve({ status: 'url', url: this.loginUrl, port: this.callbackPort ?? 0 })
      }
      return Promise.resolve({ status: 'pending' })
    }

    if (!existsSync(this.scriptPath)) {
      return Promise.resolve({ status: 'error', code: 'oauth_script_missing', detail: this.scriptPath })
    }

    return new Promise(resolvePromise => {
      const proc = this.spawnOauthScript('pipe')  // stdin pipe so we can send the auth code
      this.proc = proc

      let settled = false
      const settle = (result: StartOauthResult) => {
        if (settled) return
        settled = true
        resolvePromise(result)
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        console.log(`[start-oauth] stdout chunk received (${chunk.length} bytes)`)
        for (const line of text.split('\n')) {
          if (line.startsWith('URL:')) {
            const url = line.slice(4).trim()
            if (url.startsWith('https://')) {
              // Redact any code= or token= query params before logging
              const safeUrl = url.replace(/([?&])(code|token)=[^&]*/gi, '$1$2=[redacted]')
              console.log('[start-oauth] auth URL received:', safeUrl)
              this.loginUrl = url
              this.callbackPort = 0
              this.timer = setTimeout(() => this.cleanup(), SESSION_TTL_MS)
              settle({ status: 'url', url, port: 0 })
            } else {
              console.log('[start-oauth] ignoring bad URL line (not https)')
            }
          }
          if (line.startsWith('DONE:')) {
            console.log('[start-oauth] auth complete via polling')
            this.cleanup()
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        console.log(`[start-oauth] stderr chunk received (${chunk.length} bytes)`)
      })

      proc.on('error', err => settle({ status: 'error', code: 'spawn_error', detail: err.message }))
      proc.on('close', code => settle({ status: 'error', code: 'exited', detail: `script exited ${code} without URL` }))

      setTimeout(() => settle({ status: 'error', code: 'timeout' }), START_TIMEOUT_MS)
    })
  }

  // Relays the pasted authorization code to claude's PTY (which is waiting at
  // "Paste code here if prompted>"), then polls until credentials appear.
  async completeOauth(code: string): Promise<{ ok: false; error: string } | ({ ok: true } & ClaudeAuthState)> {
    if (!this.proc?.stdin) {
      return { ok: false, error: 'no_active_oauth_session' }
    }

    console.log('[complete-oauth] sending code to claude PTY via python script stdin')
    this.proc.stdin.write(code.trim() + '\n')

    for (let attempts = 0; attempts < 20; attempts++) {
      await delay(1000)
      const auth = this.readAuth()
      if (auth.loggedIn) {
        this.cleanup()
        return { ok: true, ...auth }
      }
    }
    this.cleanup()
    return { ok: true, ...this.readAuth() }
  }

  logout(): void {
    const cfgPath = this.configPath
    if (!existsSync(cfgPath)) return
    try {
      const raw = readFileSync(cfgPath, 'utf8')
      const cfg = JSON.parse(raw) as ClaudeConfig
      cfg.oauthAccount = null
      cfg.claudeAiOauth = null
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    } catch {
      try { unlinkSync(cfgPath) } catch { /* ignore */ }
    }
  }

  restoreBackup(): ({ ok: true; restoredFrom: string } & ClaudeAuthState) | { ok: false; error: string } {
    const backupDir = path.join(process.env.HOME ?? '/home/axel', '.claude', 'backups')
    try {
      // Use Node.js fs APIs instead of shell commands to avoid injection
      const backups = readdirSync(backupDir)
        .filter(f => f.startsWith('.claude.json.backup.'))
        .sort()
      const latest = backups[backups.length - 1]
      if (!latest) return { ok: false, error: 'no_backup_found' }

      // Validate no path traversal in the filename before joining
      const resolvedSource = resolve(backupDir, latest)
      if (!isPathUnder(resolvedSource, [backupDir])) {
        return { ok: false, error: 'invalid_backup_path' }
      }

      copyFileSync(resolvedSource, this.configPath)
      // Adjust ownership to the current process uid/gid (no-op on Windows)
      if (process.getuid && process.getgid) {
        chownSync(this.configPath, process.getuid!(), process.getgid!())
      }
      return { ok: true, restoredFrom: latest, ...this.readAuth() }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }
}
