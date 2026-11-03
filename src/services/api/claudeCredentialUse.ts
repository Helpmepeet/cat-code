import type { ClientOptions } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { withClaudeCredentialGeneration } from './claudeAccountPool.js'
import { readClaudeAccountAuthority, withClaudeCredentialSend, type ClaudeCredentialHandle } from './claudeAccountAuthority.js'
import {
  assertSessionAccountRouteAvailable,
  SessionAccountRouteUnavailableError,
} from './sessionAccountRouting.js'

type ClaudeFetch = NonNullable<ClientOptions['fetch']>

/** Every physical SDK attempt, including its own retries, crosses this boundary. */
export function createClaudeCredentialFetch(
  fetch: ClaudeFetch,
  accountUuid: string,
  credentialGeneration: number,
  credentialRevision?: number,
): ClaudeFetch {
  const authority = readClaudeAccountAuthority(accountUuid)
  const captured: ClaudeCredentialHandle | null = authority.status === 'ready' && authority.handle.generation === credentialGeneration
    ? Object.freeze({ accountId: accountUuid, generation: credentialGeneration, revision: credentialRevision ?? authority.handle.revision })
    : null
  return async (input, init) => {
    assertSessionAccountRouteAvailable('anthropic')
    let initiating = false
    let started: ReturnType<ClaudeFetch> | null = null
    try {
      const initiate = () => {
        initiating = true
        started = fetch(input, init)
        return started
      }
      if (captured) withClaudeCredentialSend(captured, initiate)
      else if (authority.status === 'missing') withClaudeCredentialGeneration(accountUuid, credentialGeneration, initiate)
    } catch (error) {
      if (started !== null) {
        // Retrying a request because unlock failed would repeat a send that
        // already crossed the authorization boundary.
        logForDebugging(`Claude credential lock cleanup failed after send: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
        return started
      }
      if (initiating) throw error
      throw new SessionAccountRouteUnavailableError(
        'The saved Claude account could not be verified. Check storage access and try again.',
        { cause: error },
      )
    }
    if (started === null) {
      throw new SessionAccountRouteUnavailableError(
        "This chat's Claude account is no longer available. Open Accounts and select an account to continue.",
      )
    }
    return started
  }
}
