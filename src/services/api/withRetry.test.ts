import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import * as auth from '../../utils/auth.js'
import * as sleep from '../../utils/sleep.js'
import * as debug from '../../utils/debug.js'
import * as analytics from '../analytics/index.js'
import {
  getActiveClaudeAccount,
  getClaudeCredentialGeneration,
  getClaudePoolStatus,
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  switchToClaudeAccount,
} from './claudeAccountPool.js'

import { LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE } from './errors.js'
import { CannotRetryError, recordClaudeOAuthClientCredential, withRetry } from './withRetry.js'

const retryContext = {
  model: 'claude-sonnet-4-6',
  thinkingConfig: { type: 'disabled' as const },
}
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

function createEntitlementError(): APIError {
  return new APIError(
    429,
    {
      error: {
        type: 'rate_limit_error',
        message: LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE,
      },
    },
    LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE,
    new Headers(),
  )
}

describe('withRetry', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  })

  afterAll(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
    }
  })

  test.each([
    ['bare', () => createEntitlementError()],
    [
      'wrapped',
      () => new CannotRetryError(createEntitlementError(), retryContext),
    ],
  ])('does not retry a %s long-context entitlement refusal', async (_kind, createError) => {
    let attempts = 0
    let thrown: unknown

    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          throw createError()
        },
        {
          maxRetries: 1,
          ...retryContext,
        },
      )) {
        // The refusal is terminal before a retry message can be yielded.
      }
    } catch (error) {
      thrown = error
    }

    expect(attempts).toBe(1)
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(APIError)
  })
})

describe('Claude OAuth retry identity', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    spyOn(sleep, 'sleep').mockResolvedValue(undefined)
    spyOn(debug, 'logForDebugging').mockImplementation(() => {})
    spyOn(analytics, 'logEvent').mockImplementation(() => {})
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
    spyOn(auth, 'isEnterpriseSubscriber').mockReturnValue(false)
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'a',
      accounts: ['a', 'b'].map(id => ({
        accountUuid: id, emailAddress: `${id}@example.com`,
        accessToken: `access-${id}`, refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference'], status: 'healthy' as const,
      })),
    })
  })

  afterEach(() => {
    auth.clearOAuthTokenCache()
    resetClaudeAccountPoolForTest()
    mock.restore()
    if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  })

  function clientForSelectedAccount() {
    const account = getActiveClaudeAccount()!
    const client = { accountUuid: account.accountUuid, accessToken: account.accessToken }
    recordClaudeOAuthClientCredential(client, client)
    return Promise.resolve(client)
  }

  const options = { ...retryContext, maxRetries: 1, isClaudeOAuthRequest: true }
  const unauthorized = () => new APIError(
    401, { error: { type: 'authentication_error', message: 'Unauthorized' } },
    'Unauthorized', new Headers(),
  )

  test('a cached client cannot retry after its credential generation is deleted', async () => {
    const pool = await import('./claudeAccountPool.js')
    let generation: number | null = 0
    spyOn(pool, 'getClaudeCredentialGeneration').mockImplementation(() => generation)
    let attempts = 0
    let clients = 0
    let failure: unknown
    try {
      for await (const _message of withRetry(async () => {
        clients++
        return clientForSelectedAccount()
      }, async () => {
        attempts++
        generation = null
        throw new APIConnectionError({ message: 'synthetic connection failure' })
      }, options)) {}
    } catch (error) {
      failure = error
    }
    expect(attempts).toBe(1)
    expect(clients).toBe(1)
    expect(failure).toBeInstanceOf(CannotRetryError)
    expect((failure as Error).message).toContain('account is no longer available')
  })

  test.each(['transient_failure', 'persistence_pending', 'unavailable'] as const)(
    '%s does not mark an account dead or fail over',
    async status => {
      const recovery = spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status, accountUuid: 'a' })
      let attempts = 0
      let failure: unknown
      try {
        for await (const _message of withRetry(clientForSelectedAccount, async () => {
          if (++attempts === 1) throw unauthorized()
          return 'complete'
        }, options)) {}
      } catch (error) { failure = error }
      expect(recovery).toHaveBeenCalledWith('access-a', 'a', undefined)
      expect(attempts).toBe(1)
      expect(failure).toBeInstanceOf(CannotRetryError)
      expect(getActiveClaudeAccount()?.accountUuid).toBe('a')
      expect(getClaudePoolStatus().accounts.every(account => account.status === 'healthy')).toBe(true)
    },
  )

  test('a delayed rejection recovers the request account, not a newly selected account', async () => {
    const recovery = spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status: 'transient_failure', accountUuid: 'a' })
    let attempts = 0
    let retriedAccount: string | undefined
    for await (const _message of withRetry(clientForSelectedAccount, async client => {
      if (++attempts === 1) {
        switchToClaudeAccount('b', { persistDefault: false })
        throw unauthorized()
      }
      retriedAccount = client.accountUuid
      return 'complete'
    }, options)) {}
    expect(recovery).toHaveBeenCalledWith('access-a', 'a', undefined)
    expect(retriedAccount).toBe('b')
    expect(getClaudePoolStatus().accounts.every(account => account.status === 'healthy')).toBe(true)
  })

  test('x-should-retry:false repairs the failed credential without resending', async () => {
    const recovery = spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status: 'adopted_newer', accountUuid: 'a' })
    const generation = getClaudeCredentialGeneration('a')!
    let attempts = 0
    let failure: unknown
    try {
      for await (const _message of withRetry(async () => {
        const client = await clientForSelectedAccount()
        recordClaudeOAuthClientCredential(client, {
          accessToken: client.accessToken, accountUuid: client.accountUuid,
          credentialGeneration: generation, credentialRevision: 7,
        })
        return client
      }, async () => {
        attempts++
        throw new APIError(401, {}, 'Unauthorized', new Headers({ 'x-should-retry': 'false' }))
      }, options)) {}
    } catch (error) { failure = error }
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(recovery).toHaveBeenCalledWith('access-a', 'a', { accountId: 'a', generation, revision: 7 })
    expect(attempts).toBe(1)
    expect(failure).toBeInstanceOf(CannotRetryError)
  })

  test('a claimed refresh with unchanged credentials never resends', async () => {
    const recovery = spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status: 'refreshed', accountUuid: 'a' })
    let attempts = 0
    try {
      for await (const _message of withRetry(clientForSelectedAccount, async () => {
        attempts++
        throw unauthorized()
      }, { ...options, maxRetries: 5 })) {}
    } catch (error) { expect(error).toBeInstanceOf(CannotRetryError) }
    expect(attempts).toBe(1)
    expect(recovery).toHaveBeenCalledTimes(1)
  })

  test('a changed token cannot resend under the rejected credential revision', async () => {
    const generation = getClaudeCredentialGeneration('a')!
    spyOn(auth, 'recoverOAuth401Error').mockImplementation(async () => {
      getActiveClaudeAccount()!.accessToken = 'changed-without-revision'
      return { status: 'refreshed', accountUuid: 'a' }
    })
    let attempts = 0
    let failure: unknown
    try {
      for await (const _message of withRetry(async () => {
        const client = await clientForSelectedAccount()
        recordClaudeOAuthClientCredential(client, {
          ...client, credentialGeneration: generation, credentialRevision: 7,
        })
        return client
      }, async () => { attempts++; throw unauthorized() }, options)) {}
    } catch (error) { failure = error }
    expect(attempts).toBe(1)
    expect(failure).toBeInstanceOf(CannotRetryError)
  })

  test('cancellation during client construction prevents the operation', async () => {
    const controller = new AbortController()
    let attempts = 0
    try {
      for await (const _message of withRetry(async () => {
        controller.abort()
        return clientForSelectedAccount()
      }, async () => { attempts++; return 'unexpected' }, { ...options, signal: controller.signal })) {}
    } catch (error) { expect(error).toBeInstanceOf(APIUserAbortError) }
    expect(attempts).toBe(0)
  })

  test('cancelling a pending construction stops only its waiter promptly', async () => {
    const controller = new AbortController()
    let finish!: (client: object) => void
    const construction = new Promise<object>(resolve => { finish = resolve })
    let started!: () => void
    const startedConstruction = new Promise<void>(resolve => { started = resolve })
    let attempts = 0
    const iterator = withRetry(() => {
      started()
      return construction
    }, async () => { attempts++; return 'unexpected' }, { ...options, signal: controller.signal })
    const waiting = iterator.next()
    await startedConstruction
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(APIUserAbortError)
    expect(attempts).toBe(0)
    finish({})
    await expect(construction).resolves.toEqual({})
    expect(attempts).toBe(0)
  }, 1000)

  test('cancelling pending repair leaves the shared credential work running', async () => {
    const controller = new AbortController()
    let finish!: (result: auth.ClaudeOAuthRecoveryResult) => void
    const repair = new Promise<auth.ClaudeOAuthRecoveryResult>(resolve => { finish = resolve })
    let started!: () => void
    const startedRepair = new Promise<void>(resolve => { started = resolve })
    spyOn(auth, 'recoverOAuth401Error').mockImplementation(() => { started(); return repair })
    let attempts = 0
    let clients = 0
    const iterator = withRetry(async () => {
      clients++
      return clientForSelectedAccount()
    }, async () => { attempts++; throw unauthorized() }, { ...options, signal: controller.signal })
    const waiting = iterator.next()
    await startedRepair
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(APIUserAbortError)
    finish({ status: 'refreshed', accountUuid: 'a' })
    await expect(repair).resolves.toEqual({ status: 'refreshed', accountUuid: 'a' })
    expect(attempts).toBe(1)
    expect(clients).toBe(1)
  }, 1000)

  test('cancellation during recovery prevents another client and operation', async () => {
    const controller = new AbortController()
    spyOn(auth, 'recoverOAuth401Error').mockImplementation(async () => {
      controller.abort()
      return { status: 'adopted_newer', accountUuid: 'a' }
    })
    let clients = 0
    let attempts = 0
    try {
      for await (const _message of withRetry(async () => {
        clients++
        return clientForSelectedAccount()
      }, async () => { attempts++; throw unauthorized() }, { ...options, signal: controller.signal })) {}
    } catch (error) { expect(error).toBeInstanceOf(APIUserAbortError) }
    expect(clients).toBe(1)
    expect(attempts).toBe(1)
  })

  test('confirmed reauthentication marks only the rejected credential and selects a replacement', async () => {
    spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status: 'reauth_required', accountUuid: 'a' })
    let attempts = 0
    let retriedAccount: string | undefined
    for await (const _message of withRetry(clientForSelectedAccount, async client => {
      if (++attempts === 1) throw unauthorized()
      retriedAccount = client.accountUuid
      return 'complete'
    }, options)) {}
    expect(retriedAccount).toBe('b')
    expect(getClaudePoolStatus().accounts.find(account => account.accountUuid === 'a')?.status).toBe('dead')
    expect(getActiveClaudeAccount()?.accountUuid).toBe('b')
  })

  test('a stale recovery failure cannot poison a replacement credential for the same account', async () => {
    spyOn(auth, 'recoverOAuth401Error').mockImplementation(async () => {
      getActiveClaudeAccount()!.accessToken = 'replacement-a'
      return { status: 'reauth_required', accountUuid: 'a' }
    })
    let attempts = 0
    let retriedToken: string | undefined
    for await (const _message of withRetry(clientForSelectedAccount, async client => {
      if (++attempts === 1) throw unauthorized()
      retriedToken = client.accessToken
      return 'complete'
    }, options)) {}
    expect(retriedToken).toBe('replacement-a')
    expect(getActiveClaudeAccount()?.status).toBe('healthy')
  })

  test('an unbound client cannot infer the active account as its failed credential', async () => {
    const recovery = spyOn(auth, 'recoverOAuth401Error')
    let attempts = 0
    for await (const _message of withRetry(async () => ({}), async () => {
      if (++attempts === 1) throw unauthorized()
      return 'complete'
    }, options)) {}
    expect(recovery).not.toHaveBeenCalled()
    expect(getClaudePoolStatus().accounts.every(account => account.status === 'healthy')).toBe(true)
  })

  test('a confirmed single-account failure stops without borrowing another credential', async () => {
    seedClaudeAccountPoolForTest({
      accounts: [getActiveClaudeAccount()!],
      activeAccountUuid: 'a',
    })
    spyOn(auth, 'recoverOAuth401Error').mockResolvedValue({ status: 'reauth_required', accountUuid: 'a' })
    let attempts = 0
    let failure: unknown
    try {
      for await (const _message of withRetry(clientForSelectedAccount, async () => {
        attempts++
        throw unauthorized()
      }, options)) {}
    } catch (error) {
      failure = error
    }
    expect(attempts).toBe(1)
    expect(failure).toBeInstanceOf(CannotRetryError)
    expect(getActiveClaudeAccount()).toBeNull()
    expect(getClaudePoolStatus().accounts[0]?.status).toBe('dead')
  })
})
