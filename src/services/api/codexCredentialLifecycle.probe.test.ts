import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c2'
const CHILD_ENTRY = join(
  import.meta.dir,
  'codexCredentialLifecycle.probe.child.ts',
)
const scratchDirectory = mkdtempSync(
  join(tmpdir(), 'codex-credential-lifecycle-probe-'),
)

type ChildResult = {
  ok: boolean
  role?: string
  waitedMs?: number
  error?: string
}

function spawnChild(
  role: 'holder' | 'waiter',
  directory: string,
  readyPath: string,
  delayMs: number,
): Promise<ChildResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      CHILD_ENTRY,
      role,
      directory,
      ACCOUNT_ID,
      readyPath,
      String(delayMs),
    ],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'development',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const exitCode = await child.exited
    const line = stdout
      .split('\n')
      .find(value => value.startsWith('RESULT:'))
    if (!line) {
      throw new Error(
        `lifecycle probe child printed no RESULT line (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
    }
    return JSON.parse(line.slice('RESULT:'.length)) as ChildResult
  })()
}

afterAll(() => {
  rmSync(scratchDirectory, { recursive: true, force: true })
})

describe('Codex credential lifecycle cross-process lock', () => {
  test('serializes two engine processes on one account lock', async () => {
    const directory = join(scratchDirectory, 'shared-lifecycle')
    const readyPath = join(scratchDirectory, 'holder.ready')
    const holder = spawnChild('holder', directory, readyPath, 500)

    const startedAt = Date.now()
    while (!existsSync(readyPath)) {
      if (Date.now() - startedAt > 20_000) {
        throw new Error('timed out waiting for lifecycle lock holder')
      }
      await Bun.sleep(10)
    }

    const waiter = spawnChild('waiter', directory, readyPath, 0)
    const [holderResult, waiterResult] = await Promise.all([holder, waiter])

    expect(holderResult).toMatchObject({ ok: true, role: 'holder' })
    expect(waiterResult).toMatchObject({ ok: true, role: 'waiter' })
    expect(waiterResult.waitedMs).toBeGreaterThanOrEqual(300)
  })
})
