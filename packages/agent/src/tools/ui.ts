import { resolve } from 'node:path'
import { isPathUnder } from '@axel/core'
import type { Tool, ToolContext, ToolResult } from './Tool.js'
import type { ToolRegistry } from './registry.js'

const outsideErr = (p: string): ToolResult => ({ ok: false, error: `path outside allowed dirs: ${p}` })

const resolveSandboxed = (input: string, ctx: ToolContext): string | null => {
  const abs = resolve(ctx.cwd, input)
  return isPathUnder(abs, ctx.allowedDirs) ? abs : null
}

export const openFileInUI: Tool = {
  name: 'open_file_in_ui',
  description:
    'Open a file in the Axel constellation UI so the user can VIEW it visually. Use this only when the user wants the file displayed on their screen — "open the file", "show me the file in the editor", "pop it up in my UI". Do NOT use it merely to read, print, cat, or learn what a file says or contains — that is read_file. open_file_in_ui makes the file appear in the user\'s window; it returns no contents.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
    },
  },
  async execute(input: { path: string }, ctx): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    ctx.emitEvent?.({ type: 'ui_open_file', path: abs })
    return { ok: true, output: `Opened ${abs} in the UI.` }
  },
}

export const openDirInUI: Tool = {
  name: 'open_dir_in_ui',
  description:
    'Open a directory (project) in the Axel constellation UI so the user can SEE it as a system ring. Use this only when the user wants the directory displayed visually — "open the directory", "show me the project", "in my UI/sidebar/file tree". Do NOT use it merely to find out what a directory contains or to list its entries — that is list_dir. open_dir_in_ui makes the directory appear as a visual system in the user\'s window; it returns no contents.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Absolute path to the directory' },
    },
  },
  async execute(input: { path: string }, ctx): Promise<ToolResult> {
    const abs = resolveSandboxed(input.path, ctx)
    if (!abs) return outsideErr(input.path)
    ctx.emitEvent?.({ type: 'ui_open_dir', path: abs })
    return { ok: true, output: `Opened ${abs} in the UI.` }
  },
}

export const registerUITools = (registry: ToolRegistry): void => {
  registry.register(openFileInUI)
  registry.register(openDirInUI)
}
