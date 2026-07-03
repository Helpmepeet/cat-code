/**
 * F2 — build preload + bundle the F2 attach harness, launch it under Electron,
 * forward its exit code. Verifies the renderer catches up on late attach AND
 * reload against the REAL supervisor + Bun sidecar.
 *
 *   bun run app/scripts/run-f2-attach-smoke.ts
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')

if (!existsSync(electronBin)) {
  process.stderr.write(`[run-f2-attach-smoke] electron not installed at ${electronBin}\n`)
  process.exit(3)
}

const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const harnessOut = join(here, 'f2-attach-smoke.js')
const bundle = await Bun.build({
  entrypoints: [join(here, 'f2-attach-smoke.ts')],
  outdir: here,
  target: 'node',
  format: 'esm',
  external: ['electron'],
  naming: '[name].js',
})
if (!bundle.success) {
  for (const message of bundle.logs) console.error(message)
  process.exit(1)
}

const smoke = spawnSync(electronBin, [harnessOut], {
  stdio: 'inherit',
  cwd: appRoot,
  env: { ...process.env },
})
process.exit(smoke.status ?? 1)
