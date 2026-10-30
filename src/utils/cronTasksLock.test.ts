import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs/promises'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './cronTasksLock.js'
import { runCleanupFunctions } from './cleanupRegistry.js'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cron-lock-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.cat-code'))
  const path = join(dir, '.cat-code/scheduled_tasks.lock')
  writeFileSync(
    path,
    JSON.stringify({ sessionId: 'dead', pid: 2147483647, acquiredAt: 1 }),
  )
  return { dir, path }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('stale recovery cannot delete a successful competing claim', async () => {
  const { dir, path } = fixture()
  const original = fs.unlink
  let unlinks = 0
  let resume!: () => void
  let atFirstUnlink!: () => void
  const firstAtUnlink = new Promise<void>(resolve => { atFirstUnlink = resolve })
  let allowFirst!: () => void
  const firstMayProceed = new Promise<void>(resolve => { allowFirst = resolve })
  const firstFinished = new Promise<void>(resolve => { resume = resolve })
  const spy = spyOn(fs, 'unlink').mockImplementation(async target => {
    if (target === path) {
      if (++unlinks === 1) {
        atFirstUnlink()
        await firstMayProceed
      } else if (unlinks === 2) {
        allowFirst()
        await firstFinished
      }
    }
    return original(target)
  })
  try {
    const a = tryAcquireSchedulerLock({ dir, lockIdentity: 'a' }).finally(resume)
    await firstAtUnlink
    // Old code reaches the second unlink; guarded code returns blocked.
    // Either event lets A continue without timing assumptions.
    const b = tryAcquireSchedulerLock({ dir, lockIdentity: 'b' }).finally(allowFirst)
    const results = await Promise.all([a, b])
    expect(results.filter(Boolean)).toHaveLength(1)
  } finally {
    allowFirst()
    resume()
    spy.mockRestore()
    await releaseSchedulerLock({ dir, lockIdentity: 'a' })
    await releaseSchedulerLock({ dir, lockIdentity: 'b' })
  }
})

test('same-process reacquisition is idempotent and cleanup covers every project', async () => {
  const first = fixture()
  const second = fixture()
  const a = { dir: first.dir, lockIdentity: 'owner' }
  const b = { dir: second.dir, lockIdentity: 'other-project' }
  expect(await tryAcquireSchedulerLock(a)).toBe(true)
  const record = readFileSync(first.path, 'utf8')
  expect(await tryAcquireSchedulerLock(a)).toBe(true)
  expect(readFileSync(first.path, 'utf8')).toBe(record)
  expect(await tryAcquireSchedulerLock(b)).toBe(true)
  await releaseSchedulerLock({ ...a, lockIdentity: 'not-owner' })
  expect(existsSync(first.path)).toBe(true)
  await runCleanupFunctions()
  expect(existsSync(first.path)).toBe(false)
  expect(existsSync(second.path)).toBe(false)
})

test('a dead same-identity owner can restart; corrupt records can be recovered', async () => {
  const { dir, path } = fixture()
  const opts = { dir, lockIdentity: 'dead' }
  expect(await tryAcquireSchedulerLock(opts)).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
  await releaseSchedulerLock(opts)
  writeFileSync(path, '{broken')
  expect(await tryAcquireSchedulerLock(opts)).toBe(true)
  await releaseSchedulerLock(opts)
})

test('read errors are not treated as proof of a stale owner', async () => {
  const { dir, path } = fixture()
  const original = fs.readFile
  const spy = spyOn(fs, 'readFile').mockImplementation(
    (async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
      return original(...args)
    }) as typeof fs.readFile,
  )
  try {
    await expect(tryAcquireSchedulerLock({ dir, lockIdentity: 'new' })).rejects.toThrow('denied')
    expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('dead')
  } finally {
    spy.mockRestore()
  }
  expect(await tryAcquireSchedulerLock({ dir, lockIdentity: 'new' })).toBe(true)
  await releaseSchedulerLock({ dir, lockIdentity: 'new' })
})

test('release serializes its ownership read and unlink against reacquisition', async () => {
  const { dir, path } = fixture()
  const opts = { dir, lockIdentity: 'owner' }
  expect(await tryAcquireSchedulerLock(opts)).toBe(true)
  const original = fs.readFile
  let reached!: () => void
  let resume!: () => void
  const atRead = new Promise<void>(resolve => { reached = resolve })
  const mayUnlink = new Promise<void>(resolve => { resume = resolve })
  let pause = true
  const spy = spyOn(fs, 'readFile').mockImplementation(
    (async (...args: Parameters<typeof fs.readFile>) => {
      const value = await original(...args)
      if (args[0] === path && pause) {
        pause = false
        reached()
        await mayUnlink
      }
      return value
    }) as typeof fs.readFile,
  )
  const release = releaseSchedulerLock(opts)
  try {
    await atRead
    expect(await tryAcquireSchedulerLock(opts)).toBe(false)
  } finally {
    resume()
    await release
    spy.mockRestore()
  }
  expect(await tryAcquireSchedulerLock(opts)).toBe(true)
  expect(existsSync(path)).toBe(true)
  await releaseSchedulerLock(opts)
})

test('permission-denied PID probes preserve an existing owner', async () => {
  const { dir, path } = fixture()
  const original = process.kill
  const spy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 2147483647) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return original(pid, signal)
  })
  try {
    expect(await tryAcquireSchedulerLock({ dir, lockIdentity: 'new' })).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('dead')
  } finally {
    spy.mockRestore()
  }
})

const childSource = `
import { tryAcquireSchedulerLock, releaseSchedulerLock } from ${JSON.stringify(join(import.meta.dir, 'cronTasksLock.ts'))}
const opts = { dir: process.env.PROBE_DIR, lockIdentity: process.env.PROBE_ID }
if (process.env.PROBE_GUARD) {
  const { open } = await import('fs/promises')
  const { dlopen } = await import('bun:ffi')
  const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { flock: { args: ['i32', 'i32'], returns: 'i32' } })
  const file = await open(opts.dir + '/.cat-code/scheduled_tasks.lock.guard', 'a')
  if (lib.symbols.flock(file.fd, 2 | 4) !== 0) throw new Error('guard busy')
  console.log(JSON.stringify({ acquired: true, pid: process.pid }))
  await Bun.stdin.text()
  await file.close()
} else {
  const acquired = await tryAcquireSchedulerLock(opts)
  console.log(JSON.stringify({ acquired, pid: process.pid }))
  await Bun.stdin.text()
  if (acquired) await releaseSchedulerLock(opts)
}
`

function child(dir: string, identity: string, guard = false) {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', childSource],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, 'config'),
      NODE_ENV: 'test',
      PROBE_DIR: dir,
      PROBE_ID: identity,
      ...(guard ? { PROBE_GUARD: '1' } : {}),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const result = (async () => {
    const reader = proc.stdout.getReader()
    let text = ''
    const timeout = setTimeout(() => proc.kill(), 10_000)
    try {
      while (!text.includes('\n')) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`Child exited before ready: ${await new Response(proc.stderr).text()}`)
        text += new TextDecoder().decode(value)
      }
      return JSON.parse(text.trim()) as { acquired: boolean; pid: number }
    } finally {
      clearTimeout(timeout)
      reader.releaseLock()
    }
  })()
  return {
    proc,
    result,
    async stop() {
      proc.stdin.end()
      expect(await proc.exited).toBe(0)
      expect(await new Response(proc.stderr).text()).toBe('')
    },
    async kill() {
      proc.kill('SIGKILL')
      await proc.exited
    },
  }
}

test('real processes elect one stale-recovery owner and recover after its death', async () => {
  const { dir, path } = fixture()
  const contenders = Array.from({ length: 6 }, (_, i) => child(dir, `child-${i}`))
  try {
    const results = await Promise.all(contenders.map(c => c.result))
    expect(results.filter(r => r.acquired)).toHaveLength(1)
    const index = results.findIndex(r => r.acquired)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(results[index]!.pid)
    await contenders[index]!.kill()
    const opts = { dir, lockIdentity: `child-${index}` }
    expect(await tryAcquireSchedulerLock(opts)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
    await releaseSchedulerLock(opts)
    await Promise.all(contenders.filter((_, i) => i !== index).map(c => c.stop()))
  } finally {
    await Promise.all(contenders.map(async c => {
      if (c.proc.exitCode === null) await c.kill()
    }))
  }
})

test('a live foreign process cannot be overwritten or released by its session identity', async () => {
  const { dir, path } = fixture()
  const owner = child(dir, 'shared-identity')
  try {
    const result = await owner.result
    expect(result.acquired).toBe(true)
    const record = readFileSync(path, 'utf8')
    const opts = { dir, lockIdentity: 'shared-identity' }
    expect(await tryAcquireSchedulerLock(opts)).toBe(false)
    await releaseSchedulerLock(opts)
    expect(readFileSync(path, 'utf8')).toBe(record)
    await owner.stop()
    expect(existsSync(path)).toBe(false)
  } finally {
    if (owner.proc.exitCode === null) await owner.kill()
  }
})

test('kernel guard survives contention and is released by process death', async () => {
  const { dir, path } = fixture()
  const guard = child(dir, 'guard', true)
  try {
    await guard.result
    const opts = { dir, lockIdentity: 'next' }
    const original = readFileSync(path, 'utf8')
    expect(await tryAcquireSchedulerLock(opts)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(original)
    await guard.kill()
    expect(await tryAcquireSchedulerLock(opts)).toBe(true)
    await releaseSchedulerLock(opts)
    // The guard inode must remain stable across all owners.
    expect(existsSync(`${path}.guard`)).toBe(true)
  } finally {
    if (guard.proc.exitCode === null) await guard.kill()
  }
})
