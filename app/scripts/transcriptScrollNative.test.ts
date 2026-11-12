import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))

// The transcript's scroll correction is only provable against real layout and
// real wheel input: the DOM suites cannot lay out or scroll. This builds the
// synthetic fixture and its Electron runner into temporary state, then drives
// every scenario in a hidden window with no product main, preload or saved state.
test.skipIf(process.platform !== 'darwin')('transcript text stays in place under trusted wheel input', async () => {
  const out = mkdtempSync(join(tmpdir(), 'transcript-scroll-'))
  try {
    const vite = Bun.spawnSync([
      process.execPath, join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
      '--config', 'scripts/transcript-scroll.vite.config.ts',
      '--outDir', join(out, 'page'), '--emptyOutDir', '--logLevel', 'error',
    ], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
    if (vite.exitCode !== 0) throw new Error(`Fixture build failed:\n${vite.stdout}\n${vite.stderr}`)
    const runner = await Bun.build({
      entrypoints: [join(appRoot, 'scripts', 'transcript-scroll-native.ts')],
      target: 'node', format: 'cjs', external: ['electron'],
      outdir: out, naming: '[name].cjs',
    })
    if (!runner.success) throw new Error(`Runner build failed: ${runner.logs.join('\n')}`)

    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const electron = Bun.spawn([
      join(appRoot, 'node_modules', '.bin', 'electron'),
      join(out, 'transcript-scroll-native.cjs'),
      join(out, 'page', 'transcript-scroll-fixture.html'),
    ], { cwd: appRoot, env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      electron.exited, new Response(electron.stdout).text(), new Response(electron.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Scroll regression failed (exit ${code}):\n${stderr}\n${stdout.slice(-4_000)}`)

    // The runner prints the fixture's result, then its own exit record.
    const split = stdout.lastIndexOf('{\n  "nativeExitCode"')
    const result = JSON.parse(stdout.slice(0, split)) as {
      inputMode: string
      peakAnchorError: number
      results: Array<{ scenario: string }>
      wheelEvents: Array<{ isTrusted: boolean }>
    }
    const exit = JSON.parse(stdout.slice(split)) as { nativeExitCode: number; temporaryStateRemoved: boolean }
    expect(exit).toMatchObject({ nativeExitCode: 0, temporaryStateRemoved: true })
    expect(result.inputMode).toBe('wheel')
    expect(result.wheelEvents.some(event => event.isTrusted)).toBe(true)
    expect(result.peakAnchorError).toBeLessThanOrEqual(1)
    expect(result.results.map(entry => entry.scenario)).toEqual(expect.arrayContaining([
      'Focused answer above a virtualized structured query',
      'Focused list-heavy answer remounted above the viewport',
      'Focused segment threshold, reopen, completion and nested reveal',
    ]))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 240_000)
