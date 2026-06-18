import type { Tool } from './Tool.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(t: Tool): void {
    this.tools.set(t.name, t)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Array<Tool> {
    return Array.from(this.tools.values())
  }
}
