import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getTranscriptPathForSession,
  recordTranscript,
  resetProjectForTesting,
} from '../utils/sessionStorage.js'
import { createUserMessage } from '../utils/messages.js'
import {
  ACCOUNT_AVAILABLE_CONTINUATION,
  RESET_ELAPSED_CONTINUATION,
  _forTest,
  abandonForegroundDeferredAttempt,
  beginForegroundDeferredContinuation,
  classifyDeferredHeadlessResult,
  classifyForegroundDeferredAttempt,
  getContinuationPrompt,
  registerForegroundDeferredAttempt,
  settleForegroundDeferredAttempt,
  validateForegroundDeferredOrigin,
} from './deferredContinuationRunner.js'
import {
  createPendingDeferredContinuation,
  getLatestDeferredContinuationHistory,
  readPendingDeferredContinuation,
  takeDeferredContinuationNotice,
  type DeferredContinuationJobV1,
} from './deferredContinuation.js'
import {
  formatDeferredContinuationBackground,
  formatDeferredContinuationNotice,
  formatDeferredContinuationStopped,
} from './deferredContinuationPresentation.js'

const NOW = 1_700_000_000_000

function submittedJob(
  scheduleReason: DeferredContinuationJobV1['scheduleReason'] = 'hard_quota_reset',
): DeferredContinuationJobV1 {
  return {
    version: 1,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectStorageKey: '-project',
    context: {
      cwd: '/project',
      model: 'gpt-5.6-terra',
      effort: 'high',
      permissionMode: 'default',
    },
    createdAt: NOW,
    statusObservedAt: NOW,
    scheduleReason,
    ...(scheduleReason === 'hard_quota_reset' && { resetAt: NOW - 60_000 }),
    notBefore: NOW,
    state: 'submitted',
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
      submittedAt: NOW,
    },
    transientRetries: 0,
  }
}

function pendingJob(): DeferredContinuationJobV1 {
  return {
    ...submittedJob(),
    notBefore: NOW - 1,
    state: 'pending',
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
    },
  }
}

const cleanup: string[] = []

afterEach(async () => {
  _forTest.clearForegroundRegistrations()
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('deferred continuation runner', () => {
  test('fixed prompts are cause-correct and contain the reconciliation/no-repeat contract', () => {
    expect(getContinuationPrompt(submittedJob())).toBe(RESET_ELAPSED_CONTINUATION)
    expect(RESET_ELAPSED_CONTINUATION).toContain('should now have reset')
    expect(RESET_ELAPSED_CONTINUATION).toContain('Do not repeat')
    expect(getContinuationPrompt(submittedJob('account_available'))).toBe(ACCOUNT_AVAILABLE_CONTINUATION)
    expect(ACCOUNT_AVAILABLE_CONTINUATION).toContain('usable Codex account')
    expect(ACCOUNT_AVAILABLE_CONTINUATION).not.toContain('has reset')
  })

  test('registry emits the closed command shape and rejects forged origins', async () => {
    const job = submittedJob()
    const registration = registerForegroundDeferredAttempt(job)
    expect(registration.command).toMatchObject({
      value: RESET_ELAPSED_CONTINUATION,
      mode: 'prompt',
      skipSlashCommands: true,
      isMeta: false,
      priority: 'later',
      uuid: job.attempt.messageUuid,
      origin: {
        kind: 'deferred-continuation',
        jobId: job.jobId,
        attemptUuid: job.attempt.messageUuid,
      },
    })
    expect(validateForegroundDeferredOrigin({
      kind: 'deferred-continuation',
      jobId: 'forged',
      attemptUuid: job.attempt.messageUuid,
    })).toBe(false)
    expect(settleForegroundDeferredAttempt(registration.command.origin, {
      outcome: 'completed',
      observedAt: NOW,
    })).toBe(true)
    expect(await registration.result).toEqual({ outcome: 'completed', observedAt: NOW })
    expect(settleForegroundDeferredAttempt(registration.command.origin, {
      outcome: 'completed',
      observedAt: NOW,
    })).toBe(false)
  })

  test('registry rejects duplicates and unmount-style abandonment closes authority', () => {
    const job = submittedJob()
    const registration = registerForegroundDeferredAttempt(job)
    expect(() => registerForegroundDeferredAttempt(job)).toThrow('already registered')
    abandonForegroundDeferredAttempt(registration.command.origin)
    expect(validateForegroundDeferredOrigin(registration.command.origin)).toBe(false)
    expect(_forTest.registrationCount()).toBe(0)
  })

  test('abandonment settles the waiter instead of stranding it and both locks forever', async () => {
    const registration = registerForegroundDeferredAttempt(submittedJob())
    abandonForegroundDeferredAttempt(registration.command.origin)
    const settled = await Promise.race([
      registration.result,
      Bun.sleep(100).then(() => 'STRANDED' as const),
    ])
    expect(settled).toEqual({ outcome: 'aborted', observedAt: expect.any(Number) })
    // An abandoned attempt has no terminal evidence, so it must never become
    // auto-retryable: 'aborted' stops for attention.
    expect(settled).not.toMatchObject({ outcome: 'completed' })
  })

  test('post-turn result-entry persistence failure leaves the job submitted for reconciliation', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-terminal-barrier-')
    cleanup.push(root)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      const pending = pendingJob()
      await createPendingDeferredContinuation(pending)
      const attempt = await beginForegroundDeferredContinuation(pending)
      expect(attempt).not.toBeNull()
      // This intentionally exercises the result-entry validator, not the durable
      // barrier: the session id was never switched, so the entry is rejected
      // before appendEntry or flushCurrentTranscriptDurably. The transition is
      // still valid for any post-turn persistence failure.
      expect(settleForegroundDeferredAttempt(attempt!.command.origin, {
        outcome: 'completed',
        observedAt: NOW,
      })).toBe(true)
      await attempt!.finished

      // The result entry may or may not have reached the transcript, so the
      // runner must not guess. Startup reconciliation reads the transcript for
      // a terminal descendant and decides.
      expect((await readPendingDeferredContinuation(pending.sessionId))?.state).toBe('submitted')
      expect(await getLatestDeferredContinuationHistory(pending.sessionId)).toBeNull()
      expect(await takeDeferredContinuationNotice(pending.sessionId)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  /**
   * TEST EVIDENCE
   * - Claim: an actual durable transcript fsync failure leaves the job submitted.
   * - Exact pre-fix failure: the prior named barrier test stopped in validation.
   * - Production entry point: `beginForegroundDeferredContinuation` →
   *   `finalizeDeferredAttempt` → `flushCurrentTranscriptDurably`.
   * - Test path: `src/services/deferredContinuationRunner.test.ts`.
   * - Proof layer: caller/wiring.
   * - Red/mutation evidence: removing the awaited flush surfaced the armed
   *   fault later and made this test fail; production source was restored.
   * - Pairwise/adversarial cases: materialized JSONL, accepted UUID, appended
   *   result entry, exact `FileHandle.sync` fault, submitted reconciliation.
   * - UNVERIFIED: process crash/restart, DOM, GUI, credentialed-live.
   * - Commands and outcomes: focused suite passed 9/0; engine build passed.
   */
  test('actual durable barrier failure after a materialized transcript leaves the job submitted for reconciliation', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-durable-barrier-')
    const sessionDir = await mkdtemp('/tmp/cat-code-deferred-durable-session-')
    cleanup.push(root, sessionDir)
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    const previousSessionId = getSessionId()
    const previousSessionProjectDir = getSessionProjectDir()
    let fileHandlePrototype: { sync: () => Promise<void> } | undefined
    let originalSync: (() => Promise<void>) | undefined
    try {
      process.env.CLAUDE_CONFIG_DIR = root
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
      const pending = pendingJob()
      resetProjectForTesting()
      switchSession(asSessionId(pending.sessionId), sessionDir)
      clearSessionMessagesCache()
      await createPendingDeferredContinuation(pending)

      // The real recordTranscript path creates the owning JSONL file. The
      // result write below can therefore pass its session-id validator, append
      // to that file, and enter flushCurrentTranscriptDurably.
      const recorded = await recordTranscript([
        createUserMessage({
          content: 'continue',
          uuid: pending.attempt.messageUuid,
        }),
      ])
      expect(recorded).toBe(pending.attempt.messageUuid)
      await flushSessionStorage()
      const transcriptPath = getTranscriptPathForSession(pending.sessionId)
      expect(await readFile(transcriptPath, 'utf8')).toContain(
        pending.attempt.messageUuid,
      )

      // Inject the fsync failure at the FileHandle method that the actual
      // flushCurrentTranscriptDurably implementation calls. It is armed only
      // after the real transcript is materialized and restored immediately.
      const probe = await open(transcriptPath, 'r')
      fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: () => Promise<void>
      }
      originalSync = fileHandlePrototype.sync
      await probe.close()
      let armed = false
      fileHandlePrototype.sync = async function (this: unknown) {
        if (armed) {
          armed = false
          throw new Error('injected durable fsync failure')
        }
        return originalSync!.call(this)
      }

      const attempt = await beginForegroundDeferredContinuation(pending)
      expect(attempt).not.toBeNull()
      armed = true
      expect(settleForegroundDeferredAttempt(attempt!.command.origin, {
        outcome: 'completed',
        observedAt: NOW,
      })).toBe(true)
      await attempt!.finished

      const transcript = await readFile(transcriptPath, 'utf8')
      expect(transcript).toContain('deferred-continuation-result')
      expect(transcript).toContain('"outcome":"completed"')
      expect((await readPendingDeferredContinuation(pending.sessionId))?.state).toBe('submitted')
      expect(await getLatestDeferredContinuationHistory(pending.sessionId)).toBeNull()
      expect(await takeDeferredContinuationNotice(pending.sessionId)).toBeNull()
    } finally {
      if (fileHandlePrototype && originalSync) {
        fileHandlePrototype.sync = originalSync
      }
      clearSessionMessagesCache()
      resetProjectForTesting()
      switchSession(asSessionId(previousSessionId), previousSessionProjectDir)
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousTestPersistence === undefined) {
        delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      } else {
        process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousTestPersistence
      }
    }
  })

  test('typed result policy covers quota, permission, budget, abort, and forged settlement', () => {
    const job = submittedJob()
    const registration = registerForegroundDeferredAttempt(job)
    const quotaMessage = {
      type: 'assistant' as const,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      isApiErrorMessage: true,
      message: { role: 'assistant' as const, content: [] },
      deferredTerminalFailure: {
        version: 1 as const,
        provider: 'openai' as const,
        code: 'quota_exhausted' as const,
        observedAt: NOW,
      },
    }
    expect(classifyDeferredHeadlessResult([quotaMessage], undefined)).toEqual({
      outcome: 'quota_exhausted',
      observedAt: NOW,
    })
    expect(
      classifyDeferredHeadlessResult([], {
        type: 'result',
        subtype: 'success',
        permission_denials: [{}],
      }, NOW),
    ).toEqual({ outcome: 'permission_required', observedAt: NOW })
    expect(
      classifyDeferredHeadlessResult([], {
        type: 'result',
        subtype: 'error_max_budget_usd',
      }, NOW),
    ).toEqual({ outcome: 'max_budget', observedAt: NOW })
    expect(
      classifyForegroundDeferredAttempt({
        origin: registration.command.origin,
        messages: [],
        aborted: true,
        threw: false,
        permissionDenied: false,
        providerEntered: true,
        observedAt: NOW,
      }),
    ).toEqual({ outcome: 'aborted', observedAt: NOW })
    expect(
      classifyForegroundDeferredAttempt({
        origin: { kind: 'deferred-continuation', jobId: 'forged', attemptUuid: job.attempt.messageUuid },
        messages: [],
        aborted: false,
        threw: false,
        permissionDenied: false,
        providerEntered: true,
      }),
    ).toBeNull()
  })

  test('typed result policy distinguishes success, auth, network, context, turns, and throws', () => {
    const assistant = (error?: string, stopReason?: string) => ({
      type: 'assistant' as const,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      message: {
        role: 'assistant' as const,
        content: [],
        ...(stopReason ? { stop_reason: stopReason } : {}),
      },
      ...(error ? { error } : {}),
    })
    expect(classifyDeferredHeadlessResult([], { type: 'result', subtype: 'success', is_error: false }, NOW)).toEqual({ outcome: 'completed', observedAt: NOW })
    expect(classifyDeferredHeadlessResult([assistant('authentication_failed')], undefined, NOW)).toEqual({ outcome: 'account_recovery', observedAt: NOW })
    expect(classifyDeferredHeadlessResult([assistant('connection_error')], undefined, NOW)).toEqual({ outcome: 'transient_network', observedAt: NOW })
    expect(classifyDeferredHeadlessResult([assistant(undefined, 'model_context_window_exceeded')], undefined, NOW)).toEqual({ outcome: 'context_window', observedAt: NOW })
    expect(classifyDeferredHeadlessResult([], { type: 'result', subtype: 'error_max_turns' }, NOW)).toEqual({ outcome: 'max_turns', observedAt: NOW })

    const oldQuota = {
      type: 'assistant' as const,
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      isApiErrorMessage: true,
      message: { role: 'assistant' as const, content: [] },
      deferredTerminalFailure: {
        version: 1 as const,
        provider: 'openai' as const,
        code: 'quota_exhausted' as const,
        observedAt: NOW - 1,
      },
    }
    const attemptUser = {
      type: 'user' as const,
      uuid: submittedJob().attempt.messageUuid,
      message: { role: 'user' as const, content: 'continue' },
    }
    expect(classifyDeferredHeadlessResult(
      [oldQuota, attemptUser],
      { type: 'result', subtype: 'error_max_turns' },
      NOW,
      submittedJob().attempt.messageUuid,
    )).toEqual({ outcome: 'max_turns', observedAt: NOW })
    expect(classifyDeferredHeadlessResult(
      [oldQuota],
      { type: 'result', subtype: 'success', is_error: false },
      NOW,
      submittedJob().attempt.messageUuid,
    )).toEqual({ outcome: 'unknown', observedAt: NOW })

    const registration = registerForegroundDeferredAttempt(submittedJob())
    expect(classifyForegroundDeferredAttempt({
      origin: registration.command.origin,
      messages: [{
        type: 'user',
        uuid: submittedJob().attempt.messageUuid,
        message: { role: 'user', content: 'continue' },
      }],
      aborted: false,
      threw: false,
      permissionDenied: false,
      providerEntered: false,
      observedAt: NOW,
    })).toEqual({ outcome: 'unknown', observedAt: NOW })
    expect(classifyForegroundDeferredAttempt({
      origin: registration.command.origin,
      messages: [],
      aborted: false,
      threw: true,
      permissionDenied: false,
      providerEntered: true,
      observedAt: NOW,
    })).toEqual({ outcome: 'unknown', observedAt: NOW })
  })

  test('user-facing mappings cover retry, reschedule, completion, and specific stops without internals', () => {
    const notices = [
      formatDeferredContinuationNotice({ version: 1, sessionId: submittedJob().sessionId, kind: 'network_retry', notBefore: NOW + 60_000, retry: 1, observedAt: NOW }),
      formatDeferredContinuationNotice({ version: 1, sessionId: submittedJob().sessionId, kind: 'quota_rescheduled', notBefore: NOW + 120_000, observedAt: NOW }),
      formatDeferredContinuationNotice({ version: 1, sessionId: submittedJob().sessionId, kind: 'completed', observedAt: NOW }),
      formatDeferredContinuationNotice({ version: 1, sessionId: submittedJob().sessionId, kind: 'ambiguous', reason: 'ambiguous', observedAt: NOW }),
      ...['account_recovery', 'permission_required', 'context_window', 'max_turns', 'max_budget', 'session_restore', 'transcript_persistence', 'aborted', 'unknown', 'quota_reset_unknown', 'network'].map(formatDeferredContinuationStopped),
    ]
    expect(notices[0]).toContain('Status: Scheduled')
    expect(notices[0]).toContain('retry 1 of 3')
    expect(notices[1]).toContain('Continuation rescheduled')
    expect(notices[2]).toContain('Status: Done')
    expect(notices[3]).toContain('could repeat tool actions')
    for (const text of notices) {
      expect(text).not.toMatch(/jobId|attemptUuid|deferred-continuations|raw provider/i)
    }
    for (const text of notices.slice(4)) {
      expect(text).toContain('Status: Stopped — needs you')
      expect(text).toContain('Automatic retry: Off')
    }
    expect(formatDeferredContinuationBackground({ state: 'disabled' })).toContain('opening another conversation will not start it')
    expect(formatDeferredContinuationBackground({ state: 'enabled', executablePath: '/Applications/Cat Code.app/cat-code' })).toContain('once a minute')
  })
})
