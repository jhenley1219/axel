// Reproduction / validation: does the local model behave under the COMPACT root
// prompt — reply to a greeting without tool-spamming, and delegate code work via
// open_terminal? Run: node packages/agent/tests/tool-harness/repro-greeting.mjs
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const DIST = path.join(REPO, 'packages/agent/dist/index.js')
const { OllamaProvider, PromptBuilder, McpRegistry, composeSystemPrompt, buildDefaultRegistry } = await import(DIST)

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-repro-')))
for (const p of ['acme-blueprint-react-ui', 'acme-blueprint-react-ui-azure', 'sundial']) mkdirSync(path.join(root, p))

const promptBuilder = new PromptBuilder(new McpRegistry(path.join(root, '.no-registry')))
const compactRoot = await promptBuilder.build([root], { root: true, compact: true, uiLocation: 'near the sundial project' })

const provider = new OllamaProvider({ baseURL: 'http://localhost:11434' })
// Tool set the real root agent sees: file/ui tools + the orchestration tool.
const openTerminal = { name: 'open_terminal', description: 'Delegate a task to a sub-terminal in a project. Pass directory (project name) and prompt (the task).', inputSchema: { type: 'object', properties: { directory: { type: 'string' }, prompt: { type: 'string' }, term: { type: 'string' } } } }
const tools = [...buildDefaultRegistry().list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), openTerminal]

const run = async (model, userMsg) => {
  const system = composeSystemPrompt(compactRoot, 'q4-local')
  let text = ''
  const calls = []
  for await (const ev of provider.stream({ messages: [{ role: 'user', content: userMsg }], tools, model, systemPrompt: system, options: { temperature: 0, seed: 42 } })) {
    if (ev.type === 'token') text += ev.value
    if (ev.type === 'tool_call') calls.push({ name: ev.name, input: ev.input })
    if (ev.type === 'error') return `ERROR: ${ev.message}`
    if (ev.type === 'end') break
  }
  return calls.length ? `TOOL ${calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', ')}` : `TEXT: ${JSON.stringify(text.slice(0, 180))}`
}

console.log(`compact root prompt length: ${compactRoot.length} chars\n`)
const cases = [
  ['greeting', 'hey Axel how is it going'],
  ['smalltalk', 'what can you help me with'],
  ['delegate', 'fix the audio bug in sundial'],
  ['delegate', 'look for bugs in the react-ui-azure project'],
]
for (const model of ['llama3.1:8b', 'gemma4:12b']) {
  console.log(`===== ${model} =====`)
  for (const [kind, msg] of cases) console.log(`[${kind}] "${msg}"\n   -> ${await run(model, msg)}\n`)
}
