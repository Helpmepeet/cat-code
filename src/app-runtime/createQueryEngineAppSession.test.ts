import { describe, expect, test } from 'bun:test'

import { createQueryEngineAppSession } from './createQueryEngineAppSession.js'

describe('createQueryEngineAppSession abort lifecycle', () => {
  test('refreshes abort state without recreating the session engine', async () => {
    let createEngineCalls = 0
    let refreshAbortControllerCalls = 0
    let interruptCalls = 0
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
          interrupt() {
            interruptCalls += 1
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
    session.interrupt?.()
    for await (const _message of session.submitMessage('second')) {
      // drain
    }

    expect(createEngineCalls).toBe(1)
    expect(refreshAbortControllerCalls).toBe(2)
    expect(interruptCalls).toBe(1)
  })
})
