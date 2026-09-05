/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull this
 * cost into the startup path even when no locking happens (e.g. `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The underlying
 * package is only loaded the first time a lock function is actually called.
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'
import { logForDebugging } from './debug.js'
import { getErrnoCode } from './errors.js'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}

/**
 * Blocking cross-process mutation lock: spin on ELOCKED until the lock is ours
 * or `waitMs` elapses, then hand back an idempotent release.
 *
 * Shared verbatim by the Codex vault, the Claude vault and secure storage,
 * which all serialize whole-file rewrites across engine processes. Nothing here
 * is incidental: the 120s stale window plus 30s refresh is what lets a slow
 * writer keep a lock a reader will still respect, `realpath: false` allows
 * locking a path that does not exist yet, and swallowing ERELEASED on release
 * keeps a double release (finally plus an explicit call) from throwing.
 */
export function acquireMutationLockSync(
  target: string,
  options: { label: string; waitMs: number },
): () => void {
  const deadline = Date.now() + options.waitMs
  for (;;) {
    try {
      const release = lockSync(target, {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        onCompromised: error => {
          logForDebugging(
            `${options.label} lock compromised: ${error.message}`,
            { level: 'error' },
          )
        },
      })
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          release()
        } catch (error) {
          if (getErrnoCode(error) !== 'ERELEASED') throw error
        }
      }
    } catch (error) {
      if (getErrnoCode(error) !== 'ELOCKED' || Date.now() >= deadline) {
        throw error
      }
      Bun.sleepSync(20)
    }
  }
}
