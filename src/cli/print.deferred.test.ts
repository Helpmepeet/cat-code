import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createPendingDeferredContinuation,
  readPendingDeferredContinuation,
} from '../services/deferredContinuation.js'
import type { AppState } from '../state/AppState.js'
import {
  reAppendSessionMetadata,
  resetProjectForTesting,
  setSessionFileForTesting,
} from '../utils/sessionStorage.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import { createThreadGoal } from '../utils/threadGoal.js'
import {
  resolveHeadlessDeferredContinuation,
  restoreHeadlessSessionFromLog,
} from './print.js'

const cleanup: string[] = []

afterEach(async () => {
  resetProjectForTesting()
  await Promise.all(
    cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

const NOW = 1_700_000_000_000
const SESSION_ID = '44444444-4444-4444-8444-444444444444'
const SOURCE_GOAL: ThreadGoal = {
  ...createThreadGoal(SESSION_ID, 'finish the source session', undefined, NOW),
  goalId: 'source-goal',
  tokensUsed: 1_000,
  timeUsedSeconds: 60,
}

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
  test('fork starts goal-free while ordinary resume retains the source goal', async () => {
    let state = { threadGoal: null } as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      state = update(state)
    }

    restoreHeadlessSessionFromLog(
      { threadGoal: SOURCE_GOAL },
      false,
      setAppState,
    )
    expect(state.threadGoal).toEqual(SOURCE_GOAL)

    resetProjectForTesting()
    const root = await mkdtemp('/tmp/cat-code-headless-fork-goal-')
    cleanup.push(root)
    const forkTranscript = join(root, 'fork.jsonl')
    setSessionFileForTesting(forkTranscript)

    restoreHeadlessSessionFromLog(
      { threadGoal: SOURCE_GOAL },
      true,
      setAppState,
    )
    expect(state.threadGoal).toBeNull()

    reAppendSessionMetadata()
    const metadataEntries = (await Bun.file(forkTranscript).text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string })
    expect(metadataEntries.map(entry => entry.type)).toContain(
      'thread-goal-cleared',
    )
    expect(metadataEntries.map(entry => entry.type)).not.toContain(
      'thread-goal-updated',
    )
  })

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
