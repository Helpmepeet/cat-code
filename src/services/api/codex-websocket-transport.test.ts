import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  _setWebSocketFactoryForTest,
  CodexWebSocketClosedBeforeCompletedError,
  CodexWebSocketIdleTimeoutError,
  CodexWebSocketUsageLimitError,
  clearWebSocketSession,
  closeSocketPreservingState,
  ensureWebSocketSession,
  reconcileCanonicalDelta,
  registerSendPathLogger,
  streamTurnViaWebSocket,
  streamTurnViaWebSocketLocked,
} from './codex-websocket-transport.js'

// ── Fake WebSocket ────────────────────────────────────────────────────────────

type WsListener = (...args: unknown[]) => void

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  readyState: number = FakeWebSocket.OPEN

  private listeners = new Map<string, WsListener[]>()
  private sent: string[] = []

  // Script of messages to deliver after send(), in order.
  responses: Array<Record<string, unknown>> = []

  triggerOpen() {
    for (const fn of this.listeners.get('open') ?? []) fn()
  }

  triggerUpgrade(headers: Record<string, string | string[]>) {
    for (const fn of this.listeners.get('upgrade') ?? []) fn({ headers })
  }

  triggerError(error?: unknown) {
    for (const fn of this.listeners.get('error') ?? []) fn(error)
    this.readyState = FakeWebSocket.CLOSED
  }

  // Push a message to all 'message' listeners.
  deliver(payload: Record<string, unknown>) {
    const data = JSON.stringify(payload)
    for (const fn of this.listeners.get('message') ?? []) fn(data)
  }

  deliverError(err: Record<string, unknown>) {
    this.deliver({ type: 'error', error: err })
  }

  triggerClose(options?: { code?: number; reason?: string; wasClean?: boolean }) {
    this.readyState = FakeWebSocket.CLOSED
    for (const fn of this.listeners.get('close') ?? []) {
      fn(options?.code, Buffer.from(options?.reason ?? ''))
    }
  }

  on(type: string, fn: WsListener) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  off(type: string, fn: WsListener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(f => f !== fn))
  }

  send(data: string) {
    this.sent.push(data)
    // Auto-deliver queued responses after send.
    for (const msg of this.responses.splice(0)) {
      Promise.resolve().then(() => this.deliver(msg))
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  getSent(): Array<Record<string, unknown>> {
    return this.sent.map(s => JSON.parse(s))
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

const CONV_ID = 'test-conv-id-1111-2222-3333-444444444444'
const AUTH = { Authorization: 'Bearer tok' }

let fakeWs: FakeWebSocket

function installFakeWs(autoOpen = true): FakeWebSocket {
  fakeWs = new FakeWebSocket()
  _setWebSocketFactoryForTest(() => fakeWs as never)
  if (autoOpen) {
    // Trigger open on next tick so ensureWebSocketSession resolves.
    Promise.resolve().then(() => fakeWs.triggerOpen())
  }
  return fakeWs
}

function completedEvent(responseId = 'resp_abc123', inputTokens = 10, cachedTokens = 0) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: cachedTokens },
      },
    },
  }
}

async function collectEvents(gen: AsyncGenerator<Record<string, unknown>>) {
  const events: Record<string, unknown>[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearWebSocketSession(CONV_ID)
})

afterEach(() => {
  clearWebSocketSession(CONV_ID)
  _setWebSocketFactoryForTest(null)
})

describe('streamTurnViaWebSocket', () => {

  // ── Happy path ──────────────────────────────────────────────────────────

  test('full send on first turn — no previous_response_id', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.responses = [completedEvent('resp_001')]
    const body = { instructions: 'hi', input: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'high' } }
    const events = await collectEvents(streamTurnViaWebSocket(CONV_ID, body, AUTH, 1))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.previous_response_id).toBeUndefined()
    expect(sent[0]!.input).toEqual([{ role: 'user', content: 'hello' }])
    expect(events.find(e => e.type === 'response.completed')).toBeDefined()
  })

  test('captures upgrade turn-state but does not echo it in the request body', async () => {
    installFakeWs(false)
    const opened = ensureWebSocketSession(CONV_ID, AUTH)
    fakeWs.triggerUpgrade({ 'x-codex-turn-state': 'turn-state-123' })
    fakeWs.triggerOpen()
    await opened

    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [] },
        AUTH,
        0,
      ),
    )

    expect(fakeWs.getSent()[0]!['x-codex-turn-state']).toBeUndefined()
  })

  // Item 3 rule 1: the per-request prewarm was removed. A locked turn now sends
  // exactly ONE request (the real turn) — no generate=false prewarm seed ahead
  // of it. (The three old tests here pinned the prewarm+real double-send that was
  // the 156-prewarm-per-conversation pathology.)
  test('streamTurnViaWebSocketLocked sends exactly one request (no prewarm)', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.responses = [completedEvent('resp_real')]
    await collectEvents(
      streamTurnViaWebSocketLocked(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'real prompt' }] },
        AUTH,
        1,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(1)
    // The single send is the real turn, not a generate=false prewarm.
    expect(sent[0]!.generate).toBeUndefined()
    expect(sent[0]!.previous_response_id).toBeUndefined()
    expect(sent[0]!.input).toEqual([{ role: 'user', content: 'real prompt' }])
  })

  test('second turn sends delta with previous_response_id', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } }, AUTH, 1))

    const turn2Input = [
      { role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'world', annotations: [] }],
        status: 'completed',
      },
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } }, AUTH, 3))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    // Second turn should use incremental delta
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([{ role: 'user', content: 'next' }])
  })

  test('second turn normalizes prior function-call output items before continuation matching', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          id: 'item_fn_1',
          type: 'function_call',
          call_id: 'call_weather',
          name: 'weather_tool',
          arguments: '{"city":"Paris"}',
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } },
        AUTH,
        1,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'hello' },
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'weather_tool',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'sunny',
      },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
        AUTH,
        3,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'sunny',
      },
    ])
  })

  test('second turn preserves prior web_search_call output items for continuation matching', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'search the web' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          id: 'ws_123',
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'OpenAI web_search',
            sources: [
              {
                type: 'url',
                title: 'OpenAI docs',
                url: 'https://platform.openai.com/docs/guides/tools-web-search',
              },
            ],
          },
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(streamTurnViaWebSocket(
      CONV_ID,
      { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } },
      AUTH,
      1,
    ))

    const priorWebSearchCall = {
      id: 'ws_123',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'OpenAI web_search',
        sources: [
          {
            type: 'url',
            title: 'OpenAI docs',
            url: 'https://platform.openai.com/docs/guides/tools-web-search',
          },
        ],
      },
    }
    const turn2Input = [
      { role: 'user', content: 'search the web' },
      priorWebSearchCall,
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(
      CONV_ID,
      { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
      AUTH,
      3,
    ))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([{ role: 'user', content: 'next' }])
  })

  test('canonical reconciliation tolerates omitted reasoning before tool call output', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'read file' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'opaque_reasoning_blob',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_read',
          name: 'Read',
          arguments: '{"file_path":"src/foo.ts"}',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } },
        AUTH,
        1,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'read file' },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'Read',
        arguments: '{"file_path":"src/foo.ts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: 'const x = 1',
      },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
        AUTH,
        3,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: 'const x = 1',
      },
    ])
  })

  test('canonical reconciliation tolerates omitted reasoning before assistant message output', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'opaque_reasoning_blob',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi.', annotations: [] }],
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } },
        AUTH,
        1,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi.', annotations: [] }],
        status: 'completed',
      },
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
        AUTH,
        3,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([{ role: 'user', content: 'next' }])
  })

  test('canonical reconciliation falls back when reasoning is replayed with different content', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'reasoning_a',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'high' } },
        AUTH,
        1,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'hello' },
      {
        type: 'reasoning',
        summary: [],
        encrypted_content: 'reasoning_b',
      },
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
        AUTH,
        3,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBeUndefined()
    expect(sent[1]!.input).toEqual(turn2Input)
  })

  test('falls back to full send when prior output-item baseline is missing from next input', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'high' } },
        AUTH,
        1,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
        AUTH,
        2,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBeUndefined()
    expect(sent[1]!.input).toEqual(turn2Input)
  })

  test('canonical reconciliation: stays incremental even when freshly translated prefix has normalization drift', async () => {
    // This test verifies the Phase 2 fix: even when normalizeMessagesForAPI rewrites
    // the canonical prefix items (e.g., merges assistant blocks, injects a tag),
    // the canonical-length reconciliation still produces a correct incremental send.
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } }, AUTH, 1))

    // Turn 2: simulate normalization drift in the user-message prefix portion.
    // The user message gets an [id:...] snip tag appended (like appendMessageTagToUserMessage
    // does). The output item from the server must be replayed verbatim — only
    // the sent-input portion is subject to drift from normalizeMessagesForAPI.
    const turn2Input = [
      // Drifted from canonical: [id:...] tag appended to user message content (sent-input portion)
      { role: 'user', content: 'hello [id:abc123]' },
      // Output item replayed verbatim — exactly as stored in lastResponseOutputItems
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'world', annotations: [] }],
        status: 'completed',
      },
      // Genuinely new item
      { role: 'user', content: 'next' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } }, AUTH, 3))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    // Must still use incremental despite prefix drift
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    // Delta should be only the new item
    expect(sent[1]!.input).toEqual([{ role: 'user', content: 'next' }])
  })

  test('canonical reconciliation: full-sends when tool-result content was replaced in place', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const callId = 'call_large_result'
    const turn1Input = [
      { role: 'user', content: 'fetch it' },
      { type: 'function_call', call_id: callId, name: 'WebFetch', arguments: '{}' },
      { type: 'function_call_output', call_id: callId, output: 'original large result' },
    ]
    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn1Input },
        AUTH,
        turn1Input.length,
      ),
    )

    const turn2Input = [
      { role: 'user', content: 'fetch it' },
      { type: 'function_call', call_id: callId, name: 'WebFetch', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: callId,
        output: '[Old tool result content cleared]',
      },
      { role: 'user', content: 'continue' },
    ]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: turn2Input },
        AUTH,
        turn2Input.length,
      ),
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBeUndefined()
    expect(sent[1]!.input).toEqual(turn2Input)
  })

  test('canonical reconciliation: compares multimodal tool outputs structurally', () => {
    const previousInput = [{
      type: 'function_call_output',
      call_id: 'call_image',
      output: [
        { type: 'input_text', text: 'same' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc' },
      ],
    }]
    const unchangedInput = [
      JSON.parse(JSON.stringify(previousInput[0]!)) as Record<string, unknown>,
      { role: 'user', content: 'continue' },
    ]

    expect(
      reconcileCanonicalDelta(unchangedInput, previousInput, []),
    ).toEqual({
      delta: [{ role: 'user', content: 'continue' }],
      mismatchReason: null,
    })

    const changedInput = JSON.parse(JSON.stringify(unchangedInput)) as Array<Record<string, unknown>>
    const changedOutput = changedInput[0]!.output as Array<Record<string, unknown>>
    changedOutput[0]!.text = 'changed'
    expect(
      reconcileCanonicalDelta(changedInput, previousInput, []),
    ).toMatchObject({ delta: null })
  })

  test('canonical reconciliation: falls back to full send when input is shorter than canonical baseline', async () => {
    // Canonical baseline = 1 sent input + 1 output item = 2 items.
    // If next turn's input only has 1 item total (shorter than baseline), must full-send.
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
          status: 'completed',
        },
      },
      completedEvent('resp_001'),
    ]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } }, AUTH, 1))

    // Only 1 item — shorter than the canonical baseline of 2
    const turn2Input = [{ role: 'user', content: 'fresh start' }]
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } }, AUTH, 1))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBeUndefined()
    expect(sent[1]!.input).toEqual(turn2Input)
  })

  test('canonical reconciliation: succeeds with zero-item delta when no new items beyond baseline', async () => {
    // If the next turn's input is exactly the same length as the baseline,
    // delta = [] (empty), which is valid and still uses incremental mode.
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const turn1Input = [{ role: 'user', content: 'hello' }]
    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } }, AUTH, 1))

    // Baseline = 1 sent input + 0 output items = 1. Input also has 1 item.
    // This should produce delta = [] and use previous_response_id.
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } }, AUTH, 1))

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.previous_response_id).toBe('resp_001')
    expect(sent[1]!.input).toEqual([])
  })


  // ── Stale previous_response_id ──────────────────────────────────────────

  test('retries as full send when server rejects previous_response_id', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Seed a prior response_id by completing turn 1.
    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [{ role: 'user', content: 'q' }] }, AUTH, 1))

    // Turn 2: first attempt gets "not found", second attempt succeeds as full send.
    let callCount = 0
    const originalSend = fakeWs.send.bind(fakeWs)
    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      callCount++
      if (callCount === 1) {
        // First send: deliver the "not found" error
        Promise.resolve().then(() =>
          fakeWs.deliver({
            type: 'error',
            error: { message: 'Previous response with id resp_001 not found.' },
          })
        )
      } else {
        // Second send (retry): deliver success
        Promise.resolve().then(() => fakeWs.deliver(completedEvent('resp_002')))
      }
    }

    const turn2Input = [{ role: 'user', content: 'q' }, { role: 'user', content: 'follow' }]
    const events = await collectEvents(
      streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input }, AUTH, 2)
    )

    const sent = fakeWs.getSent()
    expect(sent).toHaveLength(3) // turn1 + two attempts for turn2
    // Retry attempt should be a full send (no previous_response_id)
    expect(sent[2]!.previous_response_id).toBeUndefined()
    expect(sent[2]!.input).toEqual(turn2Input)
    expect(events.find(e => e.type === 'response.completed')).toBeDefined()
  })

  // ── Connection limit ────────────────────────────────────────────────────

  test('reconnects and retries when server hits 60-min connection limit', async () => {
    const fakeSessions: FakeWebSocket[] = []

    _setWebSocketFactoryForTest(() => {
      const ws = new FakeWebSocket()
      fakeSessions.push(ws)
      Promise.resolve().then(() => ws.triggerOpen())
      return ws as never
    })

    await ensureWebSocketSession(CONV_ID, AUTH)
    const ws1 = fakeSessions[0]!

    // Turn 1: complete normally.
    ws1.responses = [completedEvent('resp_001')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [{ role: 'user', content: 'hi' }] }, AUTH, 1))

    // Turn 2: first attempt hits connection limit, second (new WS) succeeds.
    let attempt = 0
    ws1.send = (data: string) => {
      ws1['sent'].push(data)
      attempt++
      Promise.resolve().then(() => {
        ws1.deliverError({ code: 'websocket_connection_limit_reached', message: 'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.' })
      })
    }

    // ws2 will be created on reconnect.
    _setWebSocketFactoryForTest(() => {
      const ws = new FakeWebSocket()
      fakeSessions.push(ws)
      ws.responses = [completedEvent('resp_002')]
      Promise.resolve().then(() => ws.triggerOpen())
      return ws as never
    })

    const turn2Input = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'next' }]
    const events = await collectEvents(
      streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input }, AUTH, 2)
    )

    expect(fakeSessions.length).toBeGreaterThan(1) // new WS was created
    expect(events.find(e => e.type === 'response.completed')).toBeDefined()
  })

  // ── WS close before response.completed ─────────────────────────────────

  test('throws CodexWebSocketClosedBeforeCompletedError when WS closes before any events', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Deliver close event with no events — treated as an ambiguous transport close.
    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      Promise.resolve().then(() => fakeWs.triggerClose())
    }

    await expect(
      collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0))
    ).rejects.toBeInstanceOf(CodexWebSocketClosedBeforeCompletedError)
  })

  // ── turnState scoping ───────────────────────────────────────────────────

  test('does not echo previous turn turnState into next turn request', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Turn 1: complete, no x-codex-turn-state in any message.
    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [{ role: 'user', content: 'q' }] }, AUTH, 1))

    // Turn 2: the request should NOT have x-codex-turn-state since none was received.
    fakeWs.responses = [completedEvent('resp_002')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }] }, AUTH, 2))

    const sent = fakeWs.getSent()
    expect(sent[1]!['x-codex-turn-state']).toBeUndefined()
  })

  // ── Effort change ───────────────────────────────────────────────────────

  test('falls back to full send when effort changes between turns', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.responses = [completedEvent('resp_001')]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [{ role: 'user', content: 'q' }], reasoning: { effort: 'high' } }, AUTH, 1))

    fakeWs.responses = [completedEvent('resp_002')]
    const turn2Input = [{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }]
    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: turn2Input, reasoning: { effort: 'low' } }, AUTH, 2))

    const sent = fakeWs.getSent()
    expect(sent[1]!.previous_response_id).toBeUndefined()
    expect(sent[1]!.input).toEqual(turn2Input)
  })

  // ── Non-retriable errors ────────────────────────────────────────────────

  test('propagates non-retriable WS errors to caller', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      Promise.resolve().then(() =>
        fakeWs.deliverError({ code: 'rate_limit_exceeded', message: 'Rate limit exceeded' })
      )
    }

    await expect(
      collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0))
    ).rejects.toThrow('Rate limit exceeded')
  })

  test('classifies usage-limit WS errors for pool failover', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      Promise.resolve().then(() =>
        fakeWs.deliverError({ message: 'The usage limit has been reached' })
      )
    }

    await expect(
      collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0))
    ).rejects.toBeInstanceOf(CodexWebSocketUsageLimitError)
  })

  // ── WS connect failure → falls back to HTTP ─────────────────────────────

  test('ensureWebSocketSession throws on connect failure', async () => {
    fakeWs = new FakeWebSocket()
    _setWebSocketFactoryForTest(() => fakeWs as never)
    // Trigger error instead of open
    Promise.resolve().then(() => fakeWs.triggerError())

    await expect(ensureWebSocketSession(CONV_ID, AUTH)).rejects.toThrow('WebSocket connect error')
  })

  test('reopens the WS session when the account changes', async () => {
    const fakeSessions: FakeWebSocket[] = []

    _setWebSocketFactoryForTest(() => {
      const ws = new FakeWebSocket()
      fakeSessions.push(ws)
      Promise.resolve().then(() => ws.triggerOpen())
      return ws as never
    })

    await ensureWebSocketSession(CONV_ID, {
      Authorization: 'Bearer tok-a',
      'chatgpt-account-id': 'acct-a',
    })
    await ensureWebSocketSession(CONV_ID, {
      Authorization: 'Bearer tok-b',
      'chatgpt-account-id': 'acct-b',
    })

    expect(fakeSessions).toHaveLength(2)
    expect(fakeSessions[0]?.readyState).toBe(FakeWebSocket.CLOSED)
    expect(fakeSessions[1]?.readyState).toBe(FakeWebSocket.OPEN)
  })

  // Item 3 rule 4: account rotation is NOT a transient reconnect. `sessions` is
  // keyed by conversationId only, so chaining account A's previous_response_id
  // from account B would mis-chain. On an account change the baseline is dropped
  // and the new account's first request is a clean full send.
  test('drops continuation state when the account changes (rule 4)', async () => {
    const fakeSessions: FakeWebSocket[] = []

    _setWebSocketFactoryForTest(() => {
      const ws = new FakeWebSocket()
      fakeSessions.push(ws)
      Promise.resolve().then(() => ws.triggerOpen())
      return ws as never
    })

    const authA = {
      Authorization: 'Bearer tok-a',
      'chatgpt-account-id': 'acct-a',
    }
    const authB = {
      Authorization: 'Bearer tok-b',
      'chatgpt-account-id': 'acct-b',
    }

    await ensureWebSocketSession(CONV_ID, authA)
    fakeSessions[0]!.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        authA,
        1,
      ),
    )

    await ensureWebSocketSession(CONV_ID, authB)
    fakeSessions[1]!.responses = [completedEvent('resp_002')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        {
          instructions: 'sys',
          input: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
          ],
        },
        authB,
        2,
      ),
    )

    expect(fakeSessions).toHaveLength(2)
    // Baseline dropped on rotation: no previous_response_id, full input resent.
    expect(fakeSessions[1]!.getSent()[0]!.previous_response_id).toBeUndefined()
    expect(fakeSessions[1]!.getSent()[0]!.input).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ])
  })

  test('account_id_prefix is populated in send-path entry when account header is present', async () => {
    const authWithAccount = { Authorization: 'Bearer tok', 'chatgpt-account-id': 'acct-0c9b1d6d' }
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, authWithAccount)

    fakeWs.responses = [completedEvent()]

    let capturedEntry: Record<string, unknown> | null = null
    registerSendPathLogger((entry) => {
      capturedEntry = entry as unknown as Record<string, unknown>
    })

    await collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, authWithAccount, 0))

    expect(capturedEntry).not.toBeNull()
    expect(capturedEntry!['account_id_prefix']).toBe('acct-0c9')
  })

  test('classifies WS close with zero events as CodexWebSocketClosedBeforeCompletedError', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      // Close immediately with no events delivered first.
      Promise.resolve().then(() => fakeWs.triggerClose())
    }

    await expect(
      collectEvents(streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0))
    ).rejects.toBeInstanceOf(CodexWebSocketClosedBeforeCompletedError)
  })

  test('WS close after events yields plain transport error, not CodexWebSocketUsageLimitError', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
      // Deliver an event first, then close on the next microtask tick so the
      // generator has a chance to yield the event before the close fires.
      Promise.resolve().then(() => {
        fakeWs.deliver({ type: 'response.created' })
      }).then(() => {
        fakeWs.triggerClose()
      })
    }

    const err = await collectEvents(
      streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0)
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CodexWebSocketUsageLimitError)
    expect(err).toBeInstanceOf(CodexWebSocketClosedBeforeCompletedError)
    expect((err as Error).message).toContain('websocket closed by server before response.completed')
  })

  test('idle timeout surfaces timeout error instead of a synthetic close error', async () => {
    installFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const originalClose = fakeWs.close.bind(fakeWs)

    fakeWs.close = () => {
      fakeWs.triggerClose()
    }

    globalThis.setTimeout = (((cb: TimerHandler) => {
      Promise.resolve().then(() => {
        if (typeof cb === 'function') {
          cb()
        }
      })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    globalThis.clearTimeout = ((() => {}) as typeof clearTimeout)

    fakeWs.send = (data: string) => {
      fakeWs['sent'].push(data)
    }

    try {
      const err = await collectEvents(
        streamTurnViaWebSocket(CONV_ID, { instructions: 'sys', input: [] }, AUTH, 0),
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CodexWebSocketIdleTimeoutError)
      expect((err as Error).message).toBe('idle timeout waiting for websocket')
    } finally {
      fakeWs.close = originalClose
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  // ── Item 3: state-preserving lifecycle ─────────────────────────────────────

  // Installs a factory that hands out a fresh auto-opening FakeWebSocket each
  // time openSession() connects, so a socket swap (reconnect-preserve) after
  // closeSocketPreservingState reopens onto a new socket.
  function installMultiFakeWs(): FakeWebSocket[] {
    const fakeSessions: FakeWebSocket[] = []
    _setWebSocketFactoryForTest(() => {
      const ws = new FakeWebSocket()
      fakeSessions.push(ws)
      Promise.resolve().then(() => ws.triggerOpen())
      return ws as never
    })
    return fakeSessions
  }

  // Rule 2a: a transient mid-stream socket error kills the physical socket (so
  // its late events cannot bleed into the next turn) but KEEPS the continuation
  // baseline, so the next turn reconnects and continues incrementally.
  test('transient socket error closes the socket but preserves the baseline (rule 2a)', async () => {
    const sessionsList = installMultiFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Turn 1 completes and records a baseline.
    sessionsList[0]!.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        AUTH,
        1,
      ),
    )

    // Turn 2 hits an onerror mid-stream (transport 'error' event on the socket).
    sessionsList[0]!.send = (data: string) => {
      sessionsList[0]!['sent'].push(data)
      Promise.resolve().then(() => sessionsList[0]!.triggerError({ message: 'boom' }))
    }
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        {
          instructions: 'sys',
          input: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
          ],
        },
        AUTH,
        2,
      ),
    ).catch(() => undefined)

    // The physical socket was closed...
    expect(sessionsList[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // ...but the baseline survives: reconnect onto a fresh socket (the closed
    // socket forces the reconnect-preserve branch), then the next turn sends an
    // incremental delta anchored on resp_001 (not a full send).
    await ensureWebSocketSession(CONV_ID, AUTH)
    expect(sessionsList).toHaveLength(2)
    sessionsList[1]!.responses = [completedEvent('resp_003')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        AUTH,
        1,
      ),
    )
    const resumed = sessionsList[1]!.getSent()[0]!
    expect(resumed.previous_response_id).toBe('resp_001')
  })

  // Rule 2b: a chained-request server error that is NOT 'not found' must still
  // reset the baseline, so the next send is a clean full send rather than a
  // poisoned incremental that would loop through sticky HTTP fallback forever.
  test('non-"not found" server error closes the socket and resets the baseline (rule 2b)', async () => {
    const sessionsList = installMultiFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Turn 1 records a baseline.
    sessionsList[0]!.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        AUTH,
        1,
      ),
    )

    // Turn 2: server rejects the chained request with a generic (non-TTL) error.
    sessionsList[0]!.send = (data: string) => {
      sessionsList[0]!['sent'].push(data)
      Promise.resolve().then(() =>
        sessionsList[0]!.deliverError({ code: 'server_error', message: 'internal error' }),
      )
    }
    const err = await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        {
          instructions: 'sys',
          input: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
          ],
        },
        AUTH,
        2,
      ),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Codex WS error: internal error')
    expect(sessionsList[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // The next turn reconnects on a fresh physical socket. The baseline reset
    // survives that reconnect, so this is a FULL request with no response anchor.
    await ensureWebSocketSession(CONV_ID, AUTH)
    expect(sessionsList).toHaveLength(2)
    sessionsList[1]!.responses = [completedEvent('resp_003')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        {
          instructions: 'sys',
          input: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
          ],
        },
        AUTH,
        2,
      ),
    )
    const lastSend = sessionsList[1]!.getSent()[0]!
    expect(lastSend.previous_response_id).toBeUndefined()
    expect(lastSend.input).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ])
  })

  test('request abort closes the socket and releases the conversation turn lock', async () => {
    const sessionsList = installMultiFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)
    sessionsList[0]!.send = (data: string) => {
      sessionsList[0]!['sent'].push(data)
      Promise.resolve().then(() =>
        sessionsList[0]!.deliver({ type: 'response.created' }),
      )
    }

    const abortController = new AbortController()
    const turn = streamTurnViaWebSocketLocked(
      CONV_ID,
      { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
      AUTH,
      1,
      abortController.signal,
    )
    await turn.next()
    const pending = turn.next()
    abortController.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(sessionsList[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // A fresh turn can acquire the same conversation lock immediately.
    await ensureWebSocketSession(CONV_ID, AUTH)
    sessionsList[1]!.responses = [completedEvent('resp_after_abort')]
    await collectEvents(
      streamTurnViaWebSocketLocked(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'second' }] },
        AUTH,
        1,
      ),
    )
    expect(sessionsList[1]!.getSent()).toHaveLength(1)
  })

  test('queued request aborts without waiting for the active conversation turn', async () => {
    const sessionsList = installMultiFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)
    sessionsList[0]!.send = (data: string) => {
      sessionsList[0]!['sent'].push(data)
      Promise.resolve().then(() =>
        sessionsList[0]!.deliver({ type: 'response.created' }),
      )
    }

    const active = streamTurnViaWebSocketLocked(
      CONV_ID,
      { instructions: 'sys', input: [{ role: 'user', content: 'active' }] },
      AUTH,
      1,
    )
    await active.next()

    const abortController = new AbortController()
    const queued = streamTurnViaWebSocketLocked(
      CONV_ID,
      { instructions: 'sys', input: [{ role: 'user', content: 'queued' }] },
      AUTH,
      1,
      abortController.signal,
    )
    const pending = queued.next()
    abortController.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(sessionsList[0]!.readyState).toBe(FakeWebSocket.OPEN)
    await active.return(undefined)
  })

  test('request abort interrupts websocket connection setup', async () => {
    const socket = installFakeWs(false)
    const abortController = new AbortController()
    const pending = collectEvents(
      streamTurnViaWebSocketLocked(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'cold start' }] },
        AUTH,
        1,
        abortController.signal,
      ),
    )

    await new Promise(resolve => setTimeout(resolve, 0))
    abortController.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  // Rule 5: an aborted turn (consumer abandons iteration) leaves the socket open
  // and the server still streaming. The generator's finally must close that
  // socket (preserving the baseline) so the dead turn's late response.completed
  // cannot land in the next turn's handler and poison the baseline.
  test('aborted turn closes the socket without poisoning the next baseline (rule 5)', async () => {
    const sessionsList = installMultiFakeWs()
    await ensureWebSocketSession(CONV_ID, AUTH)

    // Turn 1 records a baseline.
    sessionsList[0]!.responses = [completedEvent('resp_001')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        AUTH,
        1,
      ),
    )

    // Turn 2: deliver one event, then the consumer abandons iteration after the
    // first yield (simulating Esc-abort) WITHOUT reaching response.completed.
    sessionsList[0]!.send = (data: string) => {
      sessionsList[0]!['sent'].push(data)
      Promise.resolve().then(() => sessionsList[0]!.deliver({ type: 'response.created' }))
    }
    const gen = streamTurnViaWebSocket(
      CONV_ID,
      {
        instructions: 'sys',
        input: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      },
      AUTH,
      2,
    )
    await gen.next() // consume the first yielded event
    await gen.return(undefined) // abandon the turn (runs the generator finally)

    // The dead socket is closed...
    expect(sessionsList[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // ...even if the dead turn's late response.completed arrives now, it hits a
    // closed socket whose listeners were detached and cannot overwrite the
    // baseline. Reconnect, then the next turn still chains resp_001 from turn 1.
    sessionsList[0]!.deliver(completedEvent('resp_ghost'))
    await ensureWebSocketSession(CONV_ID, AUTH)
    expect(sessionsList).toHaveLength(2)
    sessionsList[1]!.responses = [completedEvent('resp_003')]
    await collectEvents(
      streamTurnViaWebSocket(
        CONV_ID,
        { instructions: 'sys', input: [{ role: 'user', content: 'first' }] },
        AUTH,
        1,
      ),
    )
    expect(sessionsList[1]!.getSent()[0]!.previous_response_id).toBe('resp_001')
  })
})
