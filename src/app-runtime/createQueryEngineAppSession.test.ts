import { describe, expect, test } from 'bun:test'

import { createQueryEngineAppSession } from './createQueryEngineAppSession.js'

describe('createQueryEngineAppSession abort lifecycle', () => {
  test('refreshes abort state without recreating the session engine', async () => {
    let createEngineCalls = 0
    let refreshAbortControllerCalls = 0
    let interruptCalls = 0
    let receivedIntent: 'interrupt' | undefined
    let rewindTarget = ''
    let forkTarget = ''
    const session = createQueryEngineAppSession({
      cwd: '/tmp',
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      getAppState: () => ({}) as never,
      setAppState: () => undefined,
      readFileCache: new Map() as never,
      createEngine: () => {
        createEngineCalls += 1
        return {
          refreshAbortController() {
            refreshAbortControllerCalls += 1
          },
          interrupt(intent) {
            interruptCalls += 1
            receivedIntent = intent
          },
          async rewindBeforeUserMessage(targetUuid: string) {
            rewindTarget = targetUuid
            return { prompt: {} as never, retainedMessages: [] }
          },
          async forkBeforeUserMessage(targetUuid: string) {
            forkTarget = targetUuid
            return { sessionId: 'fork' } as never
          },
          async *submitMessage(prompt: string) {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: prompt }] },
            } as never
          },
        }
      },
    } as never)

    for await (const _message of session.submitMessage('first')) {
      // drain
    }
    session.interrupt?.('interrupt')
    await session.rewindBeforeUserMessage?.('rewind-target')
    await session.forkBeforeUserMessage?.('fork-target')
    for await (const _message of session.submitMessage('second')) {
      // drain
    }

    expect(createEngineCalls).toBe(1)
    expect(refreshAbortControllerCalls).toBe(2)
    expect(interruptCalls).toBe(1)
    expect(receivedIntent).toBe('interrupt')
    expect(rewindTarget).toBe('rewind-target')
    expect(forkTarget).toBe('fork-target')
  })
})
