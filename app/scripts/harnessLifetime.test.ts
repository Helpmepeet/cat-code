import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cases = ['config-failure', 'build-failure', 'electron-failure', 'electron-timeout', 'complete'] as const
const runs = ['harness-demo', 'visual-acceptance'].flatMap(runner =>
  (runner === 'visual-acceptance' ? [...cases, 'fixture-failure'] : cases)
    .map(outcome => ({ runner, outcome })),
)

test.each(runs)('$runner cleans its owned resources on $outcome', async ({ runner, outcome }) => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-runner-lifetime-'))
  const scripts = join(root, 'scripts')
  const temp = join(root, 'tmp')
  const output = join(root, 'captures')
  const bin = join(root, 'bin')
  for (const dir of [scripts, temp, output, bin, join(root, 'node_modules', '.bin')]) {
    mkdirSync(dir, { recursive: true })
  }

  // Run the real entrypoint with harmless build/child executables, never Electron.
  copyFileSync(new URL(`./${runner}.ts`, import.meta.url), join(scripts, `${runner}.ts`))
  copyFileSync(new URL('./devLauncher.ts', import.meta.url), join(scripts, 'devLauncher.ts'))
  writeFileSync(join(scripts, `${runner}-driver.ts`), 'export {}\n')
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\n[ "$RUNNER_OUTCOME" != build-failure ] || exit 23\n', { mode: 0o755 })
  writeFileSync(join(bin, 'bunx'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const root = process.env.RUNNER_FIXTURE
writeFileSync(root + '/vite.pid', String(process.pid))
writeFileSync(root + '/vite.ready', '')
process.on('SIGTERM', () => { writeFileSync(root + '/vite.stopped', ''); process.exit(0) })
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  writeFileSync(join(root, 'node_modules', '.bin', 'electron'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const root = process.env.RUNNER_FIXTURE
writeFileSync(root + '/electron.pid', String(process.pid))
process.on('SIGTERM', () => { writeFileSync(root + '/electron.stopped', ''); process.exit(0) })
if (process.env.RUNNER_OUTCOME === 'electron-timeout') setInterval(() => {}, 1000)
else setTimeout(() => {
  writeFileSync(process.env.CATCODE_CAPTURE_OUT + '/capture.png', 'requested output')
  console.log('[main] renderer ready')
  console.log('[capture] done 1')
  process.exit(process.env.RUNNER_OUTCOME === 'electron-failure' ? 7 : 0)
}, 30)
`, { mode: 0o755 })
  writeFileSync(join(root, 'preload.ts'), `
import fs from 'node:fs'
import { mock } from 'bun:test'
mock.module('node:fs', () => ({
  ...fs,
  mkdtempSync(prefix) {
    if (process.env.RUNNER_OUTCOME === 'config-failure' && prefix.includes('-config-')) throw new Error('config setup failure')
    return fs.mkdtempSync(prefix)
  },
  writeFileSync(path, ...args) {
    if (process.env.RUNNER_OUTCOME === 'fixture-failure' && String(path).endsWith('/fixture.jsonl')) throw new Error('usage fixture failure')
    return fs.writeFileSync(path, ...args)
  },
}))
globalThis.fetch = async () => {
  if (!fs.existsSync(process.env.RUNNER_FIXTURE + '/vite.ready')) throw new Error('Vite pending')
  return new Response('ready')
}
const schedule = globalThis.setTimeout
globalThis.setTimeout = (callback, ms, ...args) => schedule(callback, ms >= 45000 ? 1500 : ms, ...args)
`)

  const child = Bun.spawn({
    cmd: [process.execPath, '--preload', join(root, 'preload.ts'), join(scripts, `${runner}.ts`)],
    cwd: root,
    env: {
      PATH: bin,
      TMPDIR: temp,
      RUNNER_FIXTURE: root,
      RUNNER_OUTCOME: outcome,
      CATCODE_CAPTURE_OUT: output,
      ...(runner === 'visual-acceptance' ? { CATCODE_CAPTURE_SCENE: 'usage' } : {}),
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: stdout + stderr }).toMatchObject({
      status: outcome === 'complete' ? 0 : outcome === 'build-failure' ? 23 : outcome === 'electron-failure' ? 7 : 1,
    })
    if (outcome === 'config-failure') expect(stderr).toContain('config setup failure')
    if (outcome === 'fixture-failure') expect(stderr).toContain('usage fixture failure')
    expect(readdirSync(temp)).toEqual([])
    for (const name of ['vite', 'electron']) {
      const pidFile = join(root, `${name}.pid`)
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'))
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }
    if (outcome.startsWith('electron-') || outcome === 'complete') {
      expect(existsSync(join(root, 'vite.stopped'))).toBe(true)
      expect(existsSync(join(root, 'electron.pid'))).toBe(true)
    }
    if (outcome === 'electron-timeout') expect(existsSync(join(root, 'electron.stopped'))).toBe(true)
    if (outcome === 'complete') expect(readFileSync(join(output, 'capture.png'), 'utf8')).toBe('requested output')
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    // A failing regression must still stop only the fixture children it started.
    for (const name of ['vite', 'electron']) {
      const pidFile = join(root, `${name}.pid`)
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
