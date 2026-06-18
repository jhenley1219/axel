import type { Tier } from './promptTiers.js'

export type PolicyDecision = 'allow' | 'deny' | 'ask'

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep'])
const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

// Patterns that should never run on a quantized-local tier without explicit
// user gating — irreversible destruction, raw block writes, filesystem
// formatting, remote-fetched scripts piped to a shell, and sudo escalation.
const BASH_DENYLIST: Array<RegExp> = [
  /\brm\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/,
  />\s*\/dev\//,
  /\bsudo\b/,
]

const isBashDenied = (input: unknown): boolean => {
  const cmd = (input as { command?: unknown })?.command
  if (typeof cmd !== 'string') return false
  return BASH_DENYLIST.some(re => re.test(cmd))
}

const hasReason = (input: unknown): boolean => {
  const reason = (input as { reason?: unknown })?.reason
  return typeof reason === 'string' && reason.length >= 10
}

export const applyTierPolicy = (tier: Tier, toolName: string, input: unknown): PolicyDecision => {
  switch (tier) {
    case 'frontier':
      return 'ask'
    case 'mid':
      return READ_ONLY_TOOLS.has(toolName) ? 'allow' : 'ask'
    case 'q4-local':
      if (toolName === 'bash' && isBashDenied(input)) return 'deny'
      return 'ask'
    case 'q2-local':
      if (toolName === 'bash') return 'deny'
      if (WRITE_TOOLS.has(toolName)) return hasReason(input) ? 'ask' : 'deny'
      if (READ_ONLY_TOOLS.has(toolName)) return 'ask'
      return 'ask'
  }
}
