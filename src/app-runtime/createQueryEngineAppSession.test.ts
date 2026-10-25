import { describe, expect, test } from 'bun:test'

import { createQueryEngineAppSession } from './createQueryEngineAppSession.js'

describe('createQueryEngineAppSession abort lifecycle', () => {
  test('captures before lazy iteration and preserves explicit queue context', async () => {
    const history = [{
      type: 'assistant', uuid: 'a', message: { model: 'claude', content: [{ type: 'text', text: 'Do A?' }] },
    }] as unknown as import('../types/message.js').Message[]
    const received: unknown[] = []
    const session = createQueryEngineAppSession({
      cwd: '/tmp', tools: [], commands: [], mcpClients: [], agents: [],
      getAppState: () => ({}) as never, setAppState: () => undefined, readFileCache: new Map() as never,
      createEngine: () => ({
        getMessages: () => history,
        async *submitMessage(_prompt, options) { received.push(options?.priorAssistantContext) },
      }),
    })
    const submitted = session.submitMessage('Sure')
    history.push({ ...history[0]!, uuid: 'b' } as import('../types/message.js').Message)
    for await (const _ of submitted) { /* drain */ }
    for await (const _ of session.submitMessage('Legacy', { priorAssistantContext: null })) { /* drain */ }
    expect(received[0]).toMatchObject({ messageUuid: 'a' })
    expect(received[1]).toBeNull()
  })
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
