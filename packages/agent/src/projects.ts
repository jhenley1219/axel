import { readdir } from 'fs/promises'

export const IGNORED_DIRS = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', 'target'])

// Immediate non-hidden project subdirectories of `dir`, sorted by name.
export async function listProjects(dir: string): Promise<Array<string>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}
