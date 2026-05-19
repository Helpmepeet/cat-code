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
    })

    expect(receivedPrompt).toBe('read the file')
    expect(receivedOptions?.uuid).toBe('prompt-1')
    expect(receivedOptions?.isMeta).toBe(true)
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

    const adapter = createQueryEngineSessionAdapter({
      async *submitMessage() {
        yield createAssistantMessage('noop')
      },
      interrupt() {
        interruptCalls += 1
      },
    })

    adapter.abort?.()

    expect(interruptCalls).toBe(1)
  })
})
