import { chmod, lstat, mkdir, open, unlink } from 'fs/promises'
import { join } from 'path'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { lock } from './lockfile.js'
import { validateUuid } from './uuid.js'

const LEASE_STALE_MS = 120_000
const LEASE_UPDATE_MS = 20_000

type LeaseGuard = {
  sessionId: string
  target: string
  assertHealthy(): void
  release(): Promise<void>
}

export class TranscriptInUseError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} is already open in another Cat Code process. Close it there before resuming it here.`,
    )
    this.name = 'TranscriptInUseError'
  }
}

let activeLease: LeaseGuard | null = null
let transition: Promise<void> = Promise.resolve()
let cleanupRegistered = false

function isAlreadyReleasedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERELEASED'
  )
}

async function releaseLease(lease: LeaseGuard): Promise<void> {
  try {
    await lease.release()
  } catch (error) {
    if (!isAlreadyReleasedError(error)) throw error
  }
}

function logReleaseFailure(context: string, error: unknown): void {
  try {
    const detail = (error instanceof Error ? error.message : String(error)).slice(
      0,
      512,
    )
    logForDebugging(`${context}: ${detail}`, { level: 'warn' })
  } catch {
    // Cleanup and guard transition must not fail because diagnostics did.
  }
}

function leaseDirectory(): string {
  return join(getClaudeConfigHomeDir(), 'transcript-leases')
}

function leaseTarget(sessionId: string): string {
  if (!validateUuid(sessionId)) throw new Error('Invalid transcript session ID')
  return join(leaseDirectory(), `${sessionId}.lease`)
}

async function ensureLeaseTarget(sessionId: string): Promise<string> {
  const dir = leaseDirectory()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const target = leaseTarget(sessionId)
  let info: Awaited<ReturnType<typeof lstat>>
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(target, 'wx', 0o600)
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      info = await lstat(target)
      break
    } catch (error) {
      // An unowned cleanup may have released `${target}.lock` and unlinked the
      // zero-byte target between our EEXIST and lstat. Recreate and revalidate
      // in a bounded loop; realpath:false means the lock path itself is stable.
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        attempt >= 2
      ) {
        throw error
      }
    }
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Transcript lease target failed private-file validation')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Transcript lease target has the wrong owner')
  }
  return target
}

async function acquireLease(sessionId: string): Promise<LeaseGuard> {
  const target = await ensureLeaseTarget(sessionId)
  let compromised: Error | null = null
  let release: () => Promise<void>
  try {
    release = await lock(target, {
      realpath: false,
      stale: LEASE_STALE_MS,
      update: LEASE_UPDATE_MS,
      retries: 0,
      onCompromised(error) {
        compromised = error
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new TranscriptInUseError(sessionId)
    }
    throw error
  }
  return {
    sessionId,
    target,
    assertHealthy() {
      if (compromised) throw compromised
    },
    release,
  }
}

function registerLeaseCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  registerCleanup(async () => {
    await releaseActiveTranscriptLease().catch(error => {
      logReleaseFailure('Transcript lease cleanup release failed', error)
    })
  })
}

export async function activateTranscriptLease(sessionId: string): Promise<void> {
  const operation = transition.then(async () => {
    if (activeLease?.sessionId === sessionId) {
      try {
        activeLease.assertHealthy()
        return
      } catch {
        // The guard was compromised. Re-acquire below rather than leaving a
        // dead guard pinned to this session.
      }
    }
    const next = await acquireLease(sessionId)
    const previous = activeLease
    // Pin the newly acquired guard before touching the old one. Session state
    // switches immediately after activation returns, so from this point forward
    // every lease assertion must observe `next`, even if releasing a compromised
    // prior guard reports an unexpected failure.
    activeLease = next
    registerLeaseCleanup()
    if (previous) {
      await releaseLease(previous).catch(error => {
        logReleaseFailure('Previous transcript lease release failed', error)
      })
    }
  })
  transition = operation.catch(() => {})
  return operation
}

export async function releaseActiveTranscriptLease(): Promise<void> {
  const operation = transition.then(async () => {
    const lease = activeLease
    activeLease = null
    if (lease) await releaseLease(lease)
  })
  transition = operation.catch(() => {})
  return operation
}

export async function withUnownedTranscriptLease<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (activeLease?.sessionId === sessionId) return { acquired: false }
  let guard: LeaseGuard
  try {
    guard = await acquireLease(sessionId)
  } catch (error) {
    if (error instanceof TranscriptInUseError) return { acquired: false }
    throw error
  }
  try {
    guard.assertHealthy()
    const value = await operation()
    guard.assertHealthy()
    return { acquired: true, value }
  } finally {
    await releaseLease(guard)
    // `proper-lockfile` owns `${target}.lock`; with `realpath:false` the
    // zero-byte target is not the lock itself. Remove it only after release.
    // A contender that races in between may already hold `${target}.lock`;
    // unlinking/recreating the target does not disturb that guard, and every
    // future acquire validates or recreates the target before locking.
    await unlink(guard.target).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/**
 * Assert synchronously that this process still owns the active transcript.
 * Persistence callers use this immediately before enqueueing or writing so a
 * proper-lockfile compromise fails closed rather than appending as a former
 * owner.
 */
export function assertActiveTranscriptLease(sessionId: string): void {
  if (!activeLease) return
  if (activeLease.sessionId !== sessionId) {
    throw new Error(`No active transcript lease for session ${sessionId}`)
  }
  activeLease.assertHealthy()
}
