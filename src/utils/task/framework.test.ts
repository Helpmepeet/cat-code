import { afterEach, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import {
  dequeue,
  enqueuePendingNotification,
  releaseTaskNotificationReservation,
  reserveTaskNotification,
  resetCommandQueue,
} from '../messageQueueManager.js'
import {
  applyTaskEvictions,
  evictTerminalTask,
  generateTaskAttachments,
} from './framework.js'
import { markAgentMessageDeliveriesReported } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

afterEach(() => {
  resetCommandQueue()
})

// The scan used to decide eviction inside a switch over every status, with the
// running arm falling through to a per-turn disk read whose bytes were thrown
// away. Collapsing it to two guards must not widen or narrow the set it picks.
test('the eviction scan collects consumed terminal tasks and nothing else', () => {
  let state = {
    tasks: {
      completed: { id: 'completed', status: 'completed', notified: true },
      failed: { id: 'failed', status: 'failed', notified: true },
      killed: { id: 'killed', status: 'killed', notified: true },
      // Terminal but the parent has not been told yet.
      unnotified: { id: 'unnotified', status: 'completed', notified: false },
      // Notified, but not finished — the parent still addresses these.
      queued: { id: 'queued', status: 'pending', notified: true },
      running: { id: 'running', status: 'running', notified: true },
    },
  } as unknown as AppState

  const { evictedTaskIds } = generateTaskAttachments(state)
  expect([...evictedTaskIds].sort()).toEqual(['completed', 'failed', 'killed'])

  applyTaskEvictions(update => {
    state = update(state)
  }, evictedTaskIds)
  expect(Object.keys(state.tasks).sort()).toEqual([
    'queued',
    'running',
    'unnotified',
  ])
})

test('a queued completion keeps its task out of the eviction set', () => {
  enqueuePendingNotification({
    mode: 'task-notification',
    value: 'Task notification\nTask ID: worker\nSummary: Agent completed',
  })
  const state = {
    tasks: {
      worker: { id: 'worker', status: 'completed', notified: true },
    },
  } as unknown as AppState

  expect(generateTaskAttachments(state).evictedTaskIds).toEqual([])
})

test('a queued or reserved task completion keeps its terminal task addressable', () => {
  let state = {
    tasks: {
      worker: {
        id: 'worker',
        type: 'local_agent',
        status: 'completed',
        notified: true,
        retain: false,
        evictAfter: 0,
      },
    },
  } as AppState
  const setAppState = (update: (previous: AppState) => AppState) => {
    state = update(state)
  }

  enqueuePendingNotification({
    mode: 'task-notification',
    value: 'Task notification\nTask ID: worker\nSummary: Agent completed',
  })
  evictTerminalTask('worker', setAppState)
  expect(state.tasks.worker).toBeDefined()

  const command = dequeue()
  expect(command).toBeDefined()
  const reservation = reserveTaskNotification(command!)
  evictTerminalTask('worker', setAppState)
  expect(state.tasks.worker).toBeDefined()

  releaseTaskNotificationReservation(reservation)
  evictTerminalTask('worker', setAppState)
  expect(state.tasks.worker).toBeUndefined()
})

test('unresolved local-worker delivery blocks eager and lazy eviction until reported', () => {
  let state = {
    tasks: {
      worker: {
        id: 'worker',
        type: 'local_agent',
        status: 'completed',
        notified: true,
        retain: false,
        evictAfter: 0,
        pendingMessages: [
          {
            id: 'message-1',
            message: 'inspect the race',
            status: 'uncertain',
            acceptedAt: 1,
            reported: false,
          },
        ],
      },
    },
  } as unknown as AppState
  const setAppState = (update: (previous: AppState) => AppState) => {
    state = update(state)
  }

  evictTerminalTask('worker', setAppState)
  expect(state.tasks.worker).toBeDefined()
  expect(generateTaskAttachments(state).evictedTaskIds).toEqual([])

  markAgentMessageDeliveriesReported('worker', ['message-1'], setAppState)
  const { evictedTaskIds } = generateTaskAttachments(state)
  expect(evictedTaskIds).toEqual(['worker'])
  applyTaskEvictions(setAppState, evictedTaskIds)
  expect(state.tasks.worker).toBeUndefined()
})
