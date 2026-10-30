import { expect, test } from 'bun:test'
import { translateCodexStreamToAnthropic } from '../../src/services/api/codex-fetch-adapter.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { createOutputTokenState, reduceOutputTokenState, selectOutputTokens } from '../renderer/src/outputTokenState.js'

// The adapter counts text chunks until upstream usage replaces that estimate.
// That fallback has no provenance bit on the wire; pin the limitation explicitly.
async function readingFor(usage?: { output_tokens: number }, text = 'x'.repeat(80)) {
  const events = [
    ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
    { type: 'response.completed', response: { id: 'response-fixture', ...(usage ? { usage } : {}) } },
  ]
  const input = new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  const translated = await translateCodexStreamToAnthropic(input, 'gpt-6.1-sol')
  const body = await translated.text()
  const wireEvents = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const sessionId = 'adapter-fixture'
  const frames: ServerFrame[] = [
    {
      kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: 'engine-fixture',
      payload: {
        type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
      },
    },
    { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId, event: { type: 'turn.status', activeTurn: true } },
    ...wireEvents.map((event, index) => ({
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
      event: { type: 'message', message: {
        type: 'stream_event', parent_tool_use_id: null, session_id: 'engine-fixture', uuid: `adapter-${index}`, event,
      } },
    } as ServerFrame)),
  ]
  return {
    wireEvents,
    reading: selectOutputTokens(reduceOutputTokenState(createOutputTokenState(), { type: 'frames', frames }), sessionId),
  }
}

test('missing Codex usage exposes an indistinguishable chunk-count fallback on the current wire', async () => {
  const { reading, wireEvents } = await readingFor()
  expect(wireEvents.find(event => event.type === 'message_delta')?.usage.output_tokens).toBe(1)
  expect(reading).toEqual({ tokens: 1, quality: 'reported' })
})

test('actual Codex final output replaces the estimate without adding reasoning twice', async () => {
  const { reading } = await readingFor({ output_tokens: 1234 })
  expect(reading).toEqual({ tokens: 1234, quality: 'reported' })
})

test('Codex zero usage falls back to chunk count for visible text and stays zero for empty output', async () => {
  const visible = await readingFor({ output_tokens: 0 })
  expect(visible.wireEvents.find(event => event.type === 'message_delta')?.usage.output_tokens).toBe(1)
  expect(visible.reading).toEqual({ tokens: 1, quality: 'reported' })
  expect((await readingFor({ output_tokens: 0 }, '')).reading).toEqual({ tokens: 0, quality: 'reported' })
})
