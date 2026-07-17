import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import command from './index.js'
import {
  REFUSALS,
  backgroundScheduleCopy,
  call,
  formatDeferredTime,
  historyText,
  scheduledCopy,
} from './continue-after-limit.js'
import { QueryGuard } from '../../utils/QueryGuard.js'
import { getImmediateCommandQueryState } from '../../utils/immediateCommand.js'
import type { DeferredContinuationJobV1 } from '../../services/deferredContinuation.js'

const NOW = new Date('2026-07-15T00:00:00Z').getTime()
const actualState = await import('../../bootstrap/state.js')

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

// F1: the command must distinguish "a turn is running" from "I am the turn".
// The serialized dispatch path reserves the guard (handlePromptSubmit.ts:500)
// BEFORE processUserInput builds the command context, so a guard reading that
// counts `dispatching` as active reports the command's own reservation back to
// it and it refuses in every state.
describe('/continue-after-limit dispatch gate', () => {
  test('a serialized dispatch at idle does not report a running query', () => {
    const guard = new QueryGuard()
    // handlePromptSubmit.ts:471 — reserve() precedes context construction.
    expect(guard.reserve()).toBe(true)
    expect(guard.isActive).toBe(true)
    expect(guard.isRunning).toBe(false)
  })

  test('a real model turn reports a running query', () => {
    const guard = new QueryGuard()
    expect(guard.tryStart()).not.toBeNull()
    expect(guard.isRunning).toBe(true)
  })

  test('a turn that has ended no longer reports running', () => {
    const guard = new QueryGuard()
    const generation = guard.tryStart()
    expect(guard.end(generation!)).toBe(true)
    expect(guard.isRunning).toBe(false)
  })

  test('the primary immediate dispatch window reports a reserved query as active', () => {
    const guard = new QueryGuard()
    expect(guard.reserve()).toBe(true)
    expect(guard.isRunning).toBe(false)
    expect(getImmediateCommandQueryState(guard.isActive, false)).toBe(true)
  })

  test('the command still refuses while a turn is actually running', async () => {
    let text: string | null = null
    // Empty args reach the guard check; a non-empty arg hits the usage branch first.
    await call(
      result => {
        text = typeof result === 'string' ? result : null
      },
      { isQueryActive: true } as never,
      '',
    )
    expect(text).toBe(
      'Wait for the current turn to finish before scheduling continuation.',
    )
  })
})

// The uninstall path throws when it cannot verify the launchd job unloaded
// (it keeps the plist rather than claim a disable it did not achieve). The
// command must surface that actionable text, not reject unhandled.
describe('/continue-after-limit disable-background failure', () => {
  test('surfaces the actionable error instead of rejecting', async () => {
    const message =
      'Could not confirm the background job unloaded. Plist kept at /tmp/x.plist. Run: launchctl bootout gui/501/com.catcode.test'
    mock.module('../../services/deferredContinuationLaunchAgent.js', () => ({
      uninstallDeferredContinuationLaunchAgent: async () => {
        throw new Error(message)
      },
      installDeferredContinuationLaunchAgent: async () => '/unused',
      getDeferredContinuationBackgroundStatus: async () => ({
        state: 'enabled' as const,
      }),
    }))
    const { call: freshCall } = await import('./continue-after-limit.js')

    let text: string | null = null
    await freshCall(
      result => {
        text = typeof result === 'string' ? result : null
      },
      { isQueryActive: false } as never,
      'disable-background',
    )
    expect(text).toBe(message)
  })
})

// F10: `cancel` refused an ambiguous job and left the record in place, so the
// state it told the user to resolve manually had no exit. F18: the durable
// record already distinguishes command cancellation from human-message
// cancellation; the status copy did not.
describe('/continue-after-limit cancel of an ambiguous job', () => {
  test('clears the job, keeps the safety warning, and records a command cancel', async () => {
    const root = await mkdtemp('/tmp/cat-code-cancel-ambiguous-')
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    mock.module('../../bootstrap/state.js', () => ({
      ...actualState,
      getSessionId: () => job().sessionId,
    }))
    try {
      const store = await import('../../services/deferredContinuation.js')
      await store.createPendingDeferredContinuation({
        ...job(),
        state: 'ambiguous',
        attempt: { ...job().attempt, submittedAt: NOW },
      })
      const { call: freshCall } = await import('./continue-after-limit.js')

      let text: string | null = null
      await freshCall(
        result => {
          text = typeof result === 'string' ? result : null
        },
        { isQueryActive: false } as never,
        'cancel',
      )

      expect(text).toContain('canceled')
      // Cancelling does not make a possibly-started attempt un-started.
      expect(text).toContain('may have started')
      expect(await store.readPendingDeferredContinuation(job().sessionId)).toBeNull()
      const history = await store.getLatestDeferredContinuationHistory(job().sessionId)
      expect(history?.terminalState).toBe('canceled')
      expect(history?.terminalReason).toBe('command')
      // The notice the cancel just recorded was shown inline, so it must not be
      // left behind for the hook to replay.
      expect(await store.takeDeferredContinuationNotice(job().sessionId)).toBeNull()
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  test('status copy names which side cancelled', () => {
    expect(
      historyText({ ...job(), terminalState: 'canceled', terminalReason: 'command', terminalAt: NOW }),
    ).toContain('by command')
    expect(
      historyText({ ...job(), terminalState: 'canceled', terminalReason: 'human_message', terminalAt: NOW }),
    ).toContain('sent a new message')
  })
})
