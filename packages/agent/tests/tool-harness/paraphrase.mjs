// Seeded paraphrase generator for the local-model tool-calling harness.
//
// The point of this file: prove a tool fires across a VARIETY of wordings, not
// one memorized sentence. Each intent has a bank of natural-language templates;
// a seeded PRNG samples them and layers politeness/filler/casing transforms so
// the same goal is asked many different ways, reproducibly per seed.

// mulberry32 — tiny deterministic PRNG so a seed reproduces an exact prompt set.
export const mulberry32 = (seed) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]

const POLITENESS = [
  '', '', '', 'please ', 'can you ', 'could you ', 'hey ', 'i need you to ',
  'go ahead and ', 'would you mind ', "i'd like you to ", 'ok so ', 'quick one — ',
]

const FILLERS = ['', '', '', ' thanks', ' for me', ' real quick', ' please', ' when you get a sec']

// Light surface transforms add combinatorial variety on top of the template bank.
const maybeLower = (rng, s) => (rng() < 0.25 ? s.toLowerCase() : s)
const decorate = (rng, core) => maybeLower(rng, `${pick(rng, POLITENESS)}${core}${pick(rng, FILLERS)}`.trim())

const has = (input, key) => input && typeof input === 'object' && typeof input[key] === 'string' && input[key].length > 0
const pathHits = (input, ...needles) => {
  if (!has(input, 'path')) return false
  const p = input.path.toLowerCase()
  return needles.some((n) => p.includes(String(n).toLowerCase()))
}

// Sentinel: this intent expects the model to NOT call any tool (just reply).
export const EXPECT_NONE = '__none__'

// WORKER intents — exercised by a delegated sub-terminal (the compact CHILD
// prompt), which DOES the file/search/edit/run work itself. Each intent: the
// expected tool, a fixture-built template bank, and a light arg-sanity check.
export const WORKER_INTENTS = [
  {
    key: 'read_file',
    expect: 'read_file',
    templates: (fx) => [
      `what does ${fx.readme} contain`,
      `read the file ${fx.readme}`,
      `show me the contents of ${fx.readme}`,
      `what's the text inside ${fx.readme}`,
      `i want to know what's written in ${fx.readme}`,
      `dump the text of ${fx.readme}`,
      `print the contents of ${fx.readme}`,
      `pull up the contents of the readme at ${fx.readme}`,
      `cat ${fx.readme}`,
      `let me see what ${fx.readme} says`,
    ],
    check: (input, fx) => pathHits(input, 'readme', fx.readme),
  },
  {
    key: 'write_file',
    expect: 'write_file',
    templates: (fx) => [
      `create a new file at ${fx.newFile} containing the text "hello world"`,
      `write "hello world" into a new file ${fx.newFile}`,
      `make a file ${fx.newFile} with the line hello world in it`,
      `save the note "hello world" to ${fx.newFile}`,
      `put "hello world" into ${fx.newFile}`,
      `generate ${fx.newFile} and write hello world to it`,
      `i need a new file ${fx.newFile} that says hello world`,
      `drop a file at ${fx.newFile} with hello world as the contents`,
    ],
    check: (input) => has(input, 'path') && has(input, 'content'),
  },
  {
    key: 'edit_file',
    expect: 'edit_file',
    templates: (fx) => [
      `in ${fx.appFile} replace the word "${fx.needle}" with "RENAMED"`,
      `change "${fx.needle}" to "RENAMED" inside ${fx.appFile}`,
      `edit ${fx.appFile} and swap "${fx.needle}" for "RENAMED"`,
      `rename "${fx.needle}" to "RENAMED" in the file ${fx.appFile}`,
      `update ${fx.appFile}: the string "${fx.needle}" should now read "RENAMED"`,
      `find "${fx.needle}" in ${fx.appFile} and make it "RENAMED"`,
      `do a find-and-replace in ${fx.appFile} turning "${fx.needle}" into "RENAMED"`,
    ],
    check: (input) => has(input, 'path') && has(input, 'old_string') && has(input, 'new_string'),
  },
  {
    key: 'list_dir',
    expect: 'list_dir',
    templates: (fx) => [
      `what files are in ${fx.srcDir}`,
      `list the contents of ${fx.srcDir}`,
      `show me everything inside the directory ${fx.srcDir}`,
      `what's in the folder ${fx.srcDir}`,
      `give me a directory listing of ${fx.srcDir}`,
      `what files does ${fx.srcDir} directly contain`,
      `which files live in ${fx.srcDir}`,
      `enumerate the entries in ${fx.srcDir}`,
    ],
    check: (input, fx) => pathHits(input, 'src', fx.srcDir),
  },
  {
    key: 'glob',
    expect: 'glob',
    templates: (fx) => [
      `find all the .${fx.globExt} files under ${fx.dir}`,
      `which files matching *.${fx.globExt} exist in ${fx.dir}`,
      `locate every ${fx.globExt} source file beneath ${fx.dir}`,
      `give me the paths of all *.${fx.globExt} files in ${fx.dir}`,
      `glob for **/*.${fx.globExt} starting at ${fx.dir}`,
      `list out the typescript files (the .${fx.globExt} ones) in ${fx.dir}`,
      `search by filename for anything ending in .${fx.globExt} under ${fx.dir}`,
    ],
    check: (input, fx) => has(input, 'pattern') && input.pattern.toLowerCase().includes(fx.globExt),
  },
  {
    key: 'grep',
    expect: 'grep',
    templates: (fx) => [
      `search the code in ${fx.dir} for the word "${fx.needle}"`,
      `find every place "${fx.needle}" appears under ${fx.dir}`,
      `grep for "${fx.needle}" in ${fx.dir}`,
      `where is the string "${fx.needle}" used inside ${fx.dir}`,
      `look through the files in ${fx.dir} for "${fx.needle}"`,
      `which lines contain "${fx.needle}" across ${fx.dir}`,
      `hunt down occurrences of "${fx.needle}" in the project at ${fx.dir}`,
      `scan ${fx.dir} for the text "${fx.needle}"`,
    ],
    check: (input, fx) => has(input, 'pattern') && input.pattern.toLowerCase().includes(fx.needle.toLowerCase()),
  },
  {
    key: 'bash',
    expect: 'bash',
    templates: () => [
      `what version of node am i running`,
      `run "echo hello" in the shell`,
      `print the current working directory`,
      `execute the command: node --version`,
      `check the git status of this repo`,
      `run a quick uname -a`,
      `tell me today's date by running the date command`,
      `how much disk space is free (run df -h)`,
    ],
    check: (input) => has(input, 'command'),
  },
  {
    key: 'open_file_in_ui',
    expect: 'open_file_in_ui',
    templates: (fx) => [
      `open ${fx.readme} in my editor so i can see it on screen`,
      `pop ${fx.readme} up in the UI for me to look at`,
      `display the file ${fx.readme} in my window`,
      `bring ${fx.readme} up visually in the interface`,
      `show ${fx.readme} on my screen in the editor pane`,
      `open the file ${fx.readme} in the UI`,
      `surface ${fx.readme} in my editor view`,
    ],
    check: (input, fx) => pathHits(input, 'readme', fx.readme),
  },
  {
    key: 'open_dir_in_ui',
    expect: 'open_dir_in_ui',
    templates: (fx) => [
      `open the folder ${fx.docsDir} in my UI sidebar`,
      `show the directory ${fx.docsDir} in my file explorer`,
      `pop open ${fx.docsDir} visually in the interface`,
      `bring up the folder ${fx.docsDir} on my screen`,
      `open the directory ${fx.docsDir} in the UI`,
      `display ${fx.docsDir} in my project tree`,
    ],
    check: (input, fx) => pathHits(input, 'docs', fx.docsDir),
  },
]

// ROOT intents — exercised by the root controller (the compact ROOT prompt).
// The root SOCIALIZES (no tool) and DELEGATES code work via open_terminal — it
// must NOT call file/search tools itself.
const namedProject = (fx, prompt) => {
  const lower = prompt.toLowerCase()
  // Longest name first so "react-ui-azure" wins over "react-ui".
  const byLen = [...fx.projects].sort((a, b) => b.length - a.length)
  return byLen.find((p) => lower.includes(p.toLowerCase()) || lower.includes(p.toLowerCase().replace(/^acme-blueprint-/, ''))) ?? null
}

export const ROOT_INTENTS = [
  {
    key: 'conversation',
    expect: EXPECT_NONE,
    templates: () => [
      'hey Axel how is it going',
      'good morning',
      'thanks so much for the help',
      'what can you help me with',
      'what are you exactly',
      'who are you and what do you do',
      'which projects do you know about',
      'what projects can you work on',
      'how are you doing today',
      'nice, appreciate it',
      'just saying hi',
      'can you give me a rundown of what you can do',
    ],
    // Pass handled specially in runHarness: no tool call + a non-empty reply.
    check: () => true,
  },
  {
    key: 'delegate',
    expect: 'open_terminal',
    templates: (fx) =>
      fx.projects.flatMap((proj) => {
        const short = proj.replace(/^acme-blueprint-/, '')
        return [
          `fix the audio bug in ${proj}`,
          `look for bugs in ${short}`,
          `what's in the auth module of ${proj}`,
          `run the tests in ${short}`,
          `refactor the login flow in ${proj}`,
          `check if the build still works in ${short}`,
          `investigate the failing request in ${proj}`,
          `add a dark mode toggle to ${short}`,
        ]
      }),
    // Delegated to a REAL project named in the prompt, with an actual task.
    check: (input, fx, prompt) => {
      if (!has(input, 'directory') || !has(input, 'prompt')) return false
      const target = namedProject(fx, prompt)
      const dir = String(input.directory).toLowerCase()
      const short = target ? target.toLowerCase().replace(/^acme-blueprint-/, '') : ''
      return target ? dir.includes(short) : fx.projects.some((p) => dir.includes(p.toLowerCase().replace(/^acme-blueprint-/, '')))
    },
  },
]

export const getIntents = (mode) => (mode === 'worker' ? WORKER_INTENTS : ROOT_INTENTS)

// Generate n decorated, varied prompts for one intent, deterministic per seed.
export const genPrompts = (intent, fx, n, seed) => {
  const rng = mulberry32(seed)
  const bank = intent.templates(fx)
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(decorate(rng, pick(rng, bank)))
  }
  return out
}
