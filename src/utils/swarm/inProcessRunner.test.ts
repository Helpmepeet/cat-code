import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import type { TeammateIdentity } from '../../tasks/InProcessTeammateTask/types.js'
import { waitForNextPromptOrShutdownForTest } from './inProcessRunner.js'

describe('in-process teammate idle polling', () => {
  test('backs off repeated empty idle polls', async () => {
    const abortController = new AbortController()
    const sleepDurations: number[] = []
    const identity: TeammateIdentity = {
      agentId: 'agent-1',
      agentName: 'agent-one',
      teamName: 'review-team',
      parentSessionId: 'session-1',
      planModeRequired: false,
    }
    let appState = {
      tasks: {
        teammateTask: {
          type: 'in_process_teammate',
          pendingUserMessages: [],
        },
      },
    } as unknown as AppState

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async ms => {
          sleepDurations.push(ms)
          if (sleepDurations.length === 5) {
            abortController.abort()
          }
        },
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [],
        }),
        markMessageAsReadByIndex: async () => {},
        tryClaimNextTask: async () => undefined,
      },
    })

    expect(result).toEqual({ type: 'aborted' })
    expect(sleepDurations).toEqual([500, 500, 1000, 2000, 2000])
  })
})
