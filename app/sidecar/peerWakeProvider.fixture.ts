// The sidecar still runs its real provider stream parser and tool loop. Only
// the remote provider is replaced; unexpected requests cannot leave the probe.
import { randomUUID } from 'node:crypto'

globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = input instanceof Request ? input.method : init?.method
  if (url.origin !== 'https://peer-wake.invalid') throw new Error('Unexpected provider in peer wake probe')
  if (method === 'HEAD') return new Response(null, { status: 204 })
  if (url.pathname !== '/v1/messages' || method !== 'POST') throw new Error('Unexpected provider request in peer wake probe')
  const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body))
  const content = body.messages.at(-1)?.content
  const recipient = body.tools?.some((tool: { name: string }) => tool.name === 'SendToPeer')
    && /peer-wake send to ([A-Za-z]+): ([^"\\]+)/.exec(JSON.stringify(content ?? ''))
  const quiet = Array.isArray(content) && content.some(block => block.type === 'tool_result' &&
    block.tool_use_id?.startsWith('toolu_peer_wake_'))
  const toolUseId = recipient && !quiet ? 'toolu_peer_wake_' + randomUUID() : undefined
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: {
    id: randomUUID(), type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
  } }]
  if (toolUseId && recipient) {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'SendToPeer', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ peers: [recipient[1]], text: recipient[2] }) } },
      { type: 'content_block_stop', index: 0 },
    )
  } else if (quiet && process.env.PEER_WAKE_RESPONSE === 'reasoning') {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } },
      { type: 'content_block_stop', index: 0 },
    )
  } else if (!quiet || process.env.PEER_WAKE_RESPONSE === 'whitespace') {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: quiet ? ' \n ' : 'Peer wake probe finished.' } },
      { type: 'content_block_stop', index: 0 },
    )
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: toolUseId ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  )
  return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}, { preconnect: () => { throw new Error('Network preconnect in peer wake probe') } })
