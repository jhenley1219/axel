// Core of the local-model tool-calling harness.
//
// For a given {model, tier, mode, n, seed} it builds a throwaway sandbox of
// named "projects", composes the REAL system prompt the live app sends
// (PromptBuilder, compact for local tiers) + the tier wrapper, and asks the
// OllamaProvider many seeded paraphrases — recording whether the model did the
// right thing:
//   mode 'root'   : socialize (no tool) OR delegate via open_terminal
//   mode 'worker' : actually call the file/search/edit/run tool
// This is faithful to production: an earlier version used a 4-line stand-in
// prompt and falsely passed while the real 17k prompt broke the models.

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getIntents, genPrompts, EXPECT_NONE } from './paraphrase.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '../../../..')
const DIST = path.join(REPO, 'packages/agent/dist/index.js')

const { OllamaProvider, composeSystemPrompt, buildDefaultRegistry, buildRootOrchestrationTools, PromptBuilder, McpRegistry } =
  await import(DIST)

const PROJECTS = ['sundial', 'acme-blueprint-react-ui', 'acme-blueprint-react-ui-azure', 'acme-functionapp-crm']

// Build the throwaway projects root the paraphrases refer to. In root mode the
// model delegates by project NAME; in worker mode it works inside one project.
export const makeFixture = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'axel-toolharness-')))
  for (const p of PROJECTS) mkdirSync(path.join(dir, p), { recursive: true })
  const workDir = path.join(dir, PROJECTS[0])
  const srcDir = path.join(workDir, 'src')
  const docsDir = path.join(workDir, 'docs')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })
  const needle = 'computeTotal'
  writeFileSync(path.join(workDir, 'README.md'), '# Demo project\n\nThis project demonstrates the harness.\nThere is a TODO here.\n')
  writeFileSync(path.join(srcDir, 'app.ts'), `export const ${needle} = (a: number, b: number): number => a + b\n`)
  writeFileSync(path.join(srcDir, 'util.ts'), `export const ${needle}Helper = (): void => {}\n`)
  writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n\nSee README for details.\n')
  return {
    dir,
    projects: PROJECTS,
    workDir,
    srcDir,
    docsDir,
    readme: path.join(workDir, 'README.md'),
    appFile: path.join(srcDir, 'app.ts'),
    newFile: path.join(workDir, 'notes.txt'),
    needle,
    globExt: 'ts',
  }
}

// Tool specs the model sees — mirrors AxelAgent: root gets ONLY the
// orchestration tools (it delegates everything); worker gets the file tools.
const toolSpecsFor = (mode) => {
  const noop = async () => ({ ok: true, target: 'x', term: 't', reused: false })
  const active =
    mode === 'root'
      ? buildRootOrchestrationTools({ open: noop, read: noop, cleanup: async () => ({ ok: true, closed: [] }) })
      : buildDefaultRegistry().list()
  return active.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

// Compose the real production system prompt for this mode/tier.
const systemPromptFor = async (fx, mode, tier) => {
  const pb = new PromptBuilder(new McpRegistry(path.join(fx.dir, '.no-registry')))
  const compact = tier === 'q4-local' || tier === 'q2-local'
  const base =
    mode === 'root'
      ? await pb.build([fx.dir], { root: true, compact, uiLocation: `near the ${fx.projects[0]} project` })
      : await pb.build([fx.workDir], { compact })
  return composeSystemPrompt(base, tier)
}

// Run exactly one provider turn; return the FIRST tool call or the reply text.
const oneTurn = async (provider, systemPrompt, tools, userPrompt, model) => {
  let text = ''
  const stream = provider.stream({
    messages: [{ role: 'user', content: userPrompt }],
    tools,
    model,
    systemPrompt,
    options: { temperature: 0, seed: 42 }, // greedy: measure wording, not sampling noise
  })
  for await (const ev of stream) {
    if (ev.type === 'tool_call') return { tool: ev.name, input: ev.input }
    if (ev.type === 'token') text += ev.value
    if (ev.type === 'error') return { error: ev.message }
    if (ev.type === 'end') break
  }
  return { tool: null, text }
}

const keyHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

// Run the full matrix for one tier+mode. Returns { perTool: [...], fixtureDir }.
export const runHarness = async ({ model, tier, mode = 'root', n = 8, seed = 1, baseURL, onResult } = {}) => {
  const provider = new OllamaProvider({ baseURL })
  const tools = toolSpecsFor(mode)
  const fx = makeFixture()
  const systemPrompt = await systemPromptFor(fx, mode, tier)

  const perTool = []
  for (const intent of getIntents(mode)) {
    const prompts = genPrompts(intent, fx, n, (seed * 1000003 + keyHash(intent.key)) >>> 0)
    let toolMatch = 0
    let pass = 0
    const failures = []
    for (const prompt of prompts) {
      const r = await oneTurn(provider, systemPrompt, tools, prompt, model)
      let matched
      let argOk
      if (intent.expect === EXPECT_NONE) {
        // Socializing: success is NO tool call + a real (non-empty) reply.
        matched = r.tool === null
        argOk = matched && typeof r.text === 'string' && r.text.trim().length > 0
      } else {
        matched = r.tool === intent.expect
        argOk = matched && intent.check(r.input, fx, prompt)
      }
      if (matched) toolMatch++
      if (argOk) pass++
      else failures.push({ prompt, got: r.tool, text: r.text?.slice(0, 120), input: r.input })
      if (onResult) onResult({ tool: intent.key, prompt, got: r.tool, matched, argOk })
    }
    perTool.push({ tool: intent.key, total: prompts.length, toolMatch, pass, failures })
  }
  return { model, tier, mode, n, seed, perTool, fixtureDir: fx.dir }
}
