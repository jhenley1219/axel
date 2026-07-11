import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Live tool-calling gate for local models. Real conversations against Ollama, so
// it SKIPS cleanly when Ollama is down or the model isn't pulled (keeps CI green
// on machines without a GPU box). When the model is present, the model must, for
// each intent, reach the pass threshold across seeded paraphrases.
//
// mode 'root' : socialize (no tool) + delegate via open_terminal.
// mode 'worker': a delegated sub-terminal fires the right file/search/edit tool.
//
// Default model is gemma4:12b — the designated local root model (100% across
// root + worker). llama3.1:8b is best-effort: it delegates well but its 8B size
// caps root conversation-classification around 80–90%, so gate it in worker mode
// or with a lower threshold (AXEL_HARNESS_MODEL=llama3.1:8b AXEL_HARNESS_MODE=worker).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const BASE_URL = process.env.AXEL_OLLAMA_URL || 'http://localhost:11434'
const MODEL = process.env.AXEL_HARNESS_MODEL || 'gemma4:12b'
const MODE = process.env.AXEL_HARNESS_MODE || 'root'
const N = Number(process.env.AXEL_HARNESS_N || '10')
// 0.9 across n=10: a single borderline-wording miss (9/10) still passes, but an
// intent that broadly fails does not. Harness pins temperature 0, so a given
// build/model is deterministic and the gate does not flap.
const THRESHOLD = Number(process.env.AXEL_HARNESS_THRESHOLD || '0.9')
const TIERS = (process.env.AXEL_HARNESS_TIERS || 'q4-local,q2-local').split(',')

const build = spawnSync('pnpm', ['-F', '@axel/agent', 'build'], { cwd: REPO, encoding: 'utf8' })
if (build.status !== 0) {
  console.error(build.stdout, build.stderr)
  throw new Error('pnpm -F @axel/agent build failed')
}

const { runHarness } = await import(REPO + '/packages/agent/tests/tool-harness/runHarness.mjs')

const probe = async () => {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`)
    if (!res.ok) return `ollama http ${res.status}`
    const body = await res.json()
    const have = (body.models ?? []).some((m) => m.name === MODEL || m.name === `${MODEL}:latest`)
    return have ? null : `model "${MODEL}" not pulled`
  } catch (e) {
    return `cannot reach ollama at ${BASE_URL}: ${e.message}`
  }
}

const skipReason = await probe()

for (const tier of TIERS) {
  test(`${MODEL} @ ${tier} (${MODE}): every intent passes across paraphrases`, { skip: skipReason ?? false }, async () => {
    const { perTool } = await runHarness({ model: MODEL, tier, mode: MODE, n: N, seed: 7, baseURL: BASE_URL })
    const weak = []
    for (const row of perTool) {
      const rate = row.pass / row.total
      if (rate < THRESHOLD) {
        weak.push(`${row.tool} ${row.pass}/${row.total} (${(rate * 100).toFixed(0)}%)`)
        for (const f of row.failures.slice(0, 3)) console.error(`  ${row.tool} miss: got=${f.got ?? 'TEXT'} :: ${JSON.stringify(f.prompt)}`)
      }
    }
    assert.equal(weak.length, 0, `tools below ${THRESHOLD * 100}% on ${tier}: ${weak.join(', ')}`)
  })
}

if (skipReason) console.log(`[tool-harness] skipped: ${skipReason}`)
