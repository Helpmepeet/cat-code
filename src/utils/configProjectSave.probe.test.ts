import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function runScenario(scenario: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'project-config-save-'))
  const configDir = join(root, 'config')
  const projectDir = join(root, 'project')
  mkdirSync(configDir)
  mkdirSync(projectDir)
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', join(import.meta.dir, 'configProjectSave.probe.child.ts')],
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'development',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CONFIG_DIR: configDir,
        PROBE_PROJECT_DIR: projectDir,
        PROBE_SCENARIO: scenario,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`Project-save probe failed: ${stderr}\n${stdout}`)
    const result = stdout.split('\n').find(line => line.startsWith('RESULT:'))
    if (!result) throw new Error(`Project-save probe produced no result: ${stderr}`)
    return JSON.parse(result.slice('RESULT:'.length))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a normal project save updates disk and the cache once', async () => {
  expect(await runScenario('success')).toMatchObject({
    updaterCalls: 1,
    bytesUnchanged: false,
    cacheUnchanged: false,
    projectCount: 8,
    diskProjectCount: 8,
    numStartups: 42,
    successfulWrites: 1,
  })
})

for (const scenario of ['lock-error', 'updater-error', 'write-error', 'noop']) {
  test(`${scenario} leaves project config bytes and the cache unchanged without retrying`, async () => {
    expect(await runScenario(scenario)).toMatchObject({
      updaterCalls: scenario === 'lock-error' ? 0 : 1,
      writeCalls: scenario === 'write-error' ? 1 : 0,
      bytesUnchanged: true,
      cacheUnchanged: true,
      projectCount: 7,
      diskProjectCount: 7,
      numStartups: 42,
      successfulWrites: 0,
    })
  })
}
