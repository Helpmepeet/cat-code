import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isProviderSwitchLocked,
  setProviderSwitchLocked,
} from '../bootstrap/state.js'
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
  DeferredContinuationBusyError,
  DEFERRED_RESUME_BUSY_NOTICE,
  processResumedConversation,
  restoreTrustedDeferredContinuationContext,
  withDeferredContinuationResumeAuthority,
} from './sessionRestore.js'
import {
  reAppendSessionMetadata,
  resetProjectForTesting,
  setSessionFileForTesting,
} from './sessionStorage.js'
import { setCwd } from './Shell.js'
import type { ThreadGoal } from './threadGoal.js'

const cleanup: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
  process.chdir(originalCwd)
  setCwd(originalCwd)
  resetProjectForTesting()
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

function resumeContext() {
  return {
    modeApi: null,
    mainThreadAgentDefinition: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    currentCwd: process.cwd(),
    cliAgents: [],
    initialState: {},
  } as never
}

const SOURCE_GOAL: ThreadGoal = {
  threadId: SESSION_ID,
  goalId: 'source-goal',
  objective: 'finish the source session',
  status: 'active',
  tokensUsed: 1_000,
  timeUsedSeconds: 60,
  createdAtMs: NOW,
  updatedAtMs: NOW,
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
  test('fork starts goal-free while ordinary resume retains the source goal', async () => {
    await withStore(async () => {
      const resumed = await processResumedConversation(
        {
          messages: [],
          sessionId: undefined,
          threadGoal: SOURCE_GOAL,
        },
        { forkSession: false },
        resumeContext(),
      )
      expect(resumed.initialState.threadGoal).toEqual(SOURCE_GOAL)

      resetProjectForTesting()
      const root = await mkdtemp('/tmp/cat-code-fork-goal-')
      cleanup.push(root)
      const forkTranscript = join(root, 'fork.jsonl')
      setSessionFileForTesting(forkTranscript)

      const forked = await processResumedConversation(
        {
          messages: [],
          sessionId: SESSION_ID as `${string}-${string}-${string}-${string}-${string}`,
          threadGoal: SOURCE_GOAL,
        },
        { forkSession: true },
        resumeContext(),
      )
      expect(forked.initialState.threadGoal).toBeNull()

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
  })

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

  test('holds session authority through the transcript-adoption substep', async () => {
    await withStore(async () => {
      const scheduled = deferredJob()
      await createPendingDeferredContinuation(scheduled)

      await withDeferredContinuationResumeAuthority(SESSION_ID, async () => {
        await expect(acquireDeferredContinuationLocks(scheduled)).rejects.toThrow()
      })

      const after = await acquireDeferredContinuationLocks(scheduled)
      await after.release()
    })
  })

  test('startup-picker adoption is not entered when session authority cannot be reacquired', async () => {
    await withStore(async () => {
      const scheduled = deferredJob()
      await createPendingDeferredContinuation(scheduled)
      const held = await acquireDeferredContinuationLocks(scheduled)
      let adopted = false

      try {
        await expect(
          withDeferredContinuationResumeAuthority(SESSION_ID, () => {
            adopted = true
          }),
        ).rejects.toBeInstanceOf(DeferredContinuationBusyError)
        expect(adopted).toBe(false)
      } finally {
        await held.release()
      }
    })
  })

  // The CLI never armed setProviderSwitchLocked: its only caller lived in the
  // desktop sidecar, so `cat-code --resume` of a GPT conversation offered the
  // Anthropic model rows (getTotalInputTokens() is 0 in a fresh process) and
  // selecting one switched provider mid-transcript. Drives the real resume
  // funnel rather than the predicate, because the predicate was never the part
  // that was missing.
  test('adopting a transcript with real turns arms the provider-switch lock', async () => {
    await withStore(async () => {
      const previous = isProviderSwitchLocked()
      try {
        setProviderSwitchLocked(false)
        await processResumedConversation(
          {
            messages: [
              {
                type: 'assistant',
                uuid: 'a',
                message: { role: 'assistant', model: 'gpt-5.6-terra', content: [] },
              },
            ],
            sessionId: SESSION_ID as `${string}-${string}-${string}-${string}-${string}`,
          } as never,
          { forkSession: false },
          resumeContext(),
        )
        expect(isProviderSwitchLocked()).toBe(true)
      } finally {
        setProviderSwitchLocked(previous)
      }
    })
  })

  test('adopting a transcript with nothing but metadata leaves the lock open', async () => {
    await withStore(async () => {
      const previous = isProviderSwitchLocked()
      try {
        setProviderSwitchLocked(true)
        await processResumedConversation(
          { messages: [], sessionId: SESSION_ID as `${string}-${string}-${string}-${string}-${string}` } as never,
          { forkSession: false },
          resumeContext(),
        )
        expect(isProviderSwitchLocked()).toBe(false)
      } finally {
        setProviderSwitchLocked(previous)
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
