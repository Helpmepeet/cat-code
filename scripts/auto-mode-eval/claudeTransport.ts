import { getAnthropicClient } from '../../src/services/api/client.js'
import { readClaudeAccountAuthority } from '../../src/services/api/claudeAccountAuthority.js'
import { getModelBetas } from '../../src/utils/betas.js'
import { OAUTH_BETA_HEADER } from '../../src/constants/oauth.js'
import { buildSideQueryRequest, type sideQuery } from '../../src/utils/sideQuery.js'

export async function pinnedClaudeTransport(
  accountId: string,
  model: string,
  reserve: () => Promise<void>,
  observeNative: (body: string) => void,
) {
  const authority = readClaudeAccountAuthority(accountId)
  if (authority.status !== 'ready' || !authority.record.credentials) throw new Error('Pinned Claude account unavailable')
  const credentials = authority.record.credentials
  let sendReserved = false
  let backendSends = 0
  const guardedFetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    if (!sendReserved || url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages' ||
        init?.method !== 'POST' || headers.get('authorization') !== `Bearer ${credentials.accessToken}` ||
        typeof init.body !== 'string' || JSON.parse(init.body).model !== model) {
      return Promise.reject(new Error('Claude evaluation send failed its account, model, or endpoint guard'))
    }
    sendReserved = false
    observeNative(init.body)
    backendSends++
    return globalThis.fetch(input, { ...init, redirect: 'error' })
  }, { preconnect: globalThis.fetch.preconnect })
  const client = await getAnthropicClient({
    provider: 'firstParty', pinnedClaudeAccountId: accountId, maxRetries: 0,
    model, fetchOverride: guardedFetch, source: 'side_query',
  })
  const send: typeof sideQuery = async options => {
    if (options.model !== model || options.provider !== 'firstParty' || !options.contextualAutoReview || sendReserved ||
        credentials.expiresAt <= Date.now() + 300_000) throw new Error('Pinned Claude request is outside its authorization')
    options.signal?.throwIfAborted()
    await reserve()
    options.signal?.throwIfAborted()
    sendReserved = true
    try {
      return await client.beta.messages.create({
        ...buildSideQueryRequest(options, 'firstParty'),
        betas: [...new Set([...getModelBetas(model), OAUTH_BETA_HEADER])],
      }, { signal: options.signal })
    } finally {
      sendReserved = false
    }
  }
  return { send, get backendSends() { return backendSends } }
}
