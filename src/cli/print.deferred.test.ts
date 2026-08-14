import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  createPendingDeferredContinuation,
  readPendingDeferredContinuation,
} from '../services/deferredContinuation.js'
import { resolveHeadlessDeferredContinuation } from './print.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

const NOW = 1_700_000_000_000
const SESSION_ID = '44444444-4444-4444-8444-444444444444'

function deferredJob() {
  return {
    version: 1 as const,
    jobId: '55555555-5555-4555-8555-555555555555',
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
    attempt: { number: 1, messageUuid: '66666666-6666-4666-8666-666666666666' },
    transientRetries: 0,
  }
}

async function withStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp('/tmp/cat-code-headless-deferred-')
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

describe('headless resume against a deferred continuation', () => {
  // A headless run is a human turn. Merely probing the lock and releasing it
  // left the job pending, so a worker becoming due mid-run appended to the same
  // transcript this process was writing.
  test('cancels a pending job so the worker cannot become a second writer', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())

      const decision = await resolveHeadlessDeferredContinuation(
        SESSION_ID,
        false,
      )

      expect(decision.action).toBe('allow_after_cancel')
      expect(await readPendingDeferredContinuation(SESSION_ID)).toBeNull()
    })
  })

  // The worker routes itself through headless resume while already holding the
  // locks; cancelling there would abort the attempt against itself.
  test('leaves the job scheduled when this process is the continuation worker', async () => {
    await withStore(async () => {
      await createPendingDeferredContinuation(deferredJob())

      const decision = await resolveHeadlessDeferredContinuation(
        SESSION_ID,
        true,
      )

      expect(decision.action).toBe('allow')
      expect((await readPendingDeferredContinuation(SESSION_ID))?.state).toBe(
        'pending',
      )
    })
  })

  test('allows a headless run when no continuation is scheduled', async () => {
    await withStore(async () => {
      expect(
        await resolveHeadlessDeferredContinuation(SESSION_ID, false),
      ).toEqual({ action: 'allow' })
    })
  })
})
