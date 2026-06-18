import fs from 'fs'
import path from 'path'

// Resolve to a real path so symlinks can't smuggle a path outside a root.
// Falls back to the absolute path when the target doesn't exist yet.
export function tryRealpath(p: string): string {
  const abs = path.resolve(p)
  try { return fs.realpathSync(abs) } catch { return abs }
}

export function isPathUnder(target: string, roots: Array<string>): boolean {
  const resolved = tryRealpath(target)
  return roots
    .map(tryRealpath)
    .some(root => resolved === root || resolved.startsWith(root + path.sep))
}
