import { spawn } from 'node:child_process'
import { isPathUnder } from '@axel/core'
import type { Tool, ToolContext, ToolResult } from './Tool.js'
import type { ToolRegistry } from './registry.js'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const MAX_CAPTURE_BYTES = 32 * 1024

type BashInput = {
  command: string
  cwd?: string
  timeout_ms?: number
}

const capped = (buf: string, chunk: string): string => {
  if (buf.length >= MAX_CAPTURE_BYTES) return buf
  const next = buf + chunk
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(0, MAX_CAPTURE_BYTES)
}

const execute = async (input: BashInput, ctx: ToolContext): Promise<ToolResult> => {
  const cwd = input.cwd ?? ctx.cwd
  if (!isPathUnder(cwd, ctx.allowedDirs)) {
    return { ok: false, error: `cwd not under allowedDirs: ${cwd}` }
  }

  const requested = typeof input.timeout_ms === 'number' ? input.timeout_ms : DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(Math.max(requested, 0), MAX_TIMEOUT_MS)

  const proc = spawn('bash', ['-c', input.command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let aborted = false

  proc.stdout.on('data', (chunk: Buffer) => { stdout = capped(stdout, chunk.toString()) })
  proc.stderr.on('data', (chunk: Buffer) => { stderr = capped(stderr, chunk.toString()) })

  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)

  const onAbort = (): void => { aborted = true; proc.kill('SIGKILL') }
  ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

  const code: number | null = await new Promise(resolve => {
    proc.on('close', c => resolve(c))
    proc.on('error', () => resolve(-1))
  })

  clearTimeout(timer)
  ctx.abortSignal?.removeEventListener('abort', onAbort)

  if (aborted) return { ok: false, error: 'aborted' }
  if (timedOut) return { ok: false, error: `timeout after ${timeoutMs}ms` }

  if (code === 0) {
    return { ok: true, output: stdout + (stderr ? '\n--STDERR--\n' + stderr : '') }
  }
  return { ok: false, error: 'exit ' + code + ': ' + (stderr.trim() || '<no stderr>') }
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command with bounded timeout. Use for real shell work (git, node, build/test commands, process info). Do NOT reach for bash to list a directory (use list_dir), read a file (use read_file), search file contents (use grep), or find files by name (use glob) — those dedicated tools are preferred even when the user phrases it as a shell command like "ls" or "cat".',
  inputSchema: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeout_ms: { type: 'number' },
    },
  },
  execute,
}

export const registerBashTool = (registry: ToolRegistry): void => {
  registry.register(bashTool)
}
