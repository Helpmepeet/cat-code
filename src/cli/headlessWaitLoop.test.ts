import { describe, expect, test } from 'bun:test'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import {
  createHeadlessWaitLoop,
  type HeadlessWaitLoop,
  type HeadlessWaitLoopRunDeps,
  type WaitLoopStateSnapshot,
} from './headlessWaitLoop.js'

/**
 * A miniature of the real headless run: one background agent, one command
 * queue, one output FIFO. The wait loop drives it exactly as it drives
 * `runHeadlessStreaming`, so the assertions below are about ordering across
 * real poll iterations rather than about a single call's return value.
 */
type Harness = {
  loop: HeadlessWaitLoop
  runDeps: HeadlessWaitLoopRunDeps
  task: { isTerminal: boolean; notified: boolean }
  emitted: StdoutMessage[]
  queue: string[]
  turns: string[]
  sleeps: Array<{
    isTerminal: boolean
    notified: boolean
    emittedCount: number
    resultHeld: boolean
  }>
  continuationCalls: Array<{ isTerminal: boolean; notified: boolean }>
  discarded: number
  flushed: number
  clockMs: number
}

function resultMessage(id: string): StdoutMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    session_id: 'session',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: id,
    result: id,
  } as unknown as StdoutMessage
}

function createHarness(options: {
  /** Runs on every `sleep`; the poll's chance to advance the world. */
  onSleep: (h: Harness) => void
  /** Turns a dequeued command into a model turn. */
  onTurn: (h: Harness, command: string) => void
  deadlineMs?: number
  goalLoop?: boolean
  clockStepMs?: number
}): Harness {
  const h: Partial<Harness> & {
    task: Harness['task']
    emitted: StdoutMessage[]
    queue: string[]
    turns: string[]
    sleeps: Harness['sleeps']
    continuationCalls: Harness['continuationCalls']
    discarded: number
    flushed: number
    clockMs: number
  } = {
    task: { isTerminal: false, notified: false },
    emitted: [],
    queue: [],
    turns: [],
    sleeps: [],
    continuationCalls: [],
    discarded: 0,
    flushed: 0,
    clockMs: 0,
  }

  const readState = (): WaitLoopStateSnapshot => {
    const running = !h.task.isTerminal
    return {
      hasRunningBackgroundWork: running,
      hasHoldbackAgents: running,
      tasks: [
        {
          id: 't1',
          isBackgroundWork: true,
          isTerminal: h.task.isTerminal,
          notified: h.task.notified,
        },
      ],
    }
  }

  const loop = createHeadlessWaitLoop({
    readState,
    emit: message => h.emitted.push(message),
    getSessionId: () => 'session',
    onHeldResultDiscarded: () => {
      h.discarded += 1
    },
    onHeldResultFlushed: () => {
      h.flushed += 1
    },
    now: () => h.clockMs,
    deadlineMs: options.deadlineMs,
  })

  const runDeps: HeadlessWaitLoopRunDeps = {
    drainCommandQueue: async () => {
      let command: string | undefined
      while ((command = h.queue.shift()) !== undefined) {
        h.turns.push(command)
        options.onTurn(h as Harness, command)
      }
    },
    flushSdkEvents: () => {},
    hasMainThreadQueued: () => h.queue.length > 0,
    requestGoalContinuation:
      options.goalLoop === false
        ? null
        : async () => {
            h.continuationCalls.push({
              isTerminal: h.task.isTerminal,
              notified: h.task.notified,
            })
            return false
          },
    isShuttingDown: () => false,
    sleep: async () => {
      h.sleeps.push({
        isTerminal: h.task.isTerminal,
        notified: h.task.notified,
        emittedCount: h.emitted.length,
        resultHeld: loop.isResultHeld(),
      })
      h.clockMs += options.clockStepMs ?? 1
      if (h.sleeps.length > 50) throw new Error('wait loop did not terminate')
      options.onSleep(h as Harness)
    },
    setRunPhase: () => {},
  }

  h.loop = loop
  h.runDeps = runDeps
  return h as Harness
}

describe('headless wait loop', () => {
  // The whole point of the 2026-08-27 fix: the run's answer must be the turn
  // that read the agent's notification, not the holding sentence the model
  // produced before the agent finished.
  test('holds the result across the handover window and answers from the later turn', async () => {
    const harness = createHarness({
      goalLoop: false,
      onTurn: (h, command) => {
        if (command === 'initial prompt') {
          // The background agent is still running here, so this result is held.
          h.loop.onTurnResult(resultMessage('holding-sentence'))
        } else {
          h.loop.onTurnResult(resultMessage('answer-from-notification'))
        }
      },
      onSleep: h => {
        if (h.sleeps.length === 1) {
          // Terminal at AgentTool.tsx:1714, notification not enqueued yet.
          h.task.isTerminal = true
        } else if (h.sleeps.length === 3) {
          // :1756 finally enqueues it.
          h.task.notified = true
          h.queue.push('task notification')
        }
      },
    })
    harness.queue.push('initial prompt')

    const outcome = await harness.loop.runWaitLoop(harness.runDeps)

    expect(outcome).toEqual({ type: 'idle' })
    // The held result stayed unflushed for more than one poll while the task
    // was terminal-but-unnotified.
    const handoverPolls = harness.sleeps.filter(s => s.isTerminal && !s.notified)
    expect(handoverPolls.length).toBeGreaterThan(1)
    for (const poll of handoverPolls) {
      expect(poll.emittedCount).toBe(0)
      expect(poll.resultHeld).toBe(true)
    }
    // The notification was drained into a second model turn...
    expect(harness.turns).toEqual(['initial prompt', 'task notification'])
    // ...and that turn's result is the only thing the run emitted.
    expect(harness.emitted.map(m => (m as { uuid: string }).uuid)).toEqual([
      'answer-from-notification',
    ])
    expect(harness.loop.isResultHeld()).toBe(false)
  })

  // Waiting forever would hang the run; flushing the stale result would ship
  // the holding sentence with exit 0, which is the defect itself.
  test('fails closed when the notification never arrives', async () => {
    const harness = createHarness({
      goalLoop: false,
      deadlineMs: 1_000,
      clockStepMs: 600,
      onTurn: (h, _command) => {
        h.loop.onTurnResult(resultMessage('holding-sentence'))
      },
      onSleep: h => {
        if (h.sleeps.length === 1) h.task.isTerminal = true
        // The notification is never enqueued.
      },
    })
    harness.queue.push('initial prompt')

    const outcome = await harness.loop.runWaitLoop(harness.runDeps)

    expect(outcome).toEqual({
      type: 'failed_closed',
      undeliveredTaskIds: ['t1'],
    })
    // The stale held result was discarded, not emitted.
    expect(
      harness.emitted.map(m => (m as { uuid: string }).uuid),
    ).not.toContain('holding-sentence')
    expect(harness.discarded).toBe(1)
    expect(harness.flushed).toBe(0)
    expect(harness.loop.isResultHeld()).toBe(false)

    expect(harness.emitted).toHaveLength(1)
    const errorResult = harness.emitted[0] as unknown as {
      type: string
      subtype: string
      is_error: boolean
      errors: string[]
    }
    expect(errorResult.type).toBe('result')
    expect(errorResult.subtype).toBe('error_during_execution')
    expect(errorResult.is_error).toBe(true)
    expect(errorResult.errors[0]).toContain('t1')
    // Same expression runHeadless feeds to gracefulShutdownSync.
    expect(errorResult.type === 'result' && errorResult.is_error ? 1 : 0).toBe(1)
  })

  // A continuation enqueued inside the handover window races the notification
  // that is about to arrive, and burns a turn deciding what to do next before
  // the agent's result has been read.
  test('asks for no goal continuation while a notification is pending', async () => {
    const harness = createHarness({
      onTurn: (h, _command) => {
        h.loop.onTurnResult(resultMessage('holding-sentence'))
      },
      onSleep: h => {
        if (h.sleeps.length === 1) h.task.isTerminal = true
        else if (h.sleeps.length === 3) h.task.notified = true
      },
    })
    harness.queue.push('initial prompt')

    await harness.loop.runWaitLoop(harness.runDeps)

    expect(
      harness.sleeps.filter(s => s.isTerminal && !s.notified).length,
    ).toBeGreaterThan(1)
    expect(
      harness.continuationCalls.filter(c => c.isTerminal && !c.notified),
    ).toEqual([])
    // The goal loop is still consulted once the window closes.
    expect(harness.continuationCalls).toHaveLength(1)
    expect(harness.continuationCalls[0]).toEqual({
      isTerminal: true,
      notified: true,
    })
  })
})
