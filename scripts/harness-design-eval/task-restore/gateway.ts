import { randomUUID } from 'node:crypto'
import { budgetAllows, policy, reservation, sha, type Prices } from './policy.js'
// Scripted transport smoke only. Its outputs deliberately do not depend on arm.
const repairCommand = `cat > src/invoice.ts <<'EOF'
export function total(lines: {price:number;quantity:number}[]): number { return Math.round(lines.reduce((s,l) => s + l.price * l.quantity, 0) * 100) / 100 }
EOF
cat > src/export.ts <<'EOF'
export function csv(rows: string[][]): string { return rows.map(row => row.map(s => /[,"\\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s).join(',')).join('\\n') }
EOF
cat > README.md <<'EOF'
# Invoice export
Round the final sum to cents. Quote CSV fields containing comma, quote or newline; double embedded quotes.
EOF
bun check.ts`
const reviewCommand = `cat > REVIEW.md <<'EOF'
Floating point totals need rounding to cents. CSV needs quoting and escaping for commas, quotes and newlines.
EOF`
function sse(body: any, content: any[]) {
  const id = `msg_${randomUUID()}`
  const events: any[] = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }]
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    events.push({ type: 'content_block_start', index: i, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: i, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: i })
  }
  events.push({ type: 'message_delta', delta: { stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' })
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
export function gateway(options: {live: boolean; key?: string; prices?: Prices; redirect: boolean; suite: {usd: number}; save: (record: any) => void}) {
  let phase = 'startup', calls = 0, sentRepair = false
  let used = { requests: 0, input: 0, usd: 0 }
  let stopped: string | null = null
  const cancel = new AbortController()
  const capability = randomUUID()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/messages' || req.headers.get('x-eval-capability') !== capability) return new Response('denied', { status: 403 })
      const body = await req.json()
      let reserved: ReturnType<typeof reservation>
      try {
        if (stopped) throw Error(stopped)
        reserved = reservation(body, options.prices)
        if (!budgetAllows(used, reserved) || options.suite.usd + (reserved.usd ?? 0) > policy.maxUsdSuite) throw Error('Admission budget exhausted')
      } catch (error) {
        stopped = String(error)
        options.save({ kind: 'blocked', phase, reason: stopped })
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: stopped } }), { status: 400 })
      }
      used = { requests: used.requests + 1, input: used.input + reserved.input, usd: used.usd + (reserved.usd ?? 0) }
      options.suite.usd += reserved.usd ?? 0
      const attempt = ++calls, started = Date.now()
      options.save({ kind: 'request', attempt, phase, body, reserved, mocked: !options.live, started,
        effective: { model: body.model, outputReservation: body.max_tokens, effort: body.output_config?.effort ?? null,
          toolSchemaSha256: sha(JSON.stringify(body.tools ?? [])), systemPromptSha256: sha(JSON.stringify(body.system ?? [])),
          messagesSha256: sha(JSON.stringify(body.messages ?? [])) } })
      let response: Response
      try {
        if (options.live) {
          response = await fetch('https://api.anthropic.com/v1/messages' + (req.headers.get('x-eval-query') === '?beta=true' ? '?beta=true' : ''), { method: 'POST', signal: AbortSignal.any([req.signal, cancel.signal, AbortSignal.timeout(policy.maxRunMs)]),
            headers: { 'content-type': 'application/json', 'x-api-key': options.key!, 'anthropic-version': req.headers.get('anthropic-version')!,
              ...(req.headers.get('anthropic-beta') ? { 'anthropic-beta': req.headers.get('anthropic-beta')! } : {}) }, body: JSON.stringify(body) })
        } else {
          let content: any[]
          if (phase === 'compact') content = [{ type: 'text', text: options.redirect ? 'The repair was cancelled. Preserve all existing files. Inspect source and write only REVIEW.md explaining decimal rounding and CSV escaping defects.' : 'Invoice export repair remains unfinished: round final totals to cents, including fractional quantities. Quote CSV commas, quotes and newlines, double embedded quotes, preserve row order. Document both rules in README.md, run bun check.ts and fix failures. Preserve archive/ledger.csv. No source changes were made.' }]
          else if (!sentRepair && phase === 'work') {
            sentRepair = true
            content = [{ type: 'tool_use', id: 'offline_repair', name: 'Bash', input: { command: options.redirect ? reviewCommand : repairCommand, description: 'Scripted infrastructure fixture action' } }]
          } else content = [{ type: 'text', text: 'Scripted transport finished.' }]
          response = new Response(sse(body, content), { headers: { 'content-type': 'text/event-stream', 'request-id': `offline-${attempt}` } })
        }
      } catch (error) {
        options.save({ kind: 'failure', attempt, phase, elapsedMs: Date.now() - started, error: String(error), usageUnknown: true })
        stopped = 'Transport failure: unknown billable usage; stop suite'
        throw error
      }
      // Tee only once, without buffering or changing provider stream semantics.
      const [agent, recorder] = response.body!.tee()
      void new Response(recorder).text().then(text => options.save({ kind: 'response', attempt, phase, status: response.status, providerRequestId: response.headers.get('request-id'), elapsedMs: Date.now() - started, text, mocked: !options.live }), error => {
        stopped = 'Incomplete response accounting'
        options.save({ kind: 'failure', attempt, phase, error: String(error), usageUnknown: true })
      })
      return new Response(agent, { status: response.status, headers: response.headers })
    },
  })
  return { port: server.port!, endpoint: `http://127.0.0.1:${server.port}/messages`, capability,
    setPhase: (next: string) => { phase = next }, stats: () => ({ ...used, stopped }), stop: () => { cancel.abort(); server.stop(true) } }
}
