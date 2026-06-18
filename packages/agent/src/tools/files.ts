import { spawn } from 'node:child_process'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isPathUnder } from '@axel/core'
import type { Tool, ToolContext, ToolResult } from './Tool.js'
import type { ToolRegistry } from './registry.js'

const READ_CAP = 256 * 1024
const GREP_CAP = 8 * 1024
const GLOB_MAX_ENTRIES = 5000

const outsideErr = (p: string): ToolResult => ({ ok: false, error: `path outside allowed dirs: ${p}` })

const resolveSandboxed = (input: string, ctx: ToolContext): string | null => {
  const abs = resolve(ctx.cwd, input)
  return isPathUnder(abs, ctx.allowedDirs) ? abs : null
}

export const readFile: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file. Output is capped at 256KB; longer files are truncated with a "[truncated]" marker.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input: { path: string }, ctx): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    try {
      const buf = await fsReadFile(abs)
      if (buf.byteLength > READ_CAP) {
        return { ok: true, output: buf.subarray(0, READ_CAP).toString('utf8') + '\n[truncated]' }
      }
      return { ok: true, output: buf.toString('utf8') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}

export const writeFile: Tool = {
  name: 'write_file',
  description: 'Write UTF-8 content to a file, creating parent directories as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(input: { path: string; content: string }, ctx): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    try {
      await mkdir(dirname(abs), { recursive: true })
      await fsWriteFile(abs, input.content, 'utf8')
      return { ok: true, output: `wrote ${input.content.length} chars to ${abs}` }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}

export const editFile: Tool = {
  name: 'edit_file',
  description: 'Replace old_string with new_string in a file. Fails if old_string is not unique unless replace_all is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(
    input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ctx,
  ): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    try {
      const original = await fsReadFile(abs, 'utf8')
      if (input.replace_all) {
        const parts = original.split(input.old_string)
        const updated = parts.join(input.new_string)
        await fsWriteFile(abs, updated, 'utf8')
        return { ok: true, output: `replaced ${parts.length - 1} occurrence(s) in ${abs}` }
      }
      const first = original.indexOf(input.old_string)
      if (first === -1) return { ok: false, error: 'old_string not found' }
      const second = original.indexOf(input.old_string, first + input.old_string.length)
      if (second !== -1) return { ok: false, error: 'old_string not unique' }
      const updated = original.slice(0, first) + input.new_string + original.slice(first + input.old_string.length)
      await fsWriteFile(abs, updated, 'utf8')
      return { ok: true, output: `edited ${abs}` }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}

export const listDir: Tool = {
  name: 'list_dir',
  description: 'List entries of a directory. Each line is "<type>\\t<name>" where type is "file" or "dir".',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input: { path: string }, ctx): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      const lines = entries
        .map(e => `${e.isDirectory() ? 'dir' : 'file'}\t${e.name}`)
        .sort()
      return { ok: true, output: lines.join('\n') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}

const globToRegex = (pattern: string): RegExp => {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      const next = pattern[i + 2]
      if (next === '/') { out += '(?:.*/)?'; i += 3 } else { out += '.*'; i += 2 }
    } else if (c === '*') {
      out += '[^/]*'; i += 1
    } else if (c === '?') {
      out += '[^/]'; i += 1
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      out += '\\' + c; i += 1
    } else {
      out += c; i += 1
    }
  }
  out += '$'
  return new RegExp(out)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', 'target'])

const walk = async (root: string, rel: string, re: RegExp, hits: Array<string>): Promise<void> => {
  if (hits.length >= GLOB_MAX_ENTRIES) return
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch { return }
  for (const e of entries) {
    if (hits.length >= GLOB_MAX_ENTRIES) return
    const relChild = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await walk(root, relChild, re, hits)
    } else if (e.isFile()) {
      if (re.test(relChild)) hits.push(relChild)
    }
  }
}

export const glob: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern (supports *, **, ?). Returns one relative path per line.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      root: { type: 'string' },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; root?: string }, ctx): Promise<ToolResult> {
    const rootInput = input.root ?? ctx.cwd
    const abs = resolveSandboxed(rootInput, ctx)
    if (!abs) return outsideErr(rootInput)
    const re = globToRegex(input.pattern)
    const hits: Array<string> = []
    await walk(abs, '', re, hits)
    return { ok: true, output: hits.join('\n') }
  },
}

const hasBin = async (bin: string): Promise<boolean> => new Promise(resolveP => {
  const p = spawn('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
  p.on('close', code => resolveP(code === 0))
  p.on('error', () => resolveP(false))
})

export const grep: Tool = {
  name: 'grep',
  description: 'Search for a pattern in files. Uses ripgrep if available, otherwise grep. Output capped at 8KB.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      regex: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; path?: string; regex?: boolean }, ctx): Promise<ToolResult> {
    const target = input.path ?? ctx.cwd
    const abs = resolveSandboxed(target, ctx)
    if (!abs) return outsideErr(target)

    let targetIsDir = false
    try { targetIsDir = (await stat(abs)).isDirectory() } catch { /* let the tool error naturally */ }

    const useRg = await hasBin('rg')
    const bin = useRg ? 'rg' : 'grep'
    const args: Array<string> = []
    if (useRg) {
      if (!input.regex) args.push('-F')
      args.push('--no-heading', '-n', '--')
      args.push(input.pattern, abs)
    } else {
      args.push('-n')
      if (!input.regex) args.push('-F')
      if (targetIsDir) args.push('-r')
      args.push('--', input.pattern, abs)
    }

    return new Promise<ToolResult>(resolveP => {
      const p = spawn(bin, args, { signal: ctx.abortSignal })
      let out = ''
      let truncated = false
      p.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return
        out += chunk.toString('utf8')
        if (out.length > GREP_CAP) {
          out = out.slice(0, GREP_CAP) + '\n[truncated]'
          truncated = true
          p.kill()
        }
      })
      p.on('error', e => resolveP({ ok: false, error: (e as Error).message }))
      p.on('close', code => {
        // grep/rg exit 1 = no matches; not an error
        if (code === 0 || code === 1 || truncated) resolveP({ ok: true, output: out.trimEnd() })
        else resolveP({ ok: false, error: `${bin} exited with code ${code}` })
      })
    })
  },
}

export const registerFileTools = (registry: ToolRegistry): void => {
  registry.register(readFile)
  registry.register(writeFile)
  registry.register(editFile)
  registry.register(listDir)
  registry.register(glob)
  registry.register(grep)
}
