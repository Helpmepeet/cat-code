import { afterEach, describe, expect, test } from 'bun:test'
import {
  ACCOUNT_AVAILABLE_CONTINUATION,
  RESET_ELAPSED_CONTINUATION,
  _forTest,
  abandonForegroundDeferredAttempt,
  classifyDeferredHeadlessResult,
  classifyForegroundDeferredAttempt,
  getContinuationPrompt,
  registerForegroundDeferredAttempt,
  settleForegroundDeferredAttempt,
  validateForegroundDeferredOrigin,
} from './deferredContinuationRunner.js'
import type { DeferredContinuationJobV1 } from './deferredContinuation.js'
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

afterEach(() => _forTest.clearForegroundRegistrations())

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
      messages: [],
      aborted: false,
      threw: true,
      permissionDenied: false,
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
