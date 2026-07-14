import { describe, expect, test } from 'bun:test'
import command from './index.js'
import {
  REFUSALS,
  backgroundScheduleCopy,
  formatDeferredTime,
  historyText,
  scheduledCopy,
} from './continue-after-limit.js'
import type { DeferredContinuationJobV1 } from '../../services/deferredContinuation.js'

const NOW = new Date('2026-07-15T00:00:00Z').getTime()

function job(): DeferredContinuationJobV1 {
  return {
    version: 1,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectStorageKey: '-project',
    context: {
      cwd: '/project',
      model: 'gpt-test',
      permissionMode: 'default',
    },
    createdAt: NOW,
    statusObservedAt: NOW,
    scheduleReason: 'hard_quota_reset',
    resetAt: NOW + 60_000,
    notBefore: NOW + 120_000,
    state: 'pending',
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
    },
    transientRetries: 0,
  }
}

describe('/continue-after-limit copy', () => {
  test('formats a local timezone and relative duration without internal identifiers', () => {
    const text = formatDeferredTime(NOW + 2 * 60 * 60_000 + 14 * 60_000, NOW)
    expect(text).toContain('2h 14m')
    expect(text).toMatch(/[A-Z]{2,5}|GMT[+-]/)
    expect(text).not.toContain('attemptUuid')
    expect(text).not.toContain('jobId')
  })

  test('command is user-only, local, and not hidden behind a static provider gate', () => {
    expect(command).toMatchObject({
      type: 'local-jsx',
      name: 'continue-after-limit',
      immediate: true,
      disableModelInvocation: true,
      userInvocable: true,
    })
    expect(command).not.toHaveProperty('availability')
  })

  test('all refusal reasons are fixed and disclose that nothing was scheduled', () => {
    expect(Object.keys(REFUSALS).sort()).toEqual([
      'account_recovery',
      'not_codex',
      'not_terminal_quota',
      'observation_uncertain',
      'quota_reset_unknown',
    ])
    for (const [reason, text] of Object.entries(REFUSALS)) {
      if (reason === 'account_recovery') expect(text).toContain('cannot schedule')
      else expect(text).toContain('nothing was scheduled')
      expect(text).not.toMatch(/jobId|attemptUuid|account[_ -]?id|deferred-continuations/i)
    }
  })

  test('scheduled copy covers foreground/background lifecycle and no replay', () => {
    const off = scheduledCopy(job(), false)
    const on = scheduledCopy(job(), true)
    expect(off).toContain('Background continuation: OFF')
    expect(off).toContain('different conversation will not start it')
    expect(on).toContain('Background continuation: ON')
    expect(on).toContain('after wake or login')
    for (const text of [off, on]) {
      expect(text).toContain('It will not resend your failed request.')
      expect(text).toContain('/continue-after-limit cancel')
      expect(text).not.toContain(job().jobId)
      expect(text).not.toContain(job().attempt.messageUuid)
    }
    expect(backgroundScheduleCopy(false)).toContain('must be open')
  })

  test('history copy distinguishes no job, completion, cancellation, and specific stops', () => {
    expect(historyText(null)).toContain('Status: No continuation scheduled')
    expect(historyText({ ...job(), terminalState: 'completed', terminalReason: 'completed', terminalAt: NOW })).toContain('Status: Done')
    expect(historyText({ ...job(), terminalState: 'canceled', terminalReason: 'command', terminalAt: NOW })).toContain('Status: Canceled')
    expect(historyText({ ...job(), terminalState: 'needs_attention', terminalReason: 'transcript_persistence', terminalAt: NOW })).toContain('durably save')
  })
})
