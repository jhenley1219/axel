import { readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import path from 'node:path'

export const IGNORED_DIRS = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', 'target', 'dev_modules'])

// Files/dirs whose presence marks a directory as a project ROOT (a thing a user
// would open), as opposed to a plain folder or a project's internal subdir.
const PROJECT_MARKERS = new Set([
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'Gemfile', 'composer.json', 'requirements.txt', 'setup.py',
  'CMakeLists.txt', '.hg', '.svn',
])

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

const isProjectRoot = (entries: Array<Dirent>): boolean => entries.some(e => PROJECT_MARKERS.has(e.name))

// Discover openable projects anywhere under `root`, returned as POSIX-relative
// paths. Users group repos in folders (clients/acme-web-app, …), so the
// dir a user names is frequently nested. Rather than guess a fixed depth or
// denylist build dirs, this finds the TOPMOST project root in each branch — a
// directory holding a marker (.git, package.json, …) — and stops there, so a
// project's internal folders (out, src, node_modules) are never mistaken for
// projects. Plain "group" folders that merely contain projects (and every
// top-level dir) are also returned so the user can open them too.
export async function findProjects(root: string, maxDepth = 6): Promise<Array<string>> {
  const out = new Set<string>()

  // Returns whether the subtree rooted at `abs` contained any project, so a
  // parent can decide whether it is a "group" folder worth surfacing.
  const walk = async (abs: string, rel: string, depth: number, entries: Array<Dirent>): Promise<boolean> => {
    let subtreeHasProject = false
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue
      const childAbs = path.join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      let childEntries: Array<Dirent>
      try {
        childEntries = await readdir(childAbs, { withFileTypes: true })
      } catch {
        continue
      }
      if (isProjectRoot(childEntries)) {
        out.add(childRel)            // project root — do NOT descend into its guts
        subtreeHasProject = true
        continue
      }
      const childHasProject = depth < maxDepth && await walk(childAbs, childRel, depth + 1, childEntries)
      if (childHasProject || depth === 1) out.add(childRel)  // a group folder, or any top-level dir
      if (childHasProject) subtreeHasProject = true
    }
    return subtreeHasProject
  }

  let rootEntries: Array<Dirent>
  try {
    rootEntries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  await walk(root, '', 1, rootEntries)
  return [...out].sort((a, b) => a.localeCompare(b))
}
