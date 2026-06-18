#!/usr/bin/env node
// axel-docker-init — interactive Docker bootstrap.
// Prompts for one project directory, auto-detects the stack from root-level
// manifests, generates Dockerfile.user.generated + docker-compose.user.yml,
// then builds and runs the container. Open http://localhost:8080 when ready.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const axelRoot = path.resolve(__dirname, '..')

// ── Stack detection ──────────────────────────────────────────────────────────
// Each detector matches a single root-level manifest. `apt` packages get added
// via a single `apt-get install` line. `custom` snippets get appended verbatim.
// `note` is shown to the user but adds nothing to the image. Detector shape:
//   { file, name, apt?, custom?, note?, mask? }
const DETECTORS = [
  { file: 'package.json',     name: 'Node.js',         apt: [],            note: 'Node 22 + pnpm already in base image', mask: 'node_modules' },
  { file: 'Gemfile',          name: 'Ruby',            apt: ['ruby-full'], mask: 'vendor/bundle' },
  { file: 'pyproject.toml',   name: 'Python (Poetry)', apt: [],            custom: 'pip3 install --no-cache-dir --break-system-packages poetry' },
  { file: 'requirements.txt', name: 'Python',          apt: [],            note: 'Python 3 already in base image' },
  { file: 'Cargo.toml',       name: 'Rust',            apt: [],            custom: 'rustup', mask: 'target' },
  { file: 'go.mod',           name: 'Go',              apt: ['golang-go'] },
  { file: 'pom.xml',          name: 'Java (Maven)',    apt: ['default-jdk', 'maven'] },
  { file: 'build.gradle',     name: 'Java (Gradle)',   apt: ['default-jdk', 'gradle'] },
  { file: 'build.gradle.kts', name: 'Kotlin (Gradle)', apt: ['default-jdk', 'gradle'] },
  { file: 'composer.json',    name: 'PHP',             apt: ['php-cli', 'composer'] },
  { file: 'mix.exs',          name: 'Elixir',          apt: ['elixir'] },
  { file: 'deno.json',        name: 'Deno',            apt: [], custom: 'deno' },
  { file: 'bun.lockb',        name: 'Bun',             apt: [], custom: 'bun' },
]

const CUSTOM_SNIPPETS = {
  rustup: `ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:\$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path \\
 && chmod -R a+rwX /usr/local/rustup /usr/local/cargo`,
  deno:  `RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y`,
  bun:   `RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash`,
}

// ── Prompt helpers ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())))
const confirm = async (q, def = true) => {
  const a = (await ask(`${q} ${def ? '(Y/n)' : '(y/N)'} `)).toLowerCase()
  if (a === '') return def
  return a === 'y' || a === 'yes'
}

const expandHome = (p) => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p

// ── Main flow ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  axel-docker-init — isolated Docker setup\n')

  // 1. Preflight: docker present, repo clone (Docker files are NOT shipped via npm)
  if (!hasBin('docker')) {
    console.error('  docker is not installed or not on PATH. Install Docker Desktop first: https://www.docker.com/products/docker-desktop')
    process.exit(1)
  }
  const composeCmd = detectComposeCmd()
  if (!composeCmd) {
    console.error('  docker compose is not available. Install Docker Desktop or the compose plugin.')
    process.exit(1)
  }
  if (!existsSync(path.join(axelRoot, 'Dockerfile.public'))) {
    console.error('  Dockerfile.public not found in the Axel repo root.')
    console.error('  This script must be run from a clone of the Axel repository; the npm package does not include Docker files.')
    console.error('  Clone it: git clone https://github.com/jhenley1219/axel && cd axel')
    process.exit(1)
  }

  // 2. Project path
  const raw = await ask('  Path to the project directory you want Axel to manage:\n  > ')
  if (!raw) { console.error('\n  No path given. Aborting.'); process.exit(1) }
  const projectPath = path.resolve(expandHome(raw))
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    console.error(`\n  Not a directory: ${projectPath}`)
    process.exit(1)
  }
  const projectName = path.basename(projectPath).replace(/[^a-zA-Z0-9._-]/g, '-')
  const containerPath = `/projects/${projectName}`

  // 3. Detect stacks
  const found = DETECTORS.filter((d) => existsSync(path.join(projectPath, d.file)))
  console.log('')
  if (found.length === 0) {
    console.log('  No recognized stack manifests found at the project root.')
    console.log('  Will use the base image as-is. You can edit Dockerfile.user.generated later if you need extra tools.')
  } else {
    console.log('  Detected:')
    for (const d of found) {
      const tail = d.note ? ` — ${d.note}` : (d.apt?.length ? ` — apt: ${d.apt.join(', ')}` : (d.custom ? ` — installer: ${d.custom}` : ''))
      console.log(`    - ${d.name} (${d.file})${tail}`)
    }
  }
  console.log(`\n  Project will be mounted at: ${containerPath}`)
  console.log(`  Server will be available at: http://localhost:8080`)
  console.log('')
  if (!(await confirm('  Proceed?'))) {
    console.log('  Aborted.')
    process.exit(0)
  }

  // 4. Write Dockerfile.user.generated
  const dockerfilePath = path.join(axelRoot, 'Dockerfile.user.generated')
  writeFileSync(dockerfilePath, buildDockerfile(found))
  console.log(`\n  Wrote ${dockerfilePath}`)

  // 5. Write docker-compose.user.yml
  const composePath = path.join(axelRoot, 'docker-compose.user.yml')
  writeFileSync(composePath, buildCompose({ projectPath, containerPath, masks: collectMasks(found, containerPath) }))
  console.log(`  Wrote ${composePath}`)

  // 6. Ensure axel-base:latest is built
  const baseExists = spawnSync('docker', ['images', '-q', 'axel-base:latest'], { encoding: 'utf-8' }).stdout.trim()
  if (!baseExists) {
    console.log('\n  Building base image axel-base:latest (this can take 5–10 minutes on first run)...')
    const r = spawnSync('docker', ['build', '-t', 'axel-base:latest', '-f', 'Dockerfile.public', '.'], { cwd: axelRoot, stdio: 'inherit' })
    if (r.status !== 0) { console.error('\n  Base image build failed.'); process.exit(r.status ?? 1) }
  } else {
    console.log('\n  Reusing existing axel-base:latest image. (Delete it with `docker rmi axel-base:latest` to force a rebuild.)')
  }

  // 7. Bring up the user container
  console.log('\n  Building and starting the user container...')
  const [composeBin, ...composeArgs] = composeCmd
  const up = spawnSync(composeBin, [...composeArgs, '-f', 'docker-compose.user.yml', 'up', '-d', '--build'], { cwd: axelRoot, stdio: 'inherit' })
  if (up.status !== 0) { console.error('\n  Container start failed.'); process.exit(up.status ?? 1) }

  // 8. Wait for healthz
  console.log('\n  Waiting for server to come up...')
  const ok = await waitForHealth('http://localhost:8080/healthz', 60_000)
  if (!ok) {
    console.error('  Server did not respond on http://localhost:8080/healthz within 60s.')
    console.error(`  Check container logs with: docker compose -f docker-compose.user.yml logs -f`)
    process.exit(1)
  }

  console.log('\n  ✓ Axel is running at http://localhost:8080')
  console.log(`  Stop with:    docker compose -f docker-compose.user.yml down`)
  console.log(`  Re-run:       npx axel-docker-init`)
  rl.close()
}

// ── File builders ────────────────────────────────────────────────────────────
function buildDockerfile(detectors) {
  const apt = [...new Set(detectors.flatMap((d) => d.apt ?? []))]
  const customs = [...new Set(detectors.map((d) => d.custom).filter(Boolean))]
  const pipCustoms = customs.filter((c) => c.startsWith('pip3 '))
  const snippetKeys = customs.filter((c) => CUSTOM_SNIPPETS[c])

  const lines = [
    '# Generated by axel-docker-init. Do not edit by hand — re-run the script to regenerate.',
    `# Detected: ${detectors.length ? detectors.map((d) => d.name).join(', ') : '(no recognized stack)'}`,
    'FROM axel-base:latest',
    'USER root',
  ]
  if (apt.length) {
    lines.push(
      'RUN apt-get update \\',
      ` && apt-get install -y --no-install-recommends ${apt.join(' ')} \\`,
      ' && rm -rf /var/lib/apt/lists/*',
    )
  }
  for (const k of snippetKeys) lines.push(CUSTOM_SNIPPETS[k])
  for (const p of pipCustoms) lines.push(`RUN ${p}`)
  return lines.join('\n') + '\n'
}

function collectMasks(detectors, containerPath) {
  const masks = new Set()
  for (const d of detectors) if (d.mask) masks.add(`${containerPath}/${d.mask}`)
  return [...masks]
}

function buildCompose({ projectPath, containerPath, masks }) {
  const lines = [
    '# Generated by axel-docker-init. Do not edit by hand — re-run the script to regenerate.',
    'services:',
    '  axel:',
    '    build:',
    '      context: .',
    '      dockerfile: Dockerfile.user.generated',
    '    ports:',
    '      - "8080:8080"',
    '    environment:',
    '      - REQUIRE_AUTH=true',
    `      - PROJECTS_DIR=${containerPath}`,
    `      - ALLOWED_DIRS=${containerPath}`,
    '    volumes:',
    '      - axel-audit:/data/audit',
    '      - axel-home:/home/axel',
    '      - axel-claude-auth:/home/axel/.claude',
    `      - ${projectPath}:${containerPath}`,
  ]
  for (const m of masks) lines.push(`      - ${m}`)
  lines.push(
    '    restart: unless-stopped',
    '',
    'volumes:',
    '  axel-audit:',
    '  axel-home:',
    '  axel-claude-auth:',
    '',
  )
  return lines.join('\n')
}

// ── Utilities ────────────────────────────────────────────────────────────────
function hasBin(name) {
  const r = spawnSync(name, ['--version'], { stdio: 'ignore' })
  return r.status === 0
}

function detectComposeCmd() {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0) return ['docker', 'compose']
  if (hasBin('docker-compose')) return ['docker-compose']
  return null
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => { resolve(res.statusCode === 200); res.resume() })
      req.on('error', () => resolve(false))
      req.setTimeout(2_000, () => { req.destroy(); resolve(false) })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 1_500))
  }
  return false
}

main().catch((err) => { console.error(err); process.exit(1) })
