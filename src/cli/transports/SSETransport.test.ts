import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  parseSSEFrames,
  SSETransport,
  type StreamClientEvent,
} from './SSETransport.js'

const SSE_URL = new URL(
  'https://example.invalid/v2/session_ingress/session/s1/events/stream',
)

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout
const ORIGINAL_CLEAR_TIMEOUT = globalThis.clearTimeout

// connect() builds a User-Agent from the build-time MACRO, which only exists
// inside the bundle.
const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string }
}
const ORIGINAL_MACRO = macroState.MACRO

beforeEach(() => {
  macroState.MACRO = { VERSION: 'test-version' }
})

afterEach(() => {
  macroState.MACRO = ORIGINAL_MACRO
  globalThis.fetch = ORIGINAL_FETCH
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT
  globalThis.clearTimeout = ORIGINAL_CLEAR_TIMEOUT
})

/** A transport with auth injected, so tests never read process-wide token env. */
function makeTransport(): SSETransport {
  return new SSETransport(SSE_URL, {}, 's1', undefined, undefined, () => ({}))
}

/** One `event: client_event` frame carrying a StreamClientEvent proto JSON. */
function clientEventFrame(seqNum: number, eol = '\n'): string {
  const event: StreamClientEvent = {
    event_id: `e${seqNum}`,
    sequence_num: seqNum,
    event_type: 'user_message',
    source: 'cli',
    payload: { type: 'user', text: 'hello' },
    created_at: '2026-01-01T00:00:00Z',
  }
  return (
    `event: client_event${eol}` +
    `id: ${seqNum}${eol}` +
    `data: ${JSON.stringify(event)}${eol}${eol}`
  )
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('SSETransport duplicate sequence numbers', () => {
  test('delivers a redelivered sequence number exactly once', async () => {
    const transport = makeTransport()
    const data: string[] = []
    const events: StreamClientEvent[] = []
    transport.setOnData(d => data.push(d))
    transport.setOnEvent(e => events.push(e))

    const stream = bodyOf(clientEventFrame(12) + clientEventFrame(12))
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: stream,
    })) as unknown as typeof fetch

    try {
      await transport.connect()
    } finally {
      transport.close()
    }

    expect(data.length).toBe(1)
    expect(events.length).toBe(1)
    expect(events[0]?.sequence_num).toBe(12)
    expect(transport.getLastSequenceNum()).toBe(12)
  })

  test('delivers distinct sequence numbers on the same stream', async () => {
    const transport = makeTransport()
    const events: StreamClientEvent[] = []
    transport.setOnEvent(e => events.push(e))

    const stream = bodyOf(clientEventFrame(3) + clientEventFrame(4))
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: stream,
    })) as unknown as typeof fetch

    try {
      await transport.connect()
    } finally {
      transport.close()
    }

    expect(events.map(e => e.sequence_num)).toEqual([3, 4])
    expect(transport.getLastSequenceNum()).toBe(4)
  })
})

describe('SSETransport connect deadline', () => {
  test('a connect that never returns headers reconnects instead of hanging', async () => {
    const transport = makeTransport()

    // Record timers instead of running them, so the deadline is driven by the
    // test rather than by wall-clock time.
    const timers: Array<{ fn: () => void; delay: number }> = []
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      timers.push({ fn, delay })
      return 0
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout

    let signal: AbortSignal | undefined
    globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal
      // Black-holed endpoint: headers never arrive.
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }) as unknown as typeof fetch

    const connected = transport.connect()
    try {
      const deadline = timers.find(t => t.delay >= 1000)
      expect(deadline).toBeDefined()

      deadline?.fn()
      await connected

      expect(signal?.aborted).toBe(true)
      // The normal reconnect budget engaged: a retry is scheduled and the
      // transport has not silently closed.
      const reconnect = timers.filter(t => t !== deadline)
      expect(reconnect.length).toBeGreaterThan(0)
      expect(transport.isClosedStatus()).toBe(false)
      expect(transport.isConnectedStatus()).toBe(false)
    } finally {
      transport.close()
    }
  })
})

describe('parseSSEFrames line endings', () => {
  test('parses a CRLF event stream', () => {
    const { frames, remaining } = parseSSEFrames(
      'event: client_event\r\nid: 7\r\ndata: {"a":1}\r\n\r\n',
    )

    expect(frames.length).toBe(1)
    expect(frames[0]?.event).toBe('client_event')
    expect(frames[0]?.id).toBe('7')
    expect(frames[0]?.data).toBe('{"a":1}')
    expect(remaining).toBe('')
  })

  test('concatenates multiple CRLF data lines and keeps a partial tail', () => {
    const { frames, remaining } = parseSSEFrames(
      'event: client_event\r\ndata: one\r\ndata: two\r\n\r\nevent: cli',
    )

    expect(frames.length).toBe(1)
    expect(frames[0]?.data).toBe('one\ntwo')
    expect(remaining).toBe('event: cli')
  })

  test('does not treat a single CRLF line ending as a frame boundary', () => {
    const incomplete = 'event: client_event\r\ndata: {"a":1}\r\n'
    const { frames, remaining } = parseSSEFrames(incomplete)

    expect(frames.length).toBe(0)
    expect(remaining).toBe(incomplete)
  })

  test('still parses LF streams and comment keepalives', () => {
    const { frames, remaining } = parseSSEFrames(
      ':keepalive\n\nevent: client_event\ndata: {"a":1}\n\n',
    )

    expect(frames.length).toBe(2)
    expect(frames[0]?.data).toBeUndefined()
    expect(frames[1]?.event).toBe('client_event')
    expect(frames[1]?.data).toBe('{"a":1}')
    expect(remaining).toBe('')
  })
})
