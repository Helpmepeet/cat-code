import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  createQueryEngineSessionAdapter,
  createQueryEngineSessionController,
  type QueryEngineSessionOptions,
} from './createQueryEngineSessionController.js'

function createAssistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  }
}

describe('createQueryEngineSessionController', () => {
  test('adapts QueryEngine-like submitMessage calls to controller turns', async () => {
    let receivedPrompt = ''
    let receivedOptions: QueryEngineSessionOptions | undefined
    let permissionBehavior = 'missing'

    const controller = createQueryEngineSessionController({
      async *submitMessage(prompt, options) {
        receivedPrompt = prompt
        receivedOptions = options

        const permissionResponse = await options?.onPermissionRequest?.({
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Read',
            input: { file_path: '/tmp/demo.txt' },
            tool_use_id: 'toolu_1',
          },
        })
        permissionBehavior = permissionResponse?.behavior ?? 'missing'

        yield createAssistantMessage(permissionBehavior)
      },
    })

    const submitPromise = controller.submit('read the file', {
      uuid: 'prompt-1',
      isMeta: true,
      origin: {
        kind: 'task-notification',
        taskId: 'worker-1',
        summary: 'Agent @Ada completed',
      },
    })

    expect(receivedPrompt).toBe('read the file')
    expect(receivedOptions?.uuid).toBe('prompt-1')
    expect(receivedOptions?.isMeta).toBe(true)
    expect(receivedOptions?.origin).toMatchObject({
      kind: 'task-notification',
      taskId: 'worker-1',
    })
    expect(typeof receivedOptions?.onPermissionRequest).toBe('function')

    controller.respondToPermissionRequest('perm-1', {
      behavior: 'allow',
      updatedInput: {},
    })
    await submitPromise

    expect(permissionBehavior).toBe('allow')
  })

  test('adapter abort delegates to interrupt', () => {
    let interruptCalls = 0
    let receivedIntent: 'interrupt' | undefined

    const adapter = createQueryEngineSessionAdapter({
      async *submitMessage() {
        yield createAssistantMessage('noop')
      },
      interrupt(intent) {
        interruptCalls += 1
        receivedIntent = intent
      },
    })

    adapter.abort?.('interrupt')

    expect(interruptCalls).toBe(1)
    expect(receivedIntent).toBe('interrupt')
  })

  test('exposes message-targeted history operations without changing turn lifecycle', async () => {
    const targets: string[] = []
    const controller = createQueryEngineSessionController({
      async *submitMessage() {
        yield createAssistantMessage('noop')
      },
      async rewindBeforeUserMessage(targetUuid) {
        targets.push(`rewind:${targetUuid}`)
        return { prompt: {} as never, retainedMessages: [] }
      },
      async forkBeforeUserMessage(targetUuid) {
        targets.push(`fork:${targetUuid}`)
        return { sessionId: 'fork' } as never
      },
    })

    await controller.rewindBeforeUserMessage('message-a')
    await controller.forkBeforeUserMessage('message-b')

    expect(targets).toEqual(['rewind:message-a', 'fork:message-b'])
  })
})
