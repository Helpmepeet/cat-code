import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import { AppSessionController } from './AppSessionController.js'
import type {
  AppPermissionResponse,
  AppSessionEvent,
} from './sessionEvents.js'

function createAssistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  }
}

function createResultMessage(result: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    num_turns: 1,
    stop_reason: 'end_turn',
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-1',
    session_id: 'session-1',
  }
}

describe('AppSessionController', () => {
  test('emits goal snapshot and message events for a normal turn', async () => {
    const goal: ThreadGoal = {
      threadId: 'session-1',
      goalId: 'goal-1',
      objective: 'Finish the dedicated app runtime boundary',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAtMs: 100,
      updatedAtMs: 200,
    }
    const controller = new AppSessionController({
      async *runTurn() {
        yield createAssistantMessage('hello from runtime')
        yield createResultMessage('done')
      },
    })
    const events: AppSessionEvent[] = []

    controller.subscribe(event => {
      events.push(event)
    })

    await controller.submit('hello', { goalSnapshot: goal })

    expect(events.map(event => event.type)).toEqual([
      'goal.snapshot',
      'message',
      'message',
    ])
    expect(controller.getGoalSnapshot()).toEqual(goal)
    expect(controller.getAbortState()).toEqual({ status: 'idle' })
  })

  test('waits for permission responses and emits permission lifecycle events', async () => {
    let permissionResponse: AppPermissionResponse | undefined

    const controller = new AppSessionController({
      async *runTurn({ onPermissionRequest }) {
        permissionResponse = await onPermissionRequest({
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        })
        yield createAssistantMessage(permissionResponse.behavior)
        yield createResultMessage('done')
      },
    })
    const events: AppSessionEvent[] = []

    controller.subscribe(event => {
      events.push(event)
    })

    const submitPromise = controller.submit('show me the cwd')

    expect(controller.getPendingPermissionRequests()).toEqual([
      {
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'pwd' },
          tool_use_id: 'toolu_1',
        },
      },
    ])

    expect(
      controller.respondToPermissionRequest('perm-1', {
        behavior: 'allow',
        updatedInput: { command: 'pwd', timeout: 1000 },
      }),
    ).toBe(true)

    await submitPromise

    expect(permissionResponse).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pwd', timeout: 1000 },
    })
    expect(events.map(event => event.type)).toEqual([
      'permission.requested',
      'permission.resolved',
      'message',
      'message',
    ])
    expect(controller.getPendingPermissionRequests()).toEqual([])
  })

  test('abort denies pending permissions and emits abort status updates', async () => {
    let permissionResponse: AppPermissionResponse | undefined
    let interruptCalls = 0

    const controller = new AppSessionController({
      async *runTurn({ onPermissionRequest, signal }) {
        permissionResponse = await onPermissionRequest({
          requestId: 'perm-2',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'rm -rf /tmp/demo' },
            tool_use_id: 'toolu_2',
          },
        })

        if (signal.aborted) {
          return
        }

        yield createAssistantMessage('should not be emitted')
      },
      abort() {
        interruptCalls += 1
      },
    })
    const events: AppSessionEvent[] = []

    controller.subscribe(event => {
      events.push(event)
    })

    const submitPromise = controller.submit('dangerous command')

    expect(controller.getPendingPermissionRequests()).toHaveLength(1)

    controller.abort('User aborted')
    await submitPromise

    expect(permissionResponse).toEqual({
      behavior: 'deny',
      message: 'User aborted',
    })
    expect(interruptCalls).toBe(1)
    expect(events.map(event => event.type)).toEqual([
      'permission.requested',
      'abort.status',
      'permission.resolved',
      'abort.status',
    ])
    expect(controller.getAbortState()).toEqual({
      status: 'aborted',
      reason: 'User aborted',
    })
    expect(controller.respondToPermissionRequest('perm-2', { behavior: 'allow' })).toBe(
      false,
    )
  })
})
