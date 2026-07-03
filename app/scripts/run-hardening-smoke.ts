/**
 * F16 — build the preload bundle, then launch the Electron hardening smoke
 * (`hardening-smoke.ts`) and forward its exit code. Single entry point for
 * CI/verify:
 *
 *   bun run app/scripts/run-hardening-smoke.ts
 *
 * Exits non-zero if the build fails, Electron cannot launch, or any hardening
 * assertion fails.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')

if (!existsSync(electronBin)) {
  process.stderr.write(
    `[run-hardening-smoke] electron not installed at ${electronBin}; run 'bun install' in app/\n`,
  )
  process.exit(3)
}

// 1. Build preload.cjs (the smoke harness loads the REAL preload).
const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
  stdio: 'inherit',
})
if (build.status !== 0) {
  process.stderr.write('[run-hardening-smoke] preload build failed\n')
  process.exit(build.status ?? 1)
}

// 2. Bundle the harness to ESM .js — Electron's Node runtime cannot load a raw
//    .ts entry. `electron` + node builtins stay external (runtime-provided).
const harnessOut = join(here, 'hardening-smoke.js')
const bundle = await Bun.build({
  entrypoints: [join(here, 'hardening-smoke.ts')],
  outdir: here,
  target: 'node',
  format: 'esm',
  external: ['electron'],
  naming: '[name].js',
})
if (!bundle.success) {
  for (const message of bundle.logs) console.error(message)
  process.stderr.write('[run-hardening-smoke] harness bundle failed\n')
  process.exit(1)
}

// 3. Launch the built harness under Electron.
const smoke = spawnSync(electronBin, [harnessOut], {
  stdio: 'inherit',
  cwd: appRoot,
  env: { ...process.env },
})
process.exit(smoke.status ?? 1)
