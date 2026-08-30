import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import { SessionsWebSocket } from './SessionsWebSocket.js'

type Listener = (event: unknown) => void

/**
 * Hand-driven stand-in for the Bun global WebSocket that SessionsWebSocket
 * constructs. Events fire only when the test calls emit(), so a superseded
 * socket's late close can be delivered after its replacement exists.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  closeCalls = 0
  pingCalls = 0
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  removeEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type)
    if (!existing) {
      return
    }
    this.listeners.set(
      type,
      existing.filter(entry => entry !== listener),
    )
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls++
  }

  ping(): void {
    this.pingCalls++
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
  }
}

type FakeTimer = { id: number; fn: () => void }

const timeouts: FakeTimer[] = []
const intervals: FakeTimer[] = []
let nextTimerId = 1

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realWebSocket = globalThis.WebSocket
const realDisableErrorReporting = process.env.DISABLE_ERROR_REPORTING

function runPendingTimeouts(): void {
  const pending = timeouts.splice(0, timeouts.length)
  for (const timer of pending) {
    timer.fn()
  }
}

function runPendingIntervals(): void {
  for (const timer of [...intervals]) {
    timer.fn()
  }
}

const RESPONSE: SDKControlResponse = {
  type: 'control_response',
  response: { subtype: 'success', request_id: 'req-1' },
}

function currentSocket(client: SessionsWebSocket): unknown {
  return (client as unknown as { ws: unknown }).ws
}

describe('SessionsWebSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    timeouts.length = 0
    intervals.length = 0
    nextTimerId = 1
    process.env.DISABLE_ERROR_REPORTING = '1'

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    globalThis.setTimeout = ((fn: () => void) => {
      const id = nextTimerId++
      timeouts.push({ id, fn })
      return id
    }) as unknown as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((id: number) => {
      const index = timeouts.findIndex(timer => timer.id === id)
      if (index >= 0) {
        timeouts.splice(index, 1)
      }
    }) as unknown as typeof globalThis.clearTimeout
    globalThis.setInterval = ((fn: () => void) => {
      const id = nextTimerId++
      intervals.push({ id, fn })
      return id
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = ((id: number) => {
      const index = intervals.findIndex(timer => timer.id === id)
      if (index >= 0) {
        intervals.splice(index, 1)
      }
    }) as unknown as typeof globalThis.clearInterval
  })

  afterEach(() => {
    globalThis.WebSocket = realWebSocket
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    if (realDisableErrorReporting === undefined) {
      delete process.env.DISABLE_ERROR_REPORTING
    } else {
      process.env.DISABLE_ERROR_REPORTING = realDisableErrorReporting
    }
  })

  function connectClient(overrides: {
    onClose?: () => void
    onError?: (error: Error) => void
  }): SessionsWebSocket {
    const client = new SessionsWebSocket(
      'session-1',
      'org-1',
      () => 'token',
      {
        onMessage: () => {},
        ...overrides,
      },
    )
    void client.connect()
    FakeWebSocket.instances[0]?.emit('open')
    return client
  }

  test('a superseded socket close cannot break the replacement connection', () => {
    let closes = 0
    const client = connectClient({ onClose: () => closes++ })
    expect(client.isConnected()).toBe(true)

    // Force reconnect: close() runs now, the replacement is built 500ms later.
    client.reconnect()
    runPendingTimeouts()

    const [first, second] = FakeWebSocket.instances
    expect(FakeWebSocket.instances).toHaveLength(2)

    // The old peer's close handshake only lands now, after the replacement
    // socket already owns this.ws.
    first!.emit('close', { code: 1006, reason: 'stale' })

    expect(closes).toBe(0)
    expect(currentSocket(client)).toBe(second)

    // The replacement then opens.
    second!.emit('open')

    expect(client.isConnected()).toBe(true)
    expect(currentSocket(client)).toBe(second)

    client.sendControlResponse(RESPONSE)
    expect(second!.sent).toHaveLength(1)
    expect(first!.sent).toHaveLength(0)
  })

  test('a superseded socket close leaves the replacement ping interval running', () => {
    const client = connectClient({})

    client.reconnect()
    runPendingTimeouts()

    const [first, second] = FakeWebSocket.instances
    second!.emit('open')
    first!.emit('close', { code: 1006, reason: 'stale' })

    runPendingIntervals()
    expect(second!.pingCalls).toBe(1)

    client.close()
  })

  test('the current socket still reports a permanent close to the caller', () => {
    let closes = 0
    const client = connectClient({ onClose: () => closes++ })

    FakeWebSocket.instances[0]!.emit('close', { code: 4003, reason: 'nope' })

    expect(closes).toBe(1)
    expect(client.isConnected()).toBe(false)
    expect(currentSocket(client)).toBe(null)
  })
})
