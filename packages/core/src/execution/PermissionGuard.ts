import { DENIED_PATTERNS } from '../constants/permissions.js'
import { isPathUnder, tryRealpath } from './isPathUnder.js'

export type GuardResult = { ok: true } | { ok: false; reason: string }

export class PermissionGuard {
  private resolvedDirs: string[]

  constructor(
    allowedDirs: string[],
    private deniedPatterns: RegExp[] = DENIED_PATTERNS,
  ) {
    this.resolvedDirs = allowedDirs.map(tryRealpath)
  }

  check(toolName: string, input: unknown): GuardResult {
    if (toolName === 'bash') {
      const cmd = (input as { command: string }).command
      for (const pattern of this.deniedPatterns) {
        if (pattern.test(cmd)) {
          return { ok: false, reason: `Blocked pattern: ${pattern.source}` }
        }
      }
    }

    if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
      const filePath = (input as { file_path: string }).file_path
      if (!this.isPathAllowed(filePath)) {
        return { ok: false, reason: `Path outside allowlist: ${filePath}` }
      }
    }

    return { ok: true }
  }

  isPathAllowed(filePath: string): boolean {
    return isPathUnder(filePath, this.resolvedDirs)
  }

  // Exposed for re-checking inside dispatch after mkdir (H-1 TOCTOU mitigation)
  tryResolve(filePath: string): string {
    return tryRealpath(filePath)
  }
}
