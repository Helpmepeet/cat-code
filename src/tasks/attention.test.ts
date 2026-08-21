import { describe, expect, test } from 'bun:test'
import { deriveDelegatedTaskStatus } from '../utils/tuiSessionStatus.js'
import {
  isBlockedLocalAgent,
  isTeammateAwaitingPlanApproval,
  isUltraplanAttentionPhase,
} from './attention.js'
import { completeAgentTask } from './LocalAgentTask/LocalAgentTask.js'
import { pillCtaText, pillNeedsCta } from './pillLabel.js'
import type { TaskState } from './types.js'

describe('attention predicates', () => {
  test('a blocked handoff is the only handoff state that waits', () => {
    expect(isBlockedLocalAgent({ handoffStatus: 'blocked' })).toBe(true)
    expect(isBlockedLocalAgent({ handoffStatus: 'done' })).toBe(false)
    expect(isBlockedLocalAgent({})).toBe(false)
  })

  test('only the two named ultraplan phases wait', () => {
    expect(isUltraplanAttentionPhase('needs_input')).toBe(true)
    expect(isUltraplanAttentionPhase('plan_ready')).toBe(true)
    // undefined means the plan is still running, not that it is waiting.
    expect(isUltraplanAttentionPhase(undefined)).toBe(false)
  })

  test('plan approval waits only when explicitly true', () => {
    expect(isTeammateAwaitingPlanApproval({ awaitingPlanApproval: true })).toBe(true)
    expect(isTeammateAwaitingPlanApproval({ awaitingPlanApproval: false })).toBe(false)
    expect(isTeammateAwaitingPlanApproval({})).toBe(false)
  })
})

/**
 * The reason this module exists. The footer pill and live session status read
 * the same fact off the same row, and they silently disagreed once: status
 * gated the blocked check behind a terminal guard a blocked handoff can never
 * pass, so the pill read "needs input" while the tab read idle.
 *
 * Driven by the real writer rather than a fixture, because the earlier version
 * of that check was tested with a nonterminal blocked row that production
 * cannot build, which is exactly how the disagreement survived.
 */
describe('the pill and session status agree on one real blocked agent', () => {
  function completeWith(agentText: string): Record<string, TaskState> {
    let state = {
      tasks: {
        a1: {
          id: 'a1',
          type: 'local_agent',
          status: 'running',
          description: 'probe agent',
          startTime: 0,
          outputFile: '/dev/null',
          outputOffset: 0,
          notified: false,
          isBackgrounded: true,
          retain: false,
        },
      },
    } as unknown as Parameters<Parameters<typeof completeAgentTask>[1]>[0]
    completeAgentTask(
      {
        agentId: 'a1',
        agentName: 'probe',
        content: [{ type: 'text', text: agentText }],
      } as unknown as Parameters<typeof completeAgentTask>[0],
      updater => {
        state = updater(state)
      },
    )
    return (state as unknown as { tasks: Record<string, TaskState> }).tasks
  }

  test('blocked: pill offers the call to action AND status reports waiting', () => {
    const tasks = completeWith('status: blocked\n\nOpen questions / blockers:\n- which db?')
    const rows = Object.values(tasks)

    expect(isBlockedLocalAgent(rows[0] as { handoffStatus?: 'done' | 'blocked' })).toBe(true)
    expect(pillNeedsCta(rows)).toBe(true)
    expect(pillCtaText(rows)).toBe('↵ to open')
    expect(deriveDelegatedTaskStatus(tasks).waitingReason).toBe('input-needed')
  })

  test('done: pill stays quiet AND status reports no waiting', () => {
    const tasks = completeWith('status: done\n\nAll set.')
    const rows = Object.values(tasks)

    expect(pillNeedsCta(rows)).toBe(false)
    expect(pillCtaText(rows)).toBeUndefined()
    expect(deriveDelegatedTaskStatus(tasks).waitingReason).toBeUndefined()
  })
})
