import { expect, test } from 'bun:test'
import { createComputerWindowCaptureHandler } from './computerWindowCapture.js'

test('capture validates sender and payload, serializes requests, and asks only once', async () => {
  const calls: [string, boolean][] = []
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const handler = createComputerWindowCaptureHandler({ mac: true, trusted: (sender: string) => sender === 'main',
    capture: async (app, ask) => { calls.push([app, ask]); await wait; return { status: 'denied' } },
  })
  const request = { app: ' System Settings ' }
  expect(await handler('iframe', request)).toEqual({ status: 'unavailable' })
  expect(await handler('main', { ...request, windowId: 42 })).toEqual({ status: 'unavailable' })
  expect(await handler('main', { app: '/Applications/Test.app' })).toEqual({ status: 'unavailable' })
  const first = handler('main', request)
  expect(await handler('main', request)).toEqual({ status: 'unavailable' })
  release()
  expect(await first).toEqual({ status: 'denied' })
  expect(await handler('main', request)).toEqual({ status: 'denied' })
  expect(calls).toEqual([['System Settings', true], ['System Settings', false]])
})
