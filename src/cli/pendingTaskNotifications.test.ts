import { describe, expect, test } from 'bun:test'
import {
  createPendingTaskNotifications,
  type ObservedTask,
  toObservedTask,
} from './pendingTaskNotifications.js'

const DEADLINE_MS = 120_000
const T0 = 1_700_000_000_000

function task(over: Partial<ObservedTask> = {}): ObservedTask {
  return {
    id: 'agent-1',
    isBackgroundWork: true,
    isTerminal: false,
    notified: false,
    ...over,
  }
}

const running = task()
const terminalUnnotified = task({ isBackgroundWork: false, isTerminal: true })
const terminalNotified = task({
  isBackgroundWork: false,
  isTerminal: true,
  notified: true,
})

describe('pendingTaskNotifications', () => {
  // The regression: a background agent's status flips to terminal before its
  // notification is enqueued. In that window isBackgroundWork is already false
  // and the command queue is empty, so the headless wait loop read it as idle,
  // exited, and flushed the model's pre-wait holding message as the answer.
  test('keeps a terminal-but-unnotified task pending across polls', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)

    expect(tracker.update([running], T0).pending).toEqual([])

    // Status flipped; notification not enqueued yet. This is the window.
    expect(tracker.update([terminalUnnotified], T0 + 100).pending).toEqual([
      'agent-1',
    ])
    // Still pending several polls later — one poll is not enough to prove it.
    expect(tracker.update([terminalUnnotified], T0 + 200).pending).toEqual([
      'agent-1',
    ])
    expect(tracker.update([terminalUnnotified], T0 + 300).pending).toEqual([
      'agent-1',
    ])

    // Notification enqueued: stop waiting and stop tracking.
    const delivered = tracker.update([terminalNotified], T0 + 400)
    expect(delivered.pending).toEqual([])
    expect(delivered.expired).toEqual([])
    expect(tracker._forTest.trackedIds()).toEqual([])
  })

  test('expires after the deadline instead of waiting forever', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    tracker.update([running], T0)
    tracker.update([terminalUnnotified], T0 + 100)

    // One tick before the deadline it is still pending, not expired.
    const before = tracker.update([terminalUnnotified], T0 + 100 + DEADLINE_MS - 1)
    expect(before.pending).toEqual(['agent-1'])
    expect(before.expired).toEqual([])

    const after = tracker.update([terminalUnnotified], T0 + 100 + DEADLINE_MS)
    expect(after.expired).toEqual(['agent-1'])
    expect(after.pending).toEqual([])
    // Untracked afterwards, so the loop cannot spin on it forever.
    expect(tracker._forTest.trackedIds()).toEqual([])
    expect(tracker.update([terminalUnnotified], T0 + 999_999).expired).toEqual(
      [],
    )
  })

  test('never tracks work this run did not observe as background', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    // A terminal, never-notified task that was never seen running. These are
    // never evicted from AppState (task/framework.ts:129), so a global scan
    // would treat one as permanently pending.
    const stranger = task({
      id: 'stale-task',
      isBackgroundWork: false,
      isTerminal: true,
    })
    const sweep = tracker.update([stranger], T0)
    expect(sweep.pending).toEqual([])
    expect(sweep.expired).toEqual([])
    expect(tracker._forTest.trackedIds()).toEqual([])
  })

  test('drops a task that disappears from AppState', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    tracker.update([running], T0)
    expect(tracker.update([], T0 + 100).pending).toEqual([])
    expect(tracker._forTest.trackedIds()).toEqual([])
  })

  test('a resumed task does not carry a stale deadline', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    tracker.update([running], T0)
    tracker.update([terminalUnnotified], T0 + 100)
    // Back to running: the earlier terminal blip must not count toward expiry.
    tracker.update([running], T0 + 200)
    const late = tracker.update([terminalUnnotified], T0 + 200 + DEADLINE_MS - 1)
    expect(late.expired).toEqual([])
    expect(late.pending).toEqual(['agent-1'])
  })

  test('in_process_teammate is excluded by the caller and never tracked', () => {
    // The caller passes isBackgroundWork already narrowed by
    // `t.type !== 'in_process_teammate'` (gh-30008: teammates stay running
    // for their whole lifetime, so waiting on one loops forever).
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    const teammate = task({ id: 'teammate-1', isBackgroundWork: false })
    tracker.update([teammate], T0)
    expect(tracker._forTest.trackedIds()).toEqual([])
  })

  test('tracks several agents independently', () => {
    const tracker = createPendingTaskNotifications(DEADLINE_MS)
    tracker.update([task({ id: 'a' }), task({ id: 'b' })], T0)

    const sweep = tracker.update(
      [
        task({ id: 'a', isBackgroundWork: false, isTerminal: true }),
        task({ id: 'b' }),
      ],
      T0 + 100,
    )
    expect(sweep.pending).toEqual(['a'])

    const both = tracker.update(
      [
        task({ id: 'a', isBackgroundWork: false, isTerminal: true }),
        task({ id: 'b', isBackgroundWork: false, isTerminal: true }),
      ],
      T0 + 200,
    )
    expect(both.pending.sort()).toEqual(['a', 'b'])
  })
})

// toObservedTask is the least type-protected step in this path: `TaskState`
// does not resolve to a usable shape, so nothing checks these field reads.
// The tracker tests inject ObservedTask literals and cannot see a wrong
// mapping, which is exactly the "tests that inject the value never drive the
// code that produces it" trap.
describe('toObservedTask', () => {
  const agent = {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'count things',
    startTime: 0,
    outputFile: '/tmp/out',
    outputOffset: 0,
    notified: false,
  }

  test('a running background agent counts as background work', () => {
    expect(toObservedTask(agent)).toEqual({
      id: 'agent-1',
      isBackgroundWork: true,
      isTerminal: false,
      notified: false,
    })
  })

  test('a completed agent is terminal and no longer background work', () => {
    // This is the handover window: isBackgroundTask() is already false
    // (tasks/types.ts:38) while the notification is still being prepared.
    expect(toObservedTask({ ...agent, status: 'completed' })).toEqual({
      id: 'agent-1',
      isBackgroundWork: false,
      isTerminal: true,
      notified: false,
    })
  })

  test('failed and killed are terminal too', () => {
    expect(toObservedTask({ ...agent, status: 'failed' }).isTerminal).toBe(true)
    expect(toObservedTask({ ...agent, status: 'killed' }).isTerminal).toBe(true)
  })

  test('a running teammate is excluded from background work', () => {
    // Teammates stay `running` for their whole lifetime, so tracking one
    // would wait forever (gh-30008). This must stay identical to the
    // exclusion guarding hasRunningBg in the headless wait loop.
    expect(
      toObservedTask({ ...agent, id: 'teammate-1', type: 'in_process_teammate' })
        .isBackgroundWork,
    ).toBe(false)
  })

  test('a foregrounded agent is not background work', () => {
    expect(
      toObservedTask({ ...agent, isBackgrounded: false }).isBackgroundWork,
    ).toBe(false)
  })

  test('notified is read, not assumed', () => {
    expect(toObservedTask({ ...agent, notified: true }).notified).toBe(true)
    expect(toObservedTask({ ...agent, notified: undefined }).notified).toBe(
      false,
    )
  })
})
