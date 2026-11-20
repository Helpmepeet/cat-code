import Anthropic from '@anthropic-ai/sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { isWithinCodexRefreshSkew } from '../../src/constants/codex-oauth.js'
import { createCodexFetch, requireExactCodexModel } from '../../src/services/api/codex-fetch-adapter.js'
import { getPoolStatus, loadPoolForObservation, type PoolAccount } from '../../src/services/api/codexAccountPool.js'
import { createCodexCredentialHandle } from '../../src/services/api/codexCredentialUse.js'
import { buildSideQueryRequest, type sideQuery } from '../../src/utils/sideQuery.js'

export async function observedAccounts() {
  await loadPoolForObservation()
  const { accounts, activeIndex } = getPoolStatus()
  return accounts.map((account, index) => ({
    reference: createHash('sha256').update(account.accountId).digest('hex').slice(0, 12),
    alias: account.alias ?? null, idPrefix: account.accountId.slice(0, 8), active: index === activeIndex,
    status: account.status, bound: account.credentialGeneration > 0,
    expiresAt: new Date(account.expiresAt).toISOString(),
    usableWithoutRefresh: account.status === 'healthy' && account.credentialGeneration > 0 && !isWithinCodexRefreshSkew(account.expiresAt),
  }))
}

export async function observedAccount(selection: string): Promise<PoolAccount> {
  await loadPoolForObservation()
  const matches = getPoolStatus().accounts.filter(account => account.accountId === selection || account.alias === selection ||
    (selection.length >= 8 && account.accountId.startsWith(selection)))
  if (matches.length !== 1) throw new Error('Select exactly one observed account by exact alias or unambiguous ID prefix')
  return matches[0]!
}

/** Explicit credential binding: no pool resolver, token refresh, SDK retry, or account failover. */
export function pinnedCodexTransport(account: PoolAccount, model: string, maxRequests: number, reserveBackendSend: () => Promise<void>, observeNative?: (body: string) => void) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('A positive authorized reviewer request limit is required')
  if (!model.startsWith('gpt-')) throw new Error('Pinned evaluation transport currently supports GPT models only')
  requireExactCodexModel(model)
  if (account.status !== 'healthy' || account.credentialGeneration <= 0) throw new Error('Selected account is unavailable or requires credential lifecycle migration')
  if (isWithinCodexRefreshSkew(account.expiresAt)) throw new Error('Selected account requires token refresh; this runner will not refresh credentials')
  const handle = createCodexCredentialHandle({ accountId: account.accountId, accessToken: account.accessToken,
    refreshToken: account.refreshToken, expiresAt: account.expiresAt, credentialGeneration: account.credentialGeneration,
    credentialSource: account.source, credentialPath: account.vaultFilePath })
  const originalFetch = globalThis.fetch
  const sendReservation = new AsyncLocalStorage<{ available: boolean }>()
  let backendSends = 0
  const guardedFetch: typeof fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== 'https://chatgpt.com/backend-api/codex/responses') {
      return Promise.reject(new Error('Evaluation blocked an unauthorized network destination'))
    }
    if (new Headers(init?.headers).get('chatgpt-account-id') !== account.accountId) {
      return Promise.reject(new Error('Evaluation blocked an unauthorized account'))
    }
    const reservation = sendReservation.getStore()
    if (!reservation?.available) {
      return Promise.reject(new Error('Evaluation blocked a send without an unused reservation'))
    }
    reservation.available = false
    if (typeof init?.body === 'string') observeNative?.(init.body)
    backendSends++
    // The adapter holds credential-send authority only while invoking this
    // callback. Native fetch must start in the same synchronous call stack.
    return originalFetch(input, { ...init, redirect: 'error' })
  }, { preconnect: originalFetch.preconnect })
  globalThis.fetch = guardedFetch
  const client = new Anthropic({ apiKey: 'codex-adapter', maxRetries: 0, timeout: 240_000,
    fetch: createCodexFetch(handle, randomUUID()) })
  let requestsAttempted = 0
  const failures: { name: string; message: string; code?: string; status?: number; cause?: unknown }[] = []
  const boundedError = (error: unknown, depth = 0): typeof failures[number] => {
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const redact = (text: string) => text.split(handle.accessToken).join('[REDACTED]').split(handle.refreshToken).join('[REDACTED]').slice(0, 300)
    return { name: typeof value.name === 'string' ? redact(value.name) : 'UnknownError',
      message: typeof value.message === 'string' ? redact(value.message) : 'Unknown transport failure',
      ...(typeof value.code === 'string' && { code: redact(value.code) }),
      ...(typeof value.status === 'number' && { status: value.status }),
      ...(value.cause && depth < 2 && { cause: boundedError(value.cause, depth + 1) }) }
  }
  const send: typeof sideQuery = async options => {
    if (options.model !== model || (options.provider !== undefined && options.provider !== 'openai')) throw new Error('Model or provider fallback is outside this evaluation authorization')
    if (isWithinCodexRefreshSkew(handle.expiresAt)) throw new Error('Selected account requires token refresh; stopping without refreshing')
    if (options.skipSystemPromptPrefix !== true) throw new Error('Evaluation expects classifier-owned system instructions')
    if (requestsAttempted >= maxRequests) throw new Error('Authorized reviewer request limit reached')
    requestsAttempted++
    try {
      options.signal?.throwIfAborted()
      const request = buildSideQueryRequest(options, 'openai')
      await reserveBackendSend()
      options.signal?.throwIfAborted()
      const reservation = { available: true }
      try {
        return await sendReservation.run(reservation, async () => client.beta.messages.create(request, { signal: options.signal }))
      } finally {
        reservation.available = false
      }
    } catch (error) {
      failures.push(boundedError(error))
      throw error
    }
  }
  return { send, get requestsAttempted() { return requestsAttempted }, get backendSends() { return backendSends }, failures,
    restoreFetch() { if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch },
    account: { reference: createHash('sha256').update(account.accountId).digest('hex').slice(0, 12),
    alias: account.alias ?? null, idPrefix: account.accountId.slice(0, 8) } }
}
