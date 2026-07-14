import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getCodexLeaseExhaustedMessage } from './codexAccountLeaseManager.js'
import { getAssistantMessageFromError } from './errors.js'
import type { DeferredTerminalFailureV1 } from '../../types/message.js'

const NOW = 1_700_000_000_000
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-placeholder'
})

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
})

function envelope(
  code: DeferredTerminalFailureV1['code'],
): DeferredTerminalFailureV1 {
  return { version: 1, provider: 'openai', code, observedAt: NOW }
}

describe('deferred terminal failure transcript envelope', () => {
  test.each([
    'quota_exhausted',
    'ambiguous_rate_limit',
    'account_recovery',
    'transient_network',
  ] as const)('round-trips the typed %s outcome without raw evidence', code => {
    const message = getAssistantMessageFromError(new Error('sanitized'), 'gpt-test', {
      deferredTerminalFailure: envelope(code),
    })
    const restored = JSON.parse(JSON.stringify(message))
    expect(restored.deferredTerminalFailure).toEqual(envelope(code))
    expect(restored.deferredTerminalFailure).not.toHaveProperty('error')
    expect(restored.deferredTerminalFailure).not.toHaveProperty('account')
  })

  test('shows the continuation command hint only for typed quota exhaustion', () => {
    const error = new Error(getCodexLeaseExhaustedMessage())
    const quota = getAssistantMessageFromError(error, 'gpt-test', {
      deferredTerminalFailure: envelope('quota_exhausted'),
    })
    const ambiguous = getAssistantMessageFromError(error, 'gpt-test', {
      deferredTerminalFailure: envelope('ambiguous_rate_limit'),
    })
    const quotaText = JSON.stringify(quota.message.content)
    const ambiguousText = JSON.stringify(ambiguous.message.content)
    expect(quotaText).toContain('/continue-after-limit')
    expect(ambiguousText).not.toContain('/continue-after-limit')
  })
})
