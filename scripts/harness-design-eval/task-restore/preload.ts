// Transport-only adapter. The engine still assembles prompts, runs tools,
// summarizes, persists, restores, and retries. The key never enters this process.
const endpoint = process.env.TASK_EVAL_GATEWAY!
const capability = process.env.TASK_EVAL_CAPABILITY!
for (const key of ['TASK_EVAL_GATEWAY', 'TASK_EVAL_CAPABILITY', 'BUN_OPTIONS']) delete process.env[key]
const nativeFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.replace(/\/$/, '') === 'https://api.anthropic.com' && (init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200 })
  const target = new URL(url)
  if (target.origin !== 'https://api.anthropic.com' || target.pathname !== '/v1/messages' || !['', '?beta=true'].includes(target.search)) {
    throw Error('Evaluation blocks non-model network traffic')
  }
  // Only protocol-version headers cross; auth/cookies/account identifiers never do.
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : init?.body instanceof ReadableStream ? await new Response(init.body).text() : null
  if (!body) throw Error('Missing evaluation model body')
  return nativeFetch(endpoint, { method: 'POST', signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    headers: { 'content-type': 'application/json', 'x-eval-capability': capability,
      'anthropic-version': headers.get('anthropic-version') ?? '2023-06-01',
      'anthropic-beta': headers.get('anthropic-beta') ?? '', 'x-eval-query': target.search }, body })
}, { preconnect: () => {} }) as typeof fetch
