export type { Tool, ToolContext, ToolResult } from './Tool.js'
export { ToolRegistry } from './registry.js'
export { readFile, writeFile, editFile, listDir, glob, grep, registerFileTools } from './files.js'
export { bashTool, registerBashTool } from './bash.js'
export { openFileInUI, openDirInUI, registerUITools } from './ui.js'

import { ToolRegistry } from './registry.js'
import { registerFileTools } from './files.js'
import { registerBashTool } from './bash.js'
import { registerUITools } from './ui.js'

export const buildDefaultRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry()
  registerFileTools(registry)
  registerBashTool(registry)
  registerUITools(registry)
  return registry
}
