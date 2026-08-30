import { afterEach, expect, test } from 'bun:test'
import { createDirectConnectSession } from './createDirectConnectSession.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('forwards an optional abort signal to the direct-connect POST', async () => {
  let received: RequestInit | undefined
  globalThis.fetch = (async (_input, init) => {
    received = init
    return new Response(
      JSON.stringify({ session_id: 'session-1', ws_url: 'ws://host/session-1' }),
      { status: 200 },
    )
  }) as typeof fetch
  const controller = new AbortController()

  await createDirectConnectSession({
    serverUrl: 'https://host.test',
    cwd: '/workspace',
    signal: controller.signal,
  })

  expect(received?.signal).toBe(controller.signal)
})
