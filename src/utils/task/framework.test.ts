import { afterEach, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import {
  dequeue,
  enqueuePendingNotification,
  releaseTaskNotificationReservation,
  reserveTaskNotification,
  resetCommandQueue,
} from '../messageQueueManager.js'
import { evictTerminalTask } from './framework.js'

afterEach(() => {
  resetCommandQueue()
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
