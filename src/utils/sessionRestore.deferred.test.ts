import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireDeferredContinuationLocks,
  createPendingDeferredContinuation,
  DEFERRED_LOCK_STALE_MS,
  getDeferredContinuationLockTargets,
  getDeferredContinuationPaths,
  readPendingDeferredContinuation,
} from '../services/deferredContinuation.js'
import {
  checkDeferredContinuationResume,
  DEFERRED_RESUME_BUSY_NOTICE,
  processResumedConversation,
  restoreTrustedDeferredContinuationContext,
} from './sessionRestore.js'
import { setCwd } from './Shell.js'

const cleanup: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
  process.chdir(originalCwd)
  setCwd(originalCwd)
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('trusted deferred continuation context restoration', () => {
  test('restores a canonical cwd only when it is contained by transcript project identity', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-context-')
    cleanup.push(root)
    const project = join(root, 'project')
    const child = join(project, 'nested')
    await mkdir(child, { recursive: true })
    await restoreTrustedDeferredContinuationContext(
      { cwd: child },
      { projectPath: project, worktreeSession: null },
    )
    expect(process.cwd()).toBe(await realpath(child))
  })

  test('rejects cwd containment escapes and worktree identity mismatches', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-context-reject-')
    cleanup.push(root)
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    await mkdir(project)
    await mkdir(outside)
    await expect(
      restoreTrustedDeferredContinuationContext(
        { cwd: outside },
        { projectPath: project, worktreeSession: null },
      ),
    ).rejects.toThrow('outside trusted project context')
    await expect(
      restoreTrustedDeferredContinuationContext(
        { cwd: project, worktreeRoot: project },
        { projectPath: project, worktreeSession: null },
      ),
    ).rejects.toThrow('worktree identity mismatch')
  })
})

const NOW = 1_700_000_000_000
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

function deferredJob() {
  return {
    version: 1 as const,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: SESSION_ID,
    projectStorageKey: '-private-project',
    context: {
      cwd: '/private/project',
      model: 'gpt-5.6-terra',
      effort: 'high' as const,
      permissionMode: 'default' as const,
    },
    createdAt: NOW,
    statusObservedAt: NOW,
    scheduleReason: 'hard_quota_reset' as const,
    resetAt: NOW + 60_000,
    notBefore: NOW + 120_000,
    state: 'pending' as const,
    attempt: { number: 1, messageUuid: '33333333-3333-4333-8333-333333333333' },
    transientRetries: 0,
  }
}

async function withStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp('/tmp/cat-code-resume-lock-')
  cleanup.push(root)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
}

describe('resume against a deferred continuation session lock', () => {
  test('allows resume when no continuation is scheduled', async () => {
    await withStore(async () => {
      expect(await checkDeferredContinuationResume(SESSION_ID)).toEqual({
        action: 'allow',
      })
    })
  })

  // The F4 defect: a background attempt is mid-turn on this session, holding the
  // session lock and already appending the transcript. Resume must not adopt it.
  test('blocks resume while a background attempt holds the session lock', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())
      const attempt = await acquireDeferredContinuationLocks(deferredJob())
      try {
        expect(await checkDeferredContinuationResume(SESSION_ID)).toEqual({
          action: 'block',
          notice: DEFERRED_RESUME_BUSY_NOTICE,
        })
      } finally {
        await attempt.release()
      }
      // Once the attempt releases, resume is free again.
      expect(await checkDeferredContinuationResume(SESSION_ID)).toEqual({
        action: 'allow',
      })
    })
  })

  // Plan §"Human interaction": merely reopening a transcript must not cancel a
  // pending job — that is what distinguishes resume from a human prompt.
  test('leaves a pending job scheduled instead of canceling it', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())
      expect(await checkDeferredContinuationResume(SESSION_ID)).toEqual({
        action: 'allow',
      })
      const still = await readPendingDeferredContinuation(SESSION_ID)
      expect(still?.state).toBe('pending')
      expect(still?.jobId).toBe(deferredJob().jobId)
    })
  })

  // Wiring: the guard is worthless unless the real resume funnel consults it.
  // processResumedConversation serves every interactive --continue/--resume
  // entry in main.tsx, and refuses before touching any session state — so a
  // blocked resume never reaches the machinery this minimal context omits.
  test('processResumedConversation refuses to adopt a locked session', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())
      const attempt = await acquireDeferredContinuationLocks(deferredJob())
      try {
        await expect(
          processResumedConversation(
            { messages: [], sessionId: SESSION_ID as `${string}-${string}-${string}-${string}-${string}` },
            { forkSession: false },
            {} as never,
          ),
        ).rejects.toThrow(DEFERRED_RESUME_BUSY_NOTICE)
      } finally {
        await attempt.release()
      }
    })
  })

  // Failure direction: a lock left behind by a crashed worker must never brick
  // resume. The store's staleness window owns that call, so backdate the lock
  // past it rather than inventing a second reclamation rule here.
  test('allows resume when the session lock is stale from a crashed attempt', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())
      const paths = getDeferredContinuationPaths()
      const targets = getDeferredContinuationLockTargets(deferredJob(), paths)
      const abandoned = await acquireDeferredContinuationLocks(deferredJob())
      try {
        const dead = new Date(Date.now() - DEFERRED_LOCK_STALE_MS * 4)
        await utimes(`${targets.session}.lock`, dead, dead)
        await utimes(`${targets.job}.lock`, dead, dead)
        expect(await checkDeferredContinuationResume(SESSION_ID)).toEqual({
          action: 'allow',
        })
      } finally {
        await abandoned.release().catch(() => {})
      }
    })
  })
})
