import { afterEach, describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  emitAccountDiagnostic,
  installStreamJsonAccountDiagnosticHook,
} from '../services/api/accountDiagnostics.js'
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
  afterEach(() => {
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('emits goal snapshot and message events for a normal turn', async () => {
    const goal: ThreadGoal = {
      threadId: 'session-1',
      goalId: 'goal-1',
      objective: 'Finish the app runtime boundary',
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

  test('emits account diagnostics as message events only for the active submit turn', async () => {
    const goal: ThreadGoal = {
      threadId: 'session-diagnostic',
      goalId: 'goal-diagnostic',
      objective: 'Surface account diagnostics in app runtime events',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAtMs: 100,
      updatedAtMs: 200,
    }
    const diagnostic = {
      code: 'account.transient_failure' as const,
      severity: 'warning' as const,
      provider: 'openai' as const,
      recoverable: true,
      reason: 'temporary failure',
    }
    const outerSinkMessages: SDKMessage[] = []
    let resolveLateDiagnostic: (() => void) | undefined
    const lateDiagnosticEmitted = new Promise<void>(resolve => {
      resolveLateDiagnostic = resolve
    })

    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        outerSinkMessages.push(message)
      },
      getSessionId: () => 'outer-session',
      createUuid: () => `outer-${outerSinkMessages.length + 1}`,
    })

    const controller = new AppSessionController({
      async *runTurn() {
        emitAccountDiagnostic(diagnostic)
        setTimeout(() => {
          emitAccountDiagnostic(diagnostic)
          resolveLateDiagnostic?.()
        }, 0)
        yield createAssistantMessage('hello from runtime')
      },
    })
    const events: AppSessionEvent[] = []

    controller.subscribe(event => {
      events.push(event)
    })

    await controller.submit('hello', { goalSnapshot: goal })

    expect(outerSinkMessages).toHaveLength(0)
    expect(events.map(event => event.type)).toEqual([
      'goal.snapshot',
      'message',
      'message',
    ])
    expect(events[1]).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        subtype: 'cat_code_account_diagnostic',
        session_id: 'session-diagnostic',
        code: 'account.transient_failure',
      },
    })

    const eventCountAfterSubmit = events.length
    await lateDiagnosticEmitted

    expect(events).toHaveLength(eventCountAfterSubmit)
    expect(outerSinkMessages).toHaveLength(1)

    emitAccountDiagnostic(diagnostic)

    expect(events).toHaveLength(eventCountAfterSubmit)
    expect(outerSinkMessages).toHaveLength(2)
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
