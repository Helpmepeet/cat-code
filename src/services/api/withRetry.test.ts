import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import { LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE } from './errors.js'
import { CannotRetryError, withRetry } from './withRetry.js'

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
