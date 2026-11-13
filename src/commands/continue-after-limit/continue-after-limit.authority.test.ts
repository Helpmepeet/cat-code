import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import * as lockfile from '../../utils/lockfile.js'
import {
  createPendingDeferredContinuation,
  DEFERRED_LOCK_UPDATE_MS,
  getDeferredContinuationLockTargets,
  getDeferredContinuationPaths,
  getLatestDeferredContinuationHistory,
  readPendingDeferredContinuation,
  type DeferredContinuationJobV1,
} from '../../services/deferredContinuation.js'
import { call } from './continue-after-limit.js'

test.each(['creation', 'cancellation'] as const)('%s cannot mutate a job after losing its session lock', async operation => {
  const root = await fs.mkdtemp('/tmp/cat-code-continuation-authority-')
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousSession = getSessionId()
  const previousProject = getSessionProjectDir()
  process.env.CLAUDE_CONFIG_DIR = root
  const now = Date.now()
  const job: DeferredContinuationJobV1 = {
    version: 1,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectStorageKey: '-project',
    context: { cwd: '/project', model: 'gpt-test', permissionMode: 'default' },
    createdAt: now,
    statusObservedAt: now,
    scheduleReason: 'account_available',
    notBefore: now,
    state: 'pending',
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
    },
    transientRetries: 0,
  }
  const paths = getDeferredContinuationPaths()
  const targets = getDeferredContinuationLockTargets(job, paths)
  const originalLock = lockfile.lock
  const originalRename = fs.rename
  const originalLstat = fs.lstat
  let compromised!: () => void
  const detected = new Promise<void>(resolve => { compromised = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  let ownershipLost = false
  const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) =>
    originalLock(target, {
      ...options,
      onCompromised: error => {
        options?.onCompromised?.(error)
        if (target === targets.session) compromised()
      },
    }),
  )
  const loseSessionLock = async () => {
    ownershipLost = true
    await fs.rm(`${targets.session}.lock`, { recursive: true })
    await Promise.race([
      detected,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Continuation lock loss was not detected')),
          DEFERRED_LOCK_UPDATE_MS + 10_000,
        )
      }),
    ])
    clearTimeout(timer)
  }
  const lstatSpy = spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    try {
      return await originalLstat(args[0], args[1])
    } catch (error) {
      if (
        operation === 'creation' &&
        !ownershipLost &&
        args[0] === join(paths.pending, `${job.sessionId}.json`) &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // Revoke the real guard after observing the empty queue but before
        // creation can publish its pending record.
        await loseSessionLock()
      }
      throw error
    }
  }) as typeof fs.lstat)
  const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await originalRename(from, to)
    if (operation !== 'cancellation' || to !== join(paths.tmp, `notice-${job.sessionId}.json`)) return
    // Revoke the real guard after notice publication but before cancellation
    // can write history or unlink the pending job.
    await loseSessionLock()
  })
  try {
    if (operation === 'cancellation') await createPendingDeferredContinuation(job)
    switchSession(asSessionId(job.sessionId))

    const action = operation === 'creation'
      ? createPendingDeferredContinuation(job)
      : call(() => {}, { isQueryActive: false } as never, 'cancel')
    await expect(action).rejects.toThrow()

    expect(await readPendingDeferredContinuation(job.sessionId)).toEqual(
      operation === 'creation' ? null : job,
    )
    expect(await getLatestDeferredContinuationHistory(job.sessionId)).toBeNull()
  } finally {
    clearTimeout(timer)
    lstatSpy.mockRestore()
    renameSpy.mockRestore()
    lockSpy.mockRestore()
    await Promise.all(
      [targets.session, targets.job].map(target =>
        lockfile.unlock(target, { realpath: false }).catch(() => {}),
      ),
    )
    switchSession(previousSession, previousProject)
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)
