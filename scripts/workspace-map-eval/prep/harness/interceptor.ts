// Preloaded into the sidecar (bun --preload). Replaces every network path the
// engine uses with local fakes: the Codex WebSocket transport gets a scripted
// in-process server, fetch fails closed. Each model request body is recorded
// so the effective instructions, tools, and context can be inspected.
// No byte leaves the machine; the harness also runs under sandbox-exec with
// outbound IP denied.
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.CCW_PROBE_DIR!
const engine = process.env.CCW_ENGINE!
const noWsFake = process.env.CCW_NO_WS_FAKE === '1'
// Optional shell check the scripted main thread runs first (e.g. which gh).
const probeBash = process.env.CCW_PROBE_BASH ?? ''
// Keep probe plumbing out of every child environment: the model's shell, hooks,
// and nested bun processes must not see or inherit it.
for (const k of ['CCW_PROBE_DIR', 'CCW_ENGINE', 'CCW_NO_WS_FAKE', 'CCW_PROBE_BASH', 'BUN_OPTIONS']) delete process.env[k]
mkdirSync(join(dir, 'requests'), { recursive: true })
let seq = 0

function log(line: string) {
  appendFileSync(join(dir, 'interceptor.log'), `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
}

function redact(headers: Record<string, string> = {}) {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = /auth|token|cookie|account/i.test(k) ? '<redacted>' : v
  return out
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  if (url.startsWith('https://chatgpt.com/backend-api/codex/responses') && typeof init?.body === 'string') {
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers
    const events = recordRequest('http', url, headers, JSON.parse(init.body))
    const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.startsWith('https://api.anthropic.com/v1/messages') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body)
    const n = String(++seq).padStart(3, '0')
    writeFileSync(join(dir, 'requests', `${process.pid}-${n}-anthropic-${body.model}.json`), JSON.stringify({ url, body }, null, 1))
    log(`anthropic request ${n} model=${body.model} tools=${(body.tools ?? []).length}`)
    const text = 'Subagent probe finished.'
    const ev = [
      ['message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return new Response(ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_probe' } })
  }
  if (url.replace(/\/$/, '') === 'https://api.anthropic.com' && (init?.method ?? 'GET') === 'HEAD') {
    log('fetch faked HEAD https://api.anthropic.com (connectivity preflight)')
    return new Response(null, { status: 200 })
  }
  log(`fetch BLOCKED ${init?.method ?? 'GET'} ${url}`)
  return new Response('Network disabled by offline harness', { status: 503 })
}) as typeof fetch

type Item = Record<string, any>
const ids = { n: 0 }
const nextId = (p: string) => `${p}_${++ids.n}`
const usage = { input_tokens: 1000, output_tokens: 10, total_tokens: 1010, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }

function completed(output: Item[]) {
  return { type: 'response.completed', response: { id: nextId('resp'), status: 'completed', output, usage } }
}

function callEvents(name: string, args: Record<string, unknown>, callId: string): Item[] {
  const id = nextId('fc')
  const a = JSON.stringify(args)
  const item = { type: 'function_call', id, call_id: callId, name, arguments: a, status: 'completed' }
  return [
    { type: 'response.created', response: { id: nextId('resp'), status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: id, delta: a },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: id, arguments: a },
    { type: 'response.output_item.done', output_index: 0, item },
    completed([item]),
  ]
}

function textEvents(text: string): Item[] {
  const id = nextId('msg')
  const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', response: { id: nextId('resp'), status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, item_id: id, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: id, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: id, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: id, content_index: 0, part: { type: 'output_text', text } },
    { type: 'response.output_item.done', output_index: 0, item },
    completed([item]),
  ]
}

// Benign values from a JSON schema: allow/false for verdicts, short text otherwise.
function fill(schema: Item): unknown {
  if (schema.enum) return schema.enum[0]
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, fill(v as Item)]))
    case 'array': return []
    case 'boolean': return false
    case 'number': case 'integer': return 0
    default: return 'offline probe'
  }
}

function toolNamed(body: Item, name: string): Item | undefined {
  return (body.tools ?? []).find((t: Item) => t.name === name)
}

function inputText(body: Item): string {
  return JSON.stringify(body.input ?? [])
}

// Probe script: main thread does one broad Grep (hook dispatch), then spawns one
// subagent; the subagent does its own broad Grep, then both finish. The
// WebSocket transport sends incremental input, so state is kept per thread.
const threads = new Map<string, { sub: boolean; outputs: Set<string> }>()
function script(body: Item): { label: string; events: Item[] } {
  const key = String(body.prompt_cache_key ?? body.previous_response_id ?? 'none') + ':' + String((body.instructions ?? '').length)
  const text = inputText(body)
  if (!threads.has(key)) threads.set(key, { sub: text.includes('OFFLINE_PROBE_SUBAGENT'), outputs: new Set() })
  const st = threads.get(key)!
  for (const i of body.input ?? []) if ((i.type === 'function_call_output' || i.type === 'custom_tool_call_output') && i.call_id) st.outputs.add(i.call_id)
  const grep = toolNamed(body, 'Grep')
  if (!(body.tools ?? []).length) return { label: 'auxiliary', events: textEvents('{"title":"Offline probe","shouldBlock":false,"reason":"probe"}') }
  if (st.sub) {
    const t = (text.match(/OFFLINE_PROBE_SUBAGENT ([\w-]+)/) ?? [])[1] ?? (st as any).type ?? 'unknown'
    ;(st as any).type = t
    if (!grep) return { label: `sub-${t}-nogrep`, events: textEvents('Subagent probe finished.') }
    if (!st.outputs.has('probe_subgrep')) return { label: `sub-${t}-grep`, events: callEvents('Grep', { pattern: 'export function', output_mode: 'files_with_matches', head_limit: 5 }, 'probe_subgrep') }
    return { label: `sub-${t}-final`, events: textEvents('Subagent probe finished.') }
  }
  if (!grep && (body.tools ?? []).length === 1) {
    const t = body.tools[0]
    return { label: `structured-${t.name}`, events: callEvents(t.name, fill(t.parameters ?? {}) as Record<string, unknown>, `probe_${t.name}`) }
  }
  if (!grep) return { label: 'other-tools', events: textEvents('ok') }
  if (probeBash && toolNamed(body, 'Bash') && !st.outputs.has('probe_bash')) return { label: 'main-bash', events: callEvents('Bash', { command: probeBash, description: 'Offline probe check' }, 'probe_bash') }
  if (!st.outputs.has('probe_grep')) return { label: 'main-grep', events: callEvents('Grep', { pattern: 'export function', output_mode: 'files_with_matches', head_limit: 5 }, 'probe_grep') }
  const agentTool = toolNamed(body, 'Agent')
  if (agentTool) {
    const types = [...String(agentTool.description ?? '').matchAll(/^- ([a-zA-Z][\w-]*): /gm)].map(m => m[1]!).filter(t => !['Lookups', 'Investigations'].includes(t))
    for (const t of types) {
      const id = `probe_agent_${t}`
      if (!st.outputs.has(id)) return { label: `main-agent-${t}`, events: callEvents('Agent', { description: `Offline probe ${t}`, prompt: `OFFLINE_PROBE_SUBAGENT ${t}: run one search, then reply.`, subagent_type: t }, id) }
    }
  }
  return { label: 'main-final', events: textEvents('Offline probe finished.') }
}

function recordRequest(transport: string, url: string, headers: Record<string, string> | undefined, body: Item) {
  const { label, events } = script(body)
  const n = String(++seq).padStart(3, '0')
  writeFileSync(join(dir, 'requests', `${process.pid}-${n}-${transport}-${label}.json`), JSON.stringify({ url, headers: redact(headers), body }, null, 1))
  log(`${transport} request ${n} ${label} model=${body.model} tools=${(body.tools ?? []).length}`)
  return events
}

class FakeWebSocket extends EventEmitter {
  readyState = 0
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super()
    log(`ws open ${url}`)
    setTimeout(() => {
      this.readyState = 1
      this.emit('upgrade', { headers: {}, statusCode: 101 })
      this.emit('open')
    }, 5)
  }
  send(data: string) {
    const body = JSON.parse(String(data))
    const events = recordRequest('ws', this.url, this.options?.headers, body)
    let delay = 5
    for (const e of events) setTimeout(() => this.emit('message', JSON.stringify(e)), (delay += 2))
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.emit('close', 1000, Buffer.from('')), 1)
  }
  off(event: string, listener: (...a: any[]) => void) { return this.removeListener(event, listener) }
}

if (!noWsFake) {
  const transport = await import(join(engine, 'src/services/api/codex-websocket-transport.ts'))
  transport._setWebSocketFactoryForTest((url: string, options: { headers: Record<string, string> }) => new FakeWebSocket(url, options))
}
log(`interceptor installed wsFake=${!noWsFake}`)
