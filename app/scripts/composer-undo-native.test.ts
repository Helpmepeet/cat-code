import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const appRoot = fileURLToPath(new URL('..', import.meta.url))
test('composer history survives real Chromium edits and native undo entry points', async () => {
  const out = mkdtempSync(join(tmpdir(), 'composer-undo-build-'))
  try {
    const vite = Bun.spawnSync([process.execPath, join(appRoot, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'scripts/composer-undo.vite.config.ts', '--outDir', join(out, 'page'), '--emptyOutDir', '--logLevel', 'error'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
    if (vite.exitCode !== 0) throw new Error(`Fixture build failed: ${vite.stdout}\n${vite.stderr}`)
    const build = await Bun.build({ entrypoints: [join(appRoot, 'scripts/composer-undo-native.ts')], target: 'node', format: 'cjs', external: ['electron'], outdir: out, naming: '[name].cjs' })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env
    const child = Bun.spawn([join(appRoot, 'node_modules/.bin/electron'), join(out, 'composer-undo-native.cjs'), join(out, 'page/composer-undo-fixture.html'), ...(process.env.COMPOSER_UNDO_BASELINE === '1' ? ['--baseline'] : [])], { cwd: appRoot, env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    console.log(stdout)
    if (code !== 0) throw new Error(`Composer native regression failed (${code}):\n${stdout}\n${stderr}`)
    const lines = stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(lines.at(-1)).toEqual({ nativeExitCode: 0, temporaryStateRemoved: true })
    if (process.env.COMPOSER_UNDO_BASELINE !== '1') expect(lines.find(line => line.results)?.results.length).toBeGreaterThanOrEqual(10)
  } finally { rmSync(out, { recursive: true, force: true }) }
}, 240_000)
