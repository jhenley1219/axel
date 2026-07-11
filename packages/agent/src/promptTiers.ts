export type Tier = 'frontier' | 'mid' | 'q4-local' | 'q2-local'

// IMPORTANT: never instruct local tiers to "emit output as JSON". They take it
// literally and print the tool call as text instead of using the native
// tool-call channel — which is the only thing that actually executes. Tier
// guidance must reinforce CALLING tools, not describing them.
const TIER_PREFIX: Record<Tier, string> = {
  frontier: '',
  mid: 'Before any multi-file edit, state a brief plan. Confirm once before destructive operations (file deletes, recursive removes, global installs).',
  'q4-local': 'Restate the user\'s goal in one sentence, then take the action by CALLING the appropriate tool. Use absolute file paths only — never reference "the file we just edited" or other implicit antecedents. Run no shell command outside the explicit allowlist without re-asking.',
  'q2-local': 'Restate the user\'s goal in one sentence, then take the action by CALLING the appropriate tool. Take one step at a time. Use absolute file paths only; if you do not know a path, ask.',
}

const UI_OPEN_NUDGE = 'To DISPLAY a file or directory visually in the user\'s window, editor, or sidebar, call open_file_in_ui or open_dir_in_ui. To get a file\'s text contents or a directory\'s entries — including when the user says "show me what\'s in X", "what does X say", or "what\'s inside X" — use read_file or list_dir, not the open_*_in_ui tools.'

const CALL_DONT_DESCRIBE = 'To do anything, CALL a tool — never write the tool call as JSON, code, or text in your reply. Only an actual tool call runs; described calls do nothing.'

const TIER_SUFFIX: Record<Tier, string> = {
  frontier: UI_OPEN_NUDGE,
  mid: `If the user's request is ambiguous, ask one clarifying question before acting. ${UI_OPEN_NUDGE}`,
  'q4-local': `${CALL_DONT_DESCRIBE} If you do not know the absolute path of a file, ASK before reading or writing. Do not invent paths, commands, or APIs. ${UI_OPEN_NUDGE}`,
  'q2-local': `${CALL_DONT_DESCRIBE} If a file path was not given to you in this turn, do not act on it — ask. ${UI_OPEN_NUDGE}`,
}

export const composeSystemPrompt = (base: string, tier: Tier): string => {
  return [TIER_PREFIX[tier], base, TIER_SUFFIX[tier]].filter(s => s.length > 0).join('\n\n')
}
