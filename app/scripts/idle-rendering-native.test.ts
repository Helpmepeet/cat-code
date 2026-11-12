import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareDevElectron } from './prepare-dev-electron.js'

const appRoot = fileURLToPath(new URL('..', import.meta.url))

test('unchanged live indicators avoid repeated Chromium paint and layout, and respect reduced motion', async () => {
  const out = mkdtempSync(join(tmpdir(), 'catcode-idle-rendering-build-'))
  try {
    const build = await Bun.build({
      entrypoints: [join(appRoot, 'scripts/idle-rendering-native.ts')],
      target: 'node', format: 'cjs', external: ['electron'], outdir: out, naming: '[name].cjs',
    })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env
    const child = Bun.spawn([
      prepareDevElectron() ?? join(appRoot, 'node_modules/.bin/electron'),
      join(out, 'idle-rendering-native.cjs'), join(appRoot, 'renderer/src'),
    ], { cwd: appRoot, env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    console.log(stdout)
    if (code !== 0) throw new Error(`Idle rendering regression failed (${code}):\n${stdout}\n${stderr}`)
    const results = stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(results.at(-1)).toEqual({ nativeExitCode: 0, temporaryStateRemoved: true })
    expect(results.find(result => result.reducedMotion)?.reducedMotion).toBe('static-readable')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 60_000)
