// Reads a sub-terminal's COMPLETE conversation from Claude Code's own
// persisted JSONL transcript. Each interactive `claude` PTY writes one
// append-only session file at ~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl;
// controlling the session id at spawn (PtyAgent's --session-id / --resume) makes
// that path deterministic, so the root agent can read the full, clean, ordered
// conversation on demand — mid-turn (file is appended live), after the PTY dies
// (file persists), and free of the xterm TUI framebuffer noise that `peek()`
// returns. This is the authoritative source behind read_terminal.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Claude Code names a project's transcript dir by replacing every
// non-alphanumeric run in the absolute cwd with '-'. Verified against on-disk
// dirs (e.g. /Users/.../my-app → -Users-...-my-app).
export const slugForCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

// Claude Code writes transcripts under its config dir, which honors
// CLAUDE_CONFIG_DIR (the PTY inherits it via spawnEnv) and falls back to
// ~/.claude. AXEL_CLAUDE_PROJECTS_ROOT overrides everything for tests / relocation.
export const defaultProjectsRoot = (): string => {
  if (process.env.AXEL_CLAUDE_PROJECTS_ROOT) return process.env.AXEL_CLAUDE_PROJECTS_ROOT
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects')
}

export const transcriptPath = (cwd: string, sessionId: string, projectsRoot?: string): string =>
  join(projectsRoot ?? defaultProjectsRoot(), slugForCwd(cwd), `${sessionId}.jsonl`)

export type ReadTranscriptArgs = {
  cwd: string
  // The terminal's session-id chain, oldest → newest. Usually one id; more than
  // one only when a dead PTY was resumed into a forked session.
  sessionIds: Array<string>
  projectsRoot?: string
  // Cap the returned text, keeping the most recent chars. Protects the root
  // agent's context on very long conversations — the full file still exists, so
  // the caller can page. Omit for the entire conversation.
  maxChars?: number
}

const TOOL_INPUT_MAX = 200
const TOOL_RESULT_MAX = 600

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s

const compactInput = (input: unknown): string => {
  if (input == null) return ''
  try {
    return truncate(JSON.stringify(input), TOOL_INPUT_MAX)
  } catch {
    return ''
  }
}

// A tool_result's content is a string or an array of {type:'text',text}.
const renderToolResult = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(p => (p && typeof p === 'object' && (p as { text?: unknown }).text ? String((p as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

type TranscriptRecord = {
  type?: string
  message?: { role?: string; content?: unknown }
}

// Flatten one JSONL record into a readable line, or null for meta/empty records.
const renderRecord = (rec: TranscriptRecord): string | null => {
  const type = rec?.type
  if (type !== 'user' && type !== 'assistant') return null
  const content = rec?.message?.content
  if (typeof content === 'string') {
    const t = content.trim()
    return t ? `${type}: ${t}` : null
  }
  if (!Array.isArray(content)) return null
  const chunks: Array<string> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }
    if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text)
    else if (p.type === 'tool_use') chunks.push(`[tool: ${p.name ?? '?'} ${compactInput(p.input)}]`.trim())
    else if (p.type === 'tool_result') chunks.push(`[result: ${truncate(renderToolResult(p.content).trim(), TOOL_RESULT_MAX)}]`)
  }
  const body = chunks.join('\n').trim()
  return body ? `${type}: ${body}` : null
}

// Read + flatten the whole session-id chain into one clean transcript. Missing
// or unreadable files are skipped (a terminal may not have written yet), so this
// never throws — it returns '' when there's nothing to show, and the caller
// falls back to the live peek/summary sources.
export const readClaudeTranscript = (args: ReadTranscriptArgs): string => {
  const parts: Array<string> = []
  for (const id of args.sessionIds) {
    let raw: string
    try {
      raw = readFileSync(transcriptPath(args.cwd, id, args.projectsRoot), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: TranscriptRecord
      try {
        rec = JSON.parse(trimmed) as TranscriptRecord
      } catch {
        continue
      }
      const rendered = renderRecord(rec)
      if (rendered) parts.push(rendered)
    }
  }
  const text = parts.join('\n').trim()
  const cap = args.maxChars
  if (cap && text.length > cap) {
    const dropped = text.length - cap
    return `[…${dropped} earlier chars truncated — read a specific term or narrow the range for more…]\n${text.slice(-cap)}`
  }
  return text
}
