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

test('cancel cannot retire a job after losing its session lock during notice publication', async () => {
  const root = await fs.mkdtemp('/tmp/cat-code-cancel-authority-')
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
  let compromised!: () => void
  const detected = new Promise<void>(resolve => { compromised = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) =>
    originalLock(target, {
      ...options,
      onCompromised: error => {
        options?.onCompromised?.(error)
        if (target === targets.session) compromised()
      },
    }),
  )
  const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await originalRename(from, to)
    if (to !== join(paths.tmp, `notice-${job.sessionId}.json`)) return
    // Pause only after the real notice has been published. Removing the real
    // session lock lets proper-lockfile's heartbeat revoke the caller's guard
    // before cancellation can write history or unlink the pending job.
    await fs.rm(`${targets.session}.lock`, { recursive: true })
    await Promise.race([
      detected,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cancellation lock loss was not detected')),
          DEFERRED_LOCK_UPDATE_MS + 10_000,
        )
      }),
    ])
    clearTimeout(timer)
  })
  try {
    await createPendingDeferredContinuation(job)
    switchSession(asSessionId(job.sessionId))

    await expect(call(() => {}, { isQueryActive: false } as never, 'cancel')).rejects.toThrow()

    expect(await readPendingDeferredContinuation(job.sessionId)).toEqual(job)
    expect(await getLatestDeferredContinuationHistory(job.sessionId)).toBeNull()
  } finally {
    clearTimeout(timer)
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
