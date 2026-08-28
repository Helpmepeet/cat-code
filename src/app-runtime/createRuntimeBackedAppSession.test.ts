import { describe, expect, test } from 'bun:test'
import { createRuntimeBackedAppSession } from './createRuntimeBackedAppSession.js'

describe('createRuntimeBackedAppSession', () => {
  test('creates an AppSessionController from a complete QueryEngine config', async () => {
    const controller = createRuntimeBackedAppSession({
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

  /* The desktop's only signal that a compaction is running. It is PUSHED from
   * inside the compaction service (`src/services/compact/compact.ts`
   * `setSDKStatus`), not yielded from the turn, so it needs a controller that
   * does not exist when the session is built. This callback was simply unset on
   * this path before, and the app reported "Working" for the whole compaction.
   * The terminal wires the identical message at `src/cli/print.ts`. */
  test('the engine status callback reaches subscribers as a status message', async () => {
    const seen: unknown[] = []
    const controller = createRuntimeBackedAppSession({
      queryEngineConfig: {
        cwd: '/tmp',
        tools: [],
        commands: [],
        mcpClients: [],
        agents: [],
        getAppState: () => ({}) as never,
        setAppState: () => undefined,
        readFileCache: new Map() as never,
        createEngine: (config: { setSDKStatus?: (s: unknown) => void }) => ({
          async *submitMessage() {
            config.setSDKStatus?.('compacting')
            config.setSDKStatus?.(null)
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'done' }] },
            } as never
          },
        }),
      } as never,
    })

    controller.subscribe(event => {
      if (event.type === 'message') seen.push(event.message)
    })
    await controller.submit('hello')

    expect(seen).toMatchObject([
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null },
      { type: 'assistant' },
    ])
  })
})
