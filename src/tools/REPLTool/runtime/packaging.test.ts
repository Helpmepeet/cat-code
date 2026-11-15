import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('compiled runtime embeds worker and WASM and starts from an empty offline directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-code-runtime-'))
  try {
  const executable = join(directory, 'runtime')
  const entry = fileURLToPath(new URL('./packagingProbe.ts', import.meta.url))
  const worker = fileURLToPath(new URL('./worker.ts', import.meta.url))
  const build = Bun.spawn([process.execPath, 'build', '--compile', entry, worker, '--outfile', executable], { stdout: 'pipe', stderr: 'pipe' })
  const buildError = await new Response(build.stderr).text()
  expect(await build.exited, buildError).toBe(0)
  const run = Bun.spawn([executable], { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory }, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(run.stdout).text()
  const error = await new Response(run.stderr).text()
  expect(await run.exited, error).toBe(0)
  expect(output.trim()).toBe('offline-runtime-ok')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)

test('missing compiled worker fails closed without host evaluation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-code-runtime-missing-'))
  try {
  const executable = join(directory, 'runtime')
  const entry = fileURLToPath(new URL('./packagingProbe.ts', import.meta.url))
  const build = Bun.spawn([process.execPath, 'build', '--compile', entry, '--outfile', executable], { stdout: 'pipe', stderr: 'pipe' })
  const buildError = await new Response(build.stderr).text()
  expect(await build.exited, buildError).toBe(0)
  const run = Bun.spawn([executable], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
  const error = await new Response(run.stderr).text()
  expect(await run.exited).not.toBe(0)
  expect(error).toContain('Isolated runtime failed to load or execute')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
