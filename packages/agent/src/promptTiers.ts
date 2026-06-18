export type Tier = 'frontier' | 'mid' | 'q4-local' | 'q2-local'

const TIER_PREFIX: Record<Tier, string> = {
  frontier: '',
  mid: 'Before any multi-file edit, state a brief plan. Confirm once before destructive operations (file deletes, recursive removes, global installs).',
  'q4-local': 'Restate the user\'s goal in one sentence before acting. Use absolute file paths only — never reference "the file we just edited" or other implicit antecedents. Emit any list of files or actions as JSON. Confirm before each file write. Run no shell command outside the explicit allowlist without re-asking.',
  'q2-local': 'Restate the user\'s goal in one sentence and list your uncertainties before any tool call. Take exactly one step per turn. Use absolute file paths only; if you do not know a path, ask. Emit all structured output as JSON.',
}

const UI_OPEN_NUDGE = 'To open a file or directory in the user\'s UI, call open_file_in_ui or open_dir_in_ui — these make it appear visually. Use read_file/list_dir only when you need the contents to reason.'

const TIER_SUFFIX: Record<Tier, string> = {
  frontier: UI_OPEN_NUDGE,
  mid: `If the user's request is ambiguous, ask one clarifying question before acting. ${UI_OPEN_NUDGE}`,
  'q4-local': `If you do not know the absolute path of a file, ASK before reading or writing. Do not invent paths, commands, or APIs. Return all multi-item outputs as JSON arrays. ${UI_OPEN_NUDGE}`,
  'q2-local': `Confirmation is required for every tool call. Do not chain steps. If a file path was not given to you in this turn, do not act on it — ask. Return all output as JSON. ${UI_OPEN_NUDGE}`,
}

export const composeSystemPrompt = (base: string, tier: Tier): string => {
  return [TIER_PREFIX[tier], base, TIER_SUFFIX[tier]].filter(s => s.length > 0).join('\n\n')
}
