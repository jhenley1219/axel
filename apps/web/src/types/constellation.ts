import type { FileEntry } from '@axel/core'

export type FileType = 'code' | 'config' | 'docs' | 'style' | 'html' | 'data'

export const FILE_TYPE_COLORS: Record<FileType, string> = {
  code:   '#c9ff2e',
  config: '#ff6a1a',
  docs:   '#33ffe0',
  style:  '#ff2f86',
  html:   '#9b8cff',
  data:   '#7adf9b',
}

// ext → FileType
const EXT_MAP: Record<string, FileType> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', py: 'code', rs: 'code',
  go: 'code', java: 'code', rb: 'code', cpp: 'code', c: 'code', cs: 'code',
  json: 'config', toml: 'config', yaml: 'config', yml: 'config', lock: 'config',
  env: 'config', rc: 'config',
  md: 'docs', txt: 'docs', rst: 'docs',
  css: 'style', scss: 'style', sass: 'style', svg: 'style', png: 'style', jpg: 'style',
  html: 'html', htm: 'html',
  csv: 'data', db: 'data', sql: 'data',
}

export function langToFileType(lang?: string): FileType {
  if (!lang) return 'code'
  const l = lang.toLowerCase()
  if (['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'ruby', 'c', 'cpp'].includes(l)) return 'code'
  if (['json', 'toml', 'yaml', 'env', 'astro'].includes(l)) return 'config'
  if (['markdown', 'text'].includes(l)) return 'docs'
  if (['css', 'scss', 'sass'].includes(l)) return 'style'
  if (['html'].includes(l)) return 'html'
  if (['sql', 'csv'].includes(l)) return 'data'
  return 'code'
}

export function extToFileType(ext: string): FileType {
  return EXT_MAP[ext.replace('.', '').toLowerCase()] ?? 'code'
}

export type FsNode = {
  id: string
  name: string
  kind: 'file' | 'dir'
  path: string
  fileType?: FileType
  children?: Array<string>
  files?: Array<FileEntry>
  dominantType?: FileType
  fileCount?: number
}

export type OpenSystem = {
  dirId: string
  parentSystemId?: string
  sessions: Array<string>
  // True while the close animation (ring shrinks back to a rim dot) is running;
  // the system is removed from state when the engine reports the tween done.
  closing?: boolean
}

export type Session = {
  id: string
  systemId: string
  targetPath: string
  // Which terminal of the dir this session is — 'main' is the default the
  // voice loop and root delegation talk to; extra tabs get generated ids.
  term: string
  verb: string
  lines: Array<{ who: 'you' | 'axle' | 'sys' | 'out' | 'ok'; t: string }>
  // Present once the server emits `pty_ready` for this (target, term). When
  // set, SessionWin renders an xterm.js view bound to /agent/pty/<spawnId>
  // instead of the legacy line buffer.
  spawnId?: string
}

export type ToolNode = {
  id: string
  name: string
  description?: string
  accent: string
  activeUntil?: number
}

export type OrbTarget =
  | { type: 'system'; systemId: string }
  // Spec §3.3 targeting — orb travels to a resting dot; the open fires on arrival
  | { type: 'dot';    systemId: string; dirId: string }
  | { type: 'home' }
