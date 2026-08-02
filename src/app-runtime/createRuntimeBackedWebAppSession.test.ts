import { describe, expect, test } from 'bun:test'
import { createRuntimeBackedWebAppSession } from './createRuntimeBackedWebAppSession.js'

describe('createRuntimeBackedWebAppSession', () => {
  test('creates an AppSessionController from a complete QueryEngine config', async () => {
    const controller = createRuntimeBackedWebAppSession({
      queryEngineConfig: {
        cwd: '/tmp',
        tools: [],
        commands: [],
        mcpClients: [],
        agents: [],
        getAppState: () => ({}) as never,
        setAppState: () => undefined,
        readFileCache: new Map() as never,
        createEngine: () => ({
          async *submitMessage(prompt: string) {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: prompt }] },
            } as never
          },
        }),
      } as never,
    })

    const events: string[] = []
    controller.subscribe(event => events.push(event.type))
    await controller.submit('hello')

    expect(events).toEqual(['turn.status', 'message', 'turn.status'])
  })
})
