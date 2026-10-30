// Scheduler lease lock for .cat-code/scheduled_tasks.json.
//
// When multiple Cat Code sessions run in the same project directory, only one
// should drive the cron scheduler. The first session to acquire this lock
// becomes the scheduler; others stay passive and periodically probe the lock.
// If the owner dies (PID no longer running), a passive session takes over.
//
// All lock-file decisions run under a kernel mutation lock. Exclusive creation
// alone cannot serialize stale read/unlink/recreate or release read/unlink.

import { mkdir, open, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getErrnoCode } from './errors.js'
import { safeParseJSON } from './json.js'
import { lazySchema } from './lazySchema.js'
import { jsonStringify } from './slowOperations.js'

const LOCK_FILE_REL = join('.cat-code', 'scheduled_tasks.lock')

const schedulerLockSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),
    pid: z.number().int().positive(),
    acquiredAt: z.number(),
  }),
)
type SchedulerLock = z.infer<ReturnType<typeof schedulerLockSchema>>

/**
 * Options for out-of-REPL callers (Agent SDK daemon) that don't have
 * bootstrap state. When omitted, falls back to getProjectRoot() +
 * getSessionId() as before. lockIdentity should be stable for the lifetime
 * of one daemon process (e.g. a randomUUID() captured at startup).
 */
export type SchedulerLockOptions = {
  dir?: string
  lockIdentity?: string
}

const cleanupByPath = new Map<string, () => void>()
// Suppress repeat "held by X" log lines when polling a live owner.
let lastBlockedBy: string | undefined

function getLockPath(dir?: string): string {
  return resolve(dir ?? getProjectRoot(), LOCK_FILE_REL)
}

let tryGuard: ((fd: number) => boolean) | undefined

/**
 * Never unlink the guard: every contender must lock the same inode, including
 * after a process dies. Unlike a time-based lease, flock cannot expire while
 * its owner is paused between reading and unlinking the scheduler record.
 */
async function withMutationLock<T>(
  dir: string | undefined,
  blocked: T,
  mutate: () => Promise<T>,
): Promise<T> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Scheduler locking requires macOS or Linux')
  }
  if (!tryGuard) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const errnoName = process.platform === 'darwin' ? '__error' : '__errno_location'
    const library = ffi.dlopen(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      {
        flock: { args: ['i32', 'i32'], returns: 'i32' },
        [errnoName]: { args: [], returns: 'ptr' },
      } as const,
    )
    tryGuard = fd => {
      // LOCK_EX | LOCK_NB. Never block Bun's event loop on another process.
      if (library.symbols.flock(fd, 2 | 4) === 0) return true
      const errnoPointer = library.symbols[errnoName]()
      const errno = errnoPointer ? ffi.read.i32(errnoPointer) : undefined
      const wouldBlock = process.platform === 'darwin' ? 35 : 11
      if (errno === wouldBlock || errno === 4 /* EINTR */) return false
      throw new Error(`Scheduler guard flock failed (errno ${errno})`)
    }
  }
  const path = getLockPath(dir)
  await mkdir(dirname(path), { recursive: true })
  const guard = await open(`${path}.guard`, 'a', 0o600)
  try {
    // A passive scheduler will retry on its next probe.
    if (!tryGuard(guard.fd)) return blocked
    return await mutate()
  } finally {
    // Closing the descriptor also releases the lock after an exception.
    await guard.close()
  }
}

function isOwnerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM (or an inconclusive probe) is not proof that the owner died.
    return getErrnoCode(error) !== 'ESRCH'
  }
}

async function readLock(dir?: string): Promise<SchedulerLock | undefined> {
  let raw: string
  try {
    raw = await readFile(getLockPath(dir), 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  const result = schedulerLockSchema().safeParse(safeParseJSON(raw, false))
  return result.success ? result.data : undefined
}

async function tryCreateExclusive(
  lock: SchedulerLock,
  dir?: string,
): Promise<boolean> {
  const path = getLockPath(dir)
  const body = jsonStringify(lock)
  try {
    await writeFile(path, body, { flag: 'wx' })
    return true
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'EEXIST') return false
    if (code === 'ENOENT') {
      // .cat-code/ doesn't exist yet — create it and retry once. In steady
      // state the dir already exists (scheduled_tasks.json lives there),
      // so this path is hit at most once.
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, body, { flag: 'wx' })
        return true
      } catch (retryErr: unknown) {
        if (getErrnoCode(retryErr) === 'EEXIST') return false
        throw retryErr
      }
    }
    throw e
  }
}

function registerLockCleanup(opts?: SchedulerLockOptions): void {
  const path = getLockPath(opts?.dir)
  cleanupByPath.get(path)?.()
  // Capture defaults now, not the possibly changed bootstrap state at exit.
  const owner = {
    dir: opts?.dir ?? getProjectRoot(),
    lockIdentity: opts?.lockIdentity ?? getSessionId(),
  }
  cleanupByPath.set(
    path,
    registerCleanup(async () => {
      await releaseSchedulerLock(owner)
    }),
  )
}

/**
 * Try to acquire the scheduler lock for the current session.
 * Returns true on success, false if another live session holds it.
 *
 * Uses O_EXCL ('wx') for atomic test-and-set. If the file exists:
 *   - Already our session AND process → true (idempotent re-acquire)
 *   - Another live PID → false
 *   - Stale (PID dead / corrupt) → unlink and retry exclusive create once
 *
 * The mutation guard serializes the entire decision, not just creation.
 */
export async function tryAcquireSchedulerLock(
  opts?: SchedulerLockOptions,
): Promise<boolean> {
  const owner = {
    dir: resolve(opts?.dir ?? getProjectRoot()),
    lockIdentity: opts?.lockIdentity ?? getSessionId(),
  }
  return withMutationLock(owner.dir, false, () => acquireUnderGuard(owner))
}

async function acquireUnderGuard(opts?: SchedulerLockOptions): Promise<boolean> {
  const dir = opts?.dir
  // "sessionId" in the lock file is really just a stable owner key. REPL
  // uses getSessionId(); daemon callers supply their own UUID. PID remains
  // the liveness signal regardless.
  const sessionId = opts?.lockIdentity ?? getSessionId()
  const lock: SchedulerLock = {
    sessionId,
    pid: process.pid,
    acquiredAt: Date.now(),
  }

  if (await tryCreateExclusive(lock, dir)) {
    lastBlockedBy = undefined
    registerLockCleanup(opts)
    logForDebugging(
      `[ScheduledTasks] acquired scheduler lock (PID ${process.pid})`,
    )
    return true
  }

  const existing = await readLock(dir)

  // A resumed identity is not authority over a still-running foreign process.
  if (existing?.sessionId === sessionId && existing.pid === process.pid) {
    registerLockCleanup(opts)
    return true
  }

  // Corrupt or unparseable — treat as stale.
  // Another live session — blocked.
  if (existing && isOwnerRunning(existing.pid)) {
    if (lastBlockedBy !== existing.sessionId) {
      lastBlockedBy = existing.sessionId
      logForDebugging(
        `[ScheduledTasks] scheduler lock held by session ${existing.sessionId} (PID ${existing.pid})`,
      )
    }
    return false
  }

  // Stale — unlink and retry the exclusive create once.
  if (existing) {
    logForDebugging(
      `[ScheduledTasks] recovering stale scheduler lock from PID ${existing.pid}`,
    )
  }
  try {
    await unlink(getLockPath(dir))
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') throw error
  }
  if (await tryCreateExclusive(lock, dir)) {
    lastBlockedBy = undefined
    registerLockCleanup(opts)
    return true
  }
  // Fail closed if an uncoordinated writer created a record under the guard.
  return false
}

/**
 * Release the scheduler lock if the current session owns it.
 */
export async function releaseSchedulerLock(
  opts?: SchedulerLockOptions,
): Promise<void> {
  const dir = resolve(opts?.dir ?? getProjectRoot())
  const sessionId = opts?.lockIdentity ?? getSessionId()
  // Unlike acquisition, cleanup must not be abandoned on transient contention.
  for (;;) {
    const released = await withMutationLock(dir, false, async () => {
      const existing = await readLock(dir)
      if (
        !existing ||
        existing.sessionId !== sessionId ||
        existing.pid !== process.pid
      ) return true
      await unlink(getLockPath(dir))
      cleanupByPath.get(getLockPath(dir))?.()
      cleanupByPath.delete(getLockPath(dir))
      lastBlockedBy = undefined
      logForDebugging('[ScheduledTasks] released scheduler lock')
      return true
    })
    if (released) return
    await Bun.sleep(10)
  }
}
