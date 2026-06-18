import { watch, type FSWatcher } from 'fs'
import { readdir } from 'fs/promises'
import path from 'path'
import { IGNORED_DIRS } from '@axel/agent'

// Watches the projects root (recursively) and fires `onChange` whenever the SET
// of directories under it changes — i.e. a directory was created or removed by
// the user or an agent. It deliberately ignores plain file edits: the trigger
// is "the number/identity of directories changed", matching the constellation
// ring's model (it renders directories, not file writes).
//
// Implementation: a recursive fs.watch raises an event on any change; we debounce
// a burst of events, then re-scan the directory set and diff it against the last
// snapshot. Only a real add/remove of a directory fires the callback. Re-scans
// skip IGNORED_DIRS (node_modules, .git, dist, …) so churn inside build output
// never triggers a refresh and large trees stay cheap to walk.

const DEBOUNCE_MS = 300

// Walk the tree under `root`, collecting every directory path. Hidden dirs and
// IGNORED_DIRS are pruned (not descended into) to keep the scan light.
async function scanDirSet(root: string): Promise<Set<string>> {
  const found = new Set<string>()

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // dir vanished mid-walk or is unreadable — skip it
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (ent.name.startsWith('.') || IGNORED_DIRS.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      found.add(full)
      await walk(full)
    }
  }

  await walk(root)
  return found
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// Start watching. Returns a stop() function that tears down the watcher.
export function startProjectsWatcher(root: string, onChange: () => void): () => void {
  let snapshot = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  let closed = false

  // Re-scan after a burst settles; fire onChange only if the dir set changed.
  const settle = (): void => {
    timer = null
    scanDirSet(root)
      .then(next => {
        if (closed) return
        if (!sameSet(snapshot, next)) {
          snapshot = next
          onChange()
        }
      })
      .catch(() => {})
  }

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(settle, DEBOUNCE_MS)
  }

  // Seed the baseline snapshot, then attach the recursive watcher.
  scanDirSet(root)
    .then(initial => {
      if (closed) return
      snapshot = initial
      try {
        watcher = watch(root, { recursive: true }, () => schedule())
        watcher.on('error', () => {})
      } catch (err) {
        console.error('[projects-watcher] failed to watch', root, err)
      }
    })
    .catch(() => {})

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
