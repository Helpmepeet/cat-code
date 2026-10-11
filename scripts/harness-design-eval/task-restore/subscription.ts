import { randomUUID } from 'node:crypto'
import { policy, sha } from './policy.js'

export const subscriptionPolicy = {
  model: 'gpt-6.1-sol', effort: 'low', maxRunMs: 1200000, maxSuiteMs: 5040000,
  maxRequestsPerRun: 64, maxRequestsPerSuite: 256,
  maxInputPerRun: 8000000, maxInputPerSuite: 32000000,
  schedule: [
    { caseId: 'task-resume', repeat: 1, arm: 'off' },
    { caseId: 'task-resume', repeat: 1, arm: 'on' },
    { caseId: 'task-resume', repeat: 2, arm: 'on' },
    { caseId: 'task-resume', repeat: 2, arm: 'off' },
  ],
  authorization: 'User explicitly authorized existing Cat Code subscription, normal account/token refresh, and a higher-limit rerun on 2026-10-11. No paid API project, installation, GUI launch or push.',
  transport: 'Production Codex subscription HTTP SSE, production translation and credential-send lifecycle; parent holds credentials. Fresh stateless provider request per call.',
  inputAdmission: 'Reserve serialized UTF-8 bytes plus 4096 before dispatch; after a complete provider response reconcile to its actual inclusive input token count. Unknown/failed requests retain the full reservation. This estimate is not tokenizer measurement.',
  outputLimit: '4096 SDK max_tokens; production subscription translator does not forward this field. Request count and wall-time limits enforced; actual output observed after completion.',
} as const

export function subscriptionUsage(records: any[]) {
  const requests = records.filter(r => r.kind === 'request')
  let input = 0, cached = 0, output = 0, reasoning = 0, unknownAttempts = 0
  for (const request of requests) {
    const response = records.find(r => r.kind === 'provider-response' && r.attempt === request.attempt)
    const u = response?.usage
    if (response?.status !== 200 || !response.completed || !u ||
      ![u.input_tokens, u.output_tokens, u.input_tokens_details?.cached_tokens ?? 0, u.output_tokens_details?.reasoning_tokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) {
      unknownAttempts++; continue
    }
    input += u.input_tokens; cached += u.input_tokens_details?.cached_tokens ?? 0
    output += u.output_tokens; reasoning += u.output_tokens_details?.reasoning_tokens ?? 0
  }
  return { input, cached, output, reasoning, unknownAttempts, attempts: requests.length,
    inputIncludesCached: true, outputIncludesReasoning: true }
}

export async function subscriptionGateway(engine: string, options: { save: (record: any) => void; suite: { input: number; requests: number }; conversationId: string }) {
  // Load inventory without startup polling or background refresh of unrelated
  // accounts. The production resolver refreshes the selected account on use.
  const { enableConfigs } = await import(`${engine}/src/utils/config.ts`)
  enableConfigs()
  const { loadPoolForObservation } = await import(`${engine}/src/services/api/codexAccountPool.ts`)
  const { resolveCodexOAuthTokensForLeaseOwner } = await import(`${engine}/src/services/api/client.ts`)
  const { translateToCodexBody, translateCodexStreamToAnthropic } = await import(`${engine}/src/services/api/codex-fetch-adapter.ts`)
  const { startCodexCredentialSend } = await import(`${engine}/src/services/api/codexCredentialUse.ts`)
  await loadPoolForObservation()
  let phase = 'startup', calls = 0, inputEstimate = 0, stopped: string | null = null, busy = false
  const cancel = new AbortController(), capability = randomUUID(), pending: Promise<any>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/messages' || req.headers.get('x-eval-capability') !== capability) return new Response('denied', { status: 403 })
      const body: any = await req.json()
      let codexBody: any, estimate: number
      try {
        if (stopped || busy) throw Error(stopped ?? 'Concurrent request denied')
        if (body.model !== subscriptionPolicy.model || body.speed === 'fast' || body.max_tokens > policy.maxOutputPerRequest) throw Error('Model/tier/output configuration drift')
        estimate = Buffer.byteLength(JSON.stringify(body)) + 4096
        if (calls >= subscriptionPolicy.maxRequestsPerRun || options.suite.requests >= subscriptionPolicy.maxRequestsPerSuite || inputEstimate + estimate > subscriptionPolicy.maxInputPerRun || options.suite.input + estimate > subscriptionPolicy.maxInputPerSuite) throw Error('Request/workload admission cap')
        codexBody = translateToCodexBody(body).codexBody
        codexBody.reasoning = { ...codexBody.reasoning, effort: 'low' }
        codexBody.prompt_cache_key = options.conversationId
        if (codexBody.tools?.some((t: any) => !['function', 'custom'].includes(t.type)) || codexBody.previous_response_id || codexBody.service_tier) throw Error('Unsupported hosted tool/continuation/tier')
      } catch (error) {
        stopped = String(error); options.save({ kind: 'blocked', phase, reason: stopped, toolTypes: codexBody?.tools?.map((t: any) => ({ type: t.type, name: t.name })) })
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: stopped } }), { status: 400 })
      }
      busy = true
      const attempt = ++calls, started = Date.now()
      inputEstimate += estimate!; options.suite.input += estimate!; options.suite.requests++
      options.save({ kind: 'request', attempt, phase, body, providerBody: codexBody, mocked: false, started,
        effective: { model: codexBody.model, effort: codexBody.reasoning.effort, transport: 'subscription-http', inputEstimate: estimate,
          toolSchemaSha256: sha(JSON.stringify(codexBody.tools)), messagesSha256: sha(JSON.stringify(codexBody.input)) } })
      try {
        const credential = await resolveCodexOAuthTokensForLeaseOwner({})
        if (!credential) throw Error('No healthy Cat Code subscription credential')
        const response: Response = await startCodexCredentialSend(credential, (authorized: any) => fetch('https://chatgpt.com/backend-api/codex/responses', {
          method: 'POST', signal: AbortSignal.any([req.signal, cancel.signal, AbortSignal.timeout(subscriptionPolicy.maxRunMs)]),
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', Authorization: `Bearer ${authorized.accessToken}`,
            'chatgpt-account-id': authorized.accountId, originator: 'codex_cli_rs',
            'conversation-id': options.conversationId, session_id: options.conversationId,
            'x-client-request-id': options.conversationId, 'OpenAI-Beta': 'responses=experimental' },
          body: JSON.stringify(codexBody),
        }))
        const [agent, recorder] = response.body!.tee()
        pending.push(new Response(recorder).text().then(text => {
          let usage: any, completed = false, model: string | undefined
          for (const line of text.split('\n')) if (line.startsWith('data: ')) {
            try { const e = JSON.parse(line.slice(6)); if (e.type === 'response.completed') { usage = e.response?.usage; model = e.response?.model; completed = true } } catch {}
          }
          options.save({ kind: 'provider-response', attempt, phase, status: response.status, elapsedMs: Date.now() - started,
            providerRequestId: response.headers.get('x-request-id'), completed, model, usage, text, mocked: false })
          if (!completed || !usage) stopped = 'Incomplete provider usage/response'
          else if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || usage.input_tokens > estimate!) stopped = 'Input reservation underestimated or usage invalid'
          else {
            // Reconcile only a complete, measured request. Failed/unknown
            // requests retain their full pessimistic reservation.
            inputEstimate -= estimate! - usage.input_tokens
            options.suite.input -= estimate! - usage.input_tokens
          }
          if (model && model !== subscriptionPolicy.model) stopped = 'Provider model drift'
          busy = false
        }, error => { busy = false; stopped = 'Incomplete provider stream'; options.save({ kind: 'failure', attempt, phase, error: String(error), usageUnknown: true }) }))
        const raw = new Response(agent, { status: response.status, headers: response.headers })
        return response.ok ? await translateCodexStreamToAnthropic(raw, subscriptionPolicy.model) : raw
      } catch (error) {
        busy = false; stopped = 'Subscription transport/credential failure'
        options.save({ kind: 'failure', attempt, phase, error: String(error), usageUnknown: true })
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: stopped } }), { status: 502 })
      }
    },
  })
  return { port: server.port!, endpoint: `http://127.0.0.1:${server.port}/messages`, capability,
    setPhase: (next: string) => { phase = next }, stats: () => ({ requests: calls, inputEstimate, stopped }),
    drain: () => Promise.allSettled(pending), stop: () => { cancel.abort(); server.stop(true) } }
}
