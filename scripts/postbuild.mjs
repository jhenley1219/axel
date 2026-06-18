#!/usr/bin/env node
// Prepares the repo for npm publish / npx axel after pnpm build:
//   1. Copies apps/web/dist → apps/server/public (server serves frontend from there)
//   2. Copies built workspace packages into apps/server/node_modules/@axel/
//      so they resolve correctly when installed via npm (outside pnpm workspace context)
import { cpSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1. Web frontend → server public dir
const webDist = join(root, 'apps', 'web', 'dist')
const serverPublic = join(root, 'apps', 'server', 'public')
if (!existsSync(webDist)) {
  console.error('postbuild: apps/web/dist not found — run pnpm build first')
  process.exit(1)
}
cpSync(webDist, serverPublic, { recursive: true, force: true })
console.log('postbuild: copied web dist → apps/server/public')

// 2. Workspace packages → apps/server/node_modules/@axel/
// This makes @axel/* resolvable after `npm install -g axel` (no pnpm workspace).
// In a pnpm workspace, node_modules/@axel/<pkg> is already a symlink to the source;
// we skip those to avoid a "src and dest are the same" error.
import { realpathSync } from 'fs'

for (const pkg of ['core', 'agent', 'auth', 'stt']) {
  const src = join(root, 'packages', pkg)
  const dest = join(root, 'apps', 'server', 'node_modules', '@axel', pkg)

  // If dest already resolves to src (pnpm symlink), nothing to do
  try {
    if (realpathSync(dest) === realpathSync(src)) {
      console.log(`postbuild: @axel/${pkg} already linked — skipping copy`)
      continue
    }
  } catch {
    // dest doesn't exist yet — fall through to copy
  }

  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
}
console.log('postbuild: workspace packages copied to apps/server/node_modules/@axel/')
