/**
 * Build the production renderer, main, and preload, then launch the actual
 * desktop main process in its production-path hardening mode. Single entry
 * point for CI/verify:
 *
 *   bun run app/scripts/run-hardening-smoke.ts
 *
 * Exits non-zero if the build fails, Electron cannot launch, or any hardening
 * assertion fails.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')

if (!existsSync(electronBin)) {
  process.stderr.write(
    `[run-hardening-smoke] electron not installed at ${electronBin}; run 'bun install' in app/\n`,
  )
  process.exit(3)
}

// 1. Build the real renderer consumed by production main.
const renderer = spawnSync('bun', ['run', 'renderer:build'], {
  stdio: 'inherit',
  cwd: appRoot,
})
if (renderer.status !== 0) {
  process.stderr.write('[run-hardening-smoke] renderer build failed\n')
  process.exit(renderer.status ?? 1)
}

// 2. Build the real main and preload bundles.
const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
  stdio: 'inherit',
})
if (build.status !== 0) {
  process.stderr.write('[run-hardening-smoke] Electron build failed\n')
  process.exit(build.status ?? 1)
}

// 3. Bundle the external main-process preload harness. Production main does not
// import it; NODE_OPTIONS loads it before the real main bundle evaluates.
const harnessOut = join(here, 'hardening-smoke.cjs')
const harness = await Bun.build({
  entrypoints: [join(here, 'hardening-smoke.ts')],
  outdir: here,
  target: 'node',
  format: 'cjs',
  external: ['electron'],
  naming: '[name].cjs',
})
if (!harness.success) {
  for (const message of harness.logs) console.error(message)
  process.stderr.write('[run-hardening-smoke] harness bundle failed\n')
  process.exit(1)
}

// 4. Launch app/package.json -> app/main/main.js, not a surrogate BrowserWindow.
// Electron's own --require hook runs after its main-process API is initialized.
const smoke = spawnSync(electronBin, ['--require', harnessOut, appRoot], {
  encoding: 'utf8',
  cwd: appRoot,
  env: { ...process.env },
  timeout: 20_000,
})
rmSync(harnessOut, { force: true })
if (smoke.stdout) process.stdout.write(smoke.stdout)
if (smoke.stderr) process.stderr.write(smoke.stderr)
if (
  smoke.status !== 0 ||
  !smoke.stdout?.includes('[hardening-smoke] production path passed')
) {
  process.stderr.write('[run-hardening-smoke] production-path assertions did not pass\n')
  process.exit(1)
}
