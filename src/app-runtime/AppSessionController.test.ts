import { afterEach, describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import { createThreadGoal } from '../utils/threadGoal.js'
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
      ...createThreadGoal('session-1', 'Finish the app runtime boundary', 1000, 100),
      goalId: 'goal-1',
      tokensUsed: 10,
      timeUsedSeconds: 2,
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

    // `turn.status` brackets the turn: a subscriber that joins after attach
    // learns the turn started and finished without re-reading a snapshot.
    expect(events.map(event => event.type)).toEqual([
      'turn.status',
      'goal.snapshot',
      'message',
      'message',
      'turn.status',
    ])
    expect(events.at(0)).toEqual({ type: 'turn.status', activeTurn: true })
    expect(events.at(-1)).toEqual({ type: 'turn.status', activeTurn: false })
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
      'turn.status',
      'permission.requested',
      'permission.resolved',
      'message',
      'message',
      'turn.status',
    ])
    expect(controller.getPendingPermissionRequests()).toEqual([])
  })

  test('emits account diagnostics as message events only for the active submit turn', async () => {
    const goal: ThreadGoal = {
      ...createThreadGoal(
        'session-diagnostic',
        'Surface account diagnostics in app runtime events',
        1000,
        100,
      ),
      goalId: 'goal-diagnostic',
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
      'turn.status',
      'goal.snapshot',
      'message',
      'message',
      'turn.status',
    ])
    expect(events[2]).toMatchObject({
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
    // An aborted turn still reports its end. `setActiveTurn(false)` runs at the
    // top of the same `finally` that settles the abort, so the turn-over signal
    // lands BEFORE the final `aborted` classification — a client watching only
    // for a clean result can never be left showing a turn that is already over.
    expect(events.map(event => event.type)).toEqual([
      'turn.status',
      'permission.requested',
      'abort.status',
      'permission.resolved',
      'turn.status',
      'abort.status',
    ])
    expect(events[4]).toEqual({ type: 'turn.status', activeTurn: false })
    expect(controller.getAbortState()).toEqual({
      status: 'aborted',
      reason: 'User aborted',
    })
    expect(controller.respondToPermissionRequest('perm-2', { behavior: 'allow' })).toBe(
      false,
    )
  })

  test('keeps the human abort reason separate from the adapter interrupt intent', async () => {
    const exerciseAbort = async (adapterIntent?: 'interrupt') => {
      let signal: AbortSignal | undefined
      let resolveStarted: (() => void) | undefined
      let releaseTurn: (() => void) | undefined
      let receivedIntent: 'interrupt' | undefined
      const started = new Promise<void>(resolve => {
        resolveStarted = resolve
      })
      const turnGate = new Promise<void>(resolve => {
        releaseTurn = resolve
      })
      const controller = new AppSessionController({
        async *runTurn(args) {
          signal = args.signal
          resolveStarted?.()
          await turnGate
        },
        abort(intent) {
          receivedIntent = intent
          releaseTurn?.()
        },
      })

      const submitPromise = controller.submit('queued message')
      await started
      controller.abort('Human stopped the turn', adapterIntent)
      await submitPromise

      return {
        receivedIntent,
        signalReason: signal?.reason,
        abortState: controller.getAbortState(),
      }
    }

    const normalAbort = await exerciseAbort()
    expect(normalAbort.receivedIntent).toBeUndefined()
    expect(normalAbort.signalReason).toBe('Human stopped the turn')
    expect(normalAbort.abortState).toEqual({
      status: 'aborted',
      reason: 'Human stopped the turn',
    })

    const submitInterrupt = await exerciseAbort('interrupt')
    expect(submitInterrupt.receivedIntent).toBe('interrupt')
    expect(submitInterrupt.signalReason).toBe('Human stopped the turn')
    expect(submitInterrupt.abortState).toEqual({
      status: 'aborted',
      reason: 'Human stopped the turn',
    })
  })

  test('waitUntilIdle settles from the active-turn writer without polling', async () => {
    let releaseTurn: (() => void) | undefined
    const turnGate = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const controller = new AppSessionController({
      async *runTurn() {
        await turnGate
        yield createResultMessage('done')
      },
    })

    const submit = controller.submit('wait')
    expect(controller.isTurnActive()).toBe(true)
    let idleSettled = false
    const idle = controller.waitUntilIdle().then(() => {
      idleSettled = true
    })
    await Promise.resolve()
    expect(idleSettled).toBe(false)

    releaseTurn?.()
    await submit
    await idle

    expect(controller.isTurnActive()).toBe(false)
    expect(idleSettled).toBe(true)
    await expect(controller.waitUntilIdle()).resolves.toBeUndefined()
  })
})
