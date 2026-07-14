import { afterEach, describe, expect, test } from 'bun:test'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireDeferredContinuationLocks,
  type DeferredContinuationJobV1,
} from './deferredContinuation.js'

const CHILD = join(import.meta.dir, 'deferredContinuation.probe.child.ts')
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await Bun.sleep(10)
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function probeJob(notBefore: number): DeferredContinuationJobV1 {
  return {
    version: 1,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectStorageKey: '-project',
    context: { cwd: '/project', model: 'gpt-test', permissionMode: 'default' },
    createdAt: Date.now(),
    statusObservedAt: Date.now(),
    scheduleReason: 'hard_quota_reset',
    resetAt: notBefore - 60_000,
    notBefore,
    state: 'pending',
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
    },
    transientRetries: 0,
  }
}

async function seedQueue(config: string, contents: unknown): Promise<string> {
  const queue = join(config, 'deferred-continuations')
  for (const path of [queue, join(queue, 'pending'), join(queue, 'history'), join(queue, 'locks'), join(queue, 'tmp')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
  const pending = join(queue, 'pending', '22222222-2222-4222-8222-222222222222.json')
  await writeFile(pending, `${JSON.stringify(contents)}\n`, { mode: 0o600 })
  return pending
}

async function runHiddenWorker(config: string) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      join(import.meta.dir, '../entrypoints/cli.tsx'),
      'deferred-continuation-worker',
    ],
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
}

describe('deferred continuation process probes', () => {
  test('two fresh processes have exactly one simultaneous lock owner', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-probe-')
    cleanup.push(root)
    const go = join(root, 'go')
    const winners = join(root, 'winners')
    await writeFile(winners, '')
    const baseEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      PROBE_SESSION_ID: '22222222-2222-4222-8222-222222222222',
      PROBE_JOB_ID: '11111111-1111-4111-8111-111111111111',
      PROBE_GO: go,
      PROBE_WINNERS: winners,
    }
    const children = [0, 1].map(index =>
      Bun.spawn({
        cmd: [process.execPath, 'run', CHILD],
        env: { ...baseEnv, PROBE_READY: join(root, `ready-${index}`) },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    await Promise.all([waitFor(join(root, 'ready-0')), waitFor(join(root, 'ready-1'))])
    await writeFile(go, 'go')
    const outputs = await Promise.all(
      children.map(async child => {
        const output = await new Response(child.stdout).text()
        await child.exited
        return output
      }),
    )
    expect(outputs.filter(output => output.includes('RESULT:acquired'))).toHaveLength(1)
    expect((await readFile(winners, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  test('empty hidden worker exits without entering normal bootstrap', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-empty-worker-')
    cleanup.push(root)
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        join(import.meta.dir, '../entrypoints/cli.tsx'),
        'deferred-continuation-worker',
      ],
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toBe('')
  })

  test('fresh worker ignores future and malformed records without changing them', async () => {
    for (const value of [probeJob(Date.now() + 60_000), { malformed: true }]) {
      const root = await mkdtemp('/tmp/cat-code-deferred-inert-worker-')
      cleanup.push(root)
      const config = join(root, 'config')
      const pending = await seedQueue(config, value)
      const before = await readFile(pending, 'utf8')
      const [stdout, stderr, exitCode] = await runHiddenWorker(config)
      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      expect(await readFile(pending, 'utf8')).toBe(before)
    }
  })

  test('fresh worker loses cleanly to a foreground-owned job lock', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-foreground-race-')
    cleanup.push(root)
    const config = join(root, 'config')
    const value = probeJob(Date.now() - 1)
    const pending = await seedQueue(config, value)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    const guard = await acquireDeferredContinuationLocks(value)
    try {
      const [stdout, stderr, exitCode] = await runHiddenWorker(config)
      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      expect(JSON.parse(await readFile(pending, 'utf8')).state).toBe('pending')
    } finally {
      await guard.release()
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })
})
