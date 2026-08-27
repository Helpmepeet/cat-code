import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _forTest } from './migrateFromUpstreamClaude.js'

const roots: string[] = []
const CHILD = join(import.meta.dir, 'migrateFromUpstreamClaude.probe.child.ts')

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitForReady(file: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`upstream migration child PID ${pid} did not become ready`)
    }
    await Bun.sleep(10)
  }
  expect(Number(readFileSync(file, 'utf8'))).toBe(pid)
}

describe('upstream config-home migration locking', () => {
  test('existing destination skips without acquiring the migration lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-code-upstream-migration-skip-'))
    roots.push(root)
    const destination = join(root, '.cat-code')
    mkdirSync(destination)

    await _forTest.migrateFromPaths(destination, [])

    expect(existsSync(`${destination}.migration.lock`)).toBe(false)
  })

  test('an immediate contender waits for and reclaims a crash-stale lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-code-upstream-migration-stale-'))
    roots.push(root)
    const destination = join(root, '.cat-code')
    const sourceDir = join(root, '.claude')
    const sourceJson = join(root, '.claude.json')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'settings.json'), '{"model":"synthetic-model"}')
    writeFileSync(sourceJson, '{"syntheticGlobal":"preserved"}')

    const baseEnv = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      UPSTREAM_MIGRATION_PROBE_ROOT: root,
      UPSTREAM_MIGRATION_DESTINATION: destination,
      UPSTREAM_MIGRATION_SOURCE_DIR: sourceDir,
      UPSTREAM_MIGRATION_SOURCE_JSON: sourceJson,
    }
    const owner = Bun.spawn([process.execPath, 'run', CHILD], {
      env: { ...baseEnv, UPSTREAM_MIGRATION_PROBE_ROLE: 'crash-owner' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const ownerPid = owner.pid
    let contender: ReturnType<typeof Bun.spawn> | undefined
    try {
      await waitForReady(join(root, 'ready-crash-owner'), ownerPid)
      owner.kill('SIGKILL')
      expect(await owner.exited).not.toBe(0)
      expect(existsSync(`${destination}.migration.lock`)).toBe(true)

      const contenderStartedAt = Date.now()
      contender = Bun.spawn([process.execPath, 'run', CHILD], {
        env: { ...baseEnv, UPSTREAM_MIGRATION_PROBE_ROLE: 'contender' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const contenderPid = contender.pid
      await waitForReady(join(root, 'ready-contender'), contenderPid)
      writeFileSync(join(root, 'start'), String(contenderPid))

      const timeout = setTimeout(() => {
        if (contender?.exitCode === null) contender.kill('SIGKILL')
      }, 15_000)
      let exitCode: number
      try {
        exitCode = await contender.exited
      } finally {
        clearTimeout(timeout)
      }
      const stderr = await new Response(contender.stderr).text()
      expect(exitCode, stderr).toBe(0)
      expect(Date.now() - contenderStartedAt).toBeGreaterThanOrEqual(3_500)
      expect(JSON.parse(await new Response(contender.stdout).text())).toMatchObject({
        role: 'contender',
        pid: contenderPid,
        elapsedMs: expect.any(Number),
      })
      expect(
        JSON.parse(readFileSync(join(destination, '.cat-code.json'), 'utf8')),
      ).toEqual({ syntheticGlobal: 'preserved' })
      expect(readFileSync(join(destination, 'settings.json'), 'utf8')).toBe(
        '{"model":"synthetic-model"}',
      )
      expect(existsSync(join(destination, '.migrated-to-cat-code'))).toBe(true)
    } finally {
      if (owner.exitCode === null) owner.kill('SIGKILL')
      if (contender?.exitCode === null) contender.kill('SIGKILL')
      await owner.exited
      if (contender) await contender.exited
    }
  }, 20_000)
})
