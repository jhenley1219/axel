// CLI driver for the tool-calling harness. Drives the auto-tune loop:
//   node packages/agent/tests/tool-harness/run.mjs --model llama3.1:8b --n 10
//
// Flags: --model <id> --tier <q4-local|q2-local|mid|frontier> --n <int>
//        --seed <int> --base-url <url> --verbose
import { runHarness } from './runHarness.mjs'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const bool = (name) => argv.includes(`--${name}`)

const model = flag('model', 'llama3.1:8b')
const tiers = flag('tier', 'q4-local,q2-local').split(',')
const mode = flag('mode', 'root')
const n = Number(flag('n', '8'))
const seed = Number(flag('seed', '1'))
const baseURL = flag('base-url', process.env.AXEL_OLLAMA_URL || 'http://localhost:11434')
const verbose = bool('verbose')

const pct = (x, total) => `${((x / total) * 100).toFixed(0)}%`
const bar = (rate) => (rate >= 0.9 ? 'PASS' : rate >= 0.6 ? 'WARN' : 'FAIL')

const probe = async () => {
  try {
    const res = await fetch(`${baseURL}/api/tags`)
    if (!res.ok) return `ollama http ${res.status}`
    const body = await res.json()
    const have = (body.models ?? []).some((m) => m.name === model || m.name === `${model}:latest`)
    return have ? null : `model "${model}" not pulled (have: ${(body.models ?? []).map((m) => m.name).join(', ') || 'none'})`
  } catch (e) {
    return `cannot reach ollama at ${baseURL}: ${e.message}`
  }
}

const reason = await probe()
if (reason) {
  console.error(`\n[harness] cannot run: ${reason}\n`)
  process.exit(2)
}

console.log(`\n[harness] model=${model} mode=${mode} tiers=${tiers.join(',')} n=${n} seed=${seed} url=${baseURL}\n`)

let worstRate = 1
for (const tier of tiers) {
  console.log(`===== tier: ${tier} (${mode}) =====`)
  const { perTool } = await runHarness({ model, tier, mode, n, seed, baseURL })
  console.log(`${'tool'.padEnd(18)} ${'tool-match'.padEnd(12)} ${'pass(args)'.padEnd(12)} result`)
  for (const row of perTool) {
    const rate = row.pass / row.total
    worstRate = Math.min(worstRate, rate)
    console.log(
      `${row.tool.padEnd(18)} ${`${row.toolMatch}/${row.total} ${pct(row.toolMatch, row.total)}`.padEnd(12)} ` +
        `${`${row.pass}/${row.total} ${pct(row.pass, row.total)}`.padEnd(12)} ${bar(rate)}`,
    )
    if (verbose && row.failures.length) {
      for (const f of row.failures.slice(0, 4)) {
        console.log(`    miss: got=${f.got ?? 'TEXT'} :: ${JSON.stringify(f.prompt)}`)
        if (f.got === null && f.text) console.log(`          text="${f.text}"`)
      }
    }
  }
  console.log('')
}

console.log(`[harness] worst per-tool pass rate: ${(worstRate * 100).toFixed(0)}%`)
process.exit(worstRate >= 0.9 ? 0 : 1)
