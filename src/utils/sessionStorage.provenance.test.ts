import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE_VERSION = '9.8.7-probe.sha1234abcd-dirty'
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bundled async transcript write uses the defined build version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-provenance-bundle-'))
  tempRoots.push(root)
  const outputPath = join(root, 'provenance-fixture.js')
  const build = Bun.spawn([
    'bun',
    'build',
    new URL('./sessionStorage.provenance.fixture.ts', import.meta.url).pathname,
    '--target',
    'bun',
    '--format',
    'esm',
    '--outfile',
    outputPath,
    '--packages',
    'bundle',
    '--conditions',
    'bun',
    '--define',
    `process.env.USER_TYPE=${JSON.stringify('external')}`,
    '--define',
    `MACRO.VERSION=${JSON.stringify(FIXTURE_VERSION)}`,
    '--external',
    '@ant/*',
    '--external',
    'audio-capture-napi',
    '--external',
    'image-processor-napi',
    '--external',
    'modifiers-napi',
    '--external',
    'url-handler-napi',
  ], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [buildExitCode, buildStdout, buildStderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0)

  const projectDir = join(root, 'project')
  const child = Bun.spawn(['bun', outputPath, projectDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  expect(stdout).toBe(FIXTURE_VERSION)
}, 30_000)
