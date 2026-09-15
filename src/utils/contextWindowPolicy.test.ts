import { APIError } from '@anthropic-ai/sdk'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import { getMaxOutputTokensForModel } from '../services/api/claude.js'
import { getAssistantMessageFromError } from '../services/api/errors.js'
import {
  getAutoCompactThreshold,
  getBlockingLimit,
  getEffectiveContextWindowSize,
  shouldAutoCompact,
} from '../services/compact/autoCompact.js'
import type { Message } from '../types/message.js'
import {
  _resetLongContextEntitlementForTest,
  getContextWindowForModel,
  isLongContextEntitlementRefused,
  noteLongContextEntitlementRefused,
} from './context.js'
import { saveGlobalConfig } from './config.js'
import {
  formatContextWindowProvenance,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  resolveContextWindowPolicy,
} from './contextWindowPolicy.js'

const ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE',
] as const

const envSnapshot = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot.set(key, process.env[key])
    delete process.env[key]
  }
  _resetLongContextEntitlementForTest()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  envSnapshot.clear()
  _resetLongContextEntitlementForTest()
})

const MODELS = [
  'some-unknown-model',
  'claude-sonnet-4-6',
  'claude-opus-4-1',
  'gpt-5.1-codex',
  'gpt-5.6-luna',
  'claude-sonnet-5',
  'claude-sonnet-4-6 [1m]',
]

/**
 * The formula getEffectiveContextWindowSize used before the four windows were
 * split apart, spelled out here so the equivalence test cannot drift with the
 * implementation it is checking.
 */
function legacyEffectiveWindow(model: string): number {
  let contextWindow = getContextWindowForModel(model)
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }
  return (
    contextWindow -
    Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  )
}

describe('context window policy: no behavior change for a healthy account', () => {
  test('effective window matches the pre-split formula in every env combination', () => {
    const combinations: Record<string, string>[] = [
      {},
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true' },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' },
      {
        CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      },
      // Ignored: below the parse guard, so it must not clamp anything.
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'not-a-number' },
    ]

    for (const combination of combinations) {
      for (const key of ENV_KEYS) {
        delete process.env[key]
      }
      Object.assign(process.env, combination)
      for (const model of MODELS) {
        expect({
          model,
          combination,
          effective: getEffectiveContextWindowSize(model),
        }).toEqual({
          model,
          combination,
          effective: legacyEffectiveWindow(model),
        })
      }
    }
  })

  test('the derived threshold table is unchanged', () => {
    // Report 2026-08-09 section 4.3, recomputed from source. A shift in any of
    // these under normal conditions is a regression, not an improvement.
    const expected: Record<
      string,
      { effective: number; autocompact: number; blocking: number }
    > = {
      'some-unknown-model': {
        effective: 180_000,
        autocompact: 162_600,
        blocking: 177_000,
      },
      'gpt-5.1-codex': {
        effective: 252_000,
        autocompact: 228_840,
        blocking: 249_000,
      },
      'gpt-5.6-luna': {
        effective: 352_000,
        autocompact: 320_840,
        blocking: 349_000,
      },
      'claude-sonnet-5': {
        effective: 980_000,
        autocompact: 927_000,
        blocking: 977_000,
      },
    }

    for (const [model, row] of Object.entries(expected)) {
      expect({
        model,
        effective: getEffectiveContextWindowSize(model),
        autocompact: getAutoCompactThreshold(model),
        blocking: getBlockingLimit(model),
      }).toEqual({ model, ...row })
    }
  })

  test('a healthy 1M session reports only the output reservation', () => {
    const policy = resolveContextWindowPolicy('claude-sonnet-5')

    expect(policy.native).toBe(1_000_000)
    expect(policy.nativeSource).toBe('frontier_1m_default')
    expect(policy.entitled).toBe(1_000_000)
    expect(policy.configured).toBe(1_000_000)
    expect(policy.effective).toBe(980_000)
    expect(policy.clamps.map(clamp => clamp.reason)).toEqual([
      'output_reservation',
    ])
  })
})

describe('context window policy: provenance for each clamp', () => {
  test('the compliance kill switch is reported, not folded into the model', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = 'true'
    const policy = resolveContextWindowPolicy('claude-sonnet-5')

    // The model still advertises 1M. What narrowed it is now nameable.
    expect(policy.native).toBe(1_000_000)
    expect(policy.configured).toBe(200_000)
    expect(policy.effective).toBe(180_000)
    expect(policy.clamps).toEqual([
      { reason: 'disable_1m_context', from: 1_000_000, to: 200_000 },
      { reason: 'output_reservation', from: 200_000, to: 180_000 },
    ])
  })

  test('an operator compaction window is its own step', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '150000'
    const policy = resolveContextWindowPolicy('claude-sonnet-5')

    expect(policy.entitled).toBe(1_000_000)
    expect(policy.configured).toBe(150_000)
    expect(policy.effective).toBe(130_000)
    expect(policy.clamps).toEqual([
      { reason: 'auto_compact_window', from: 1_000_000, to: 150_000 },
      { reason: 'output_reservation', from: 150_000, to: 130_000 },
    ])
  })

  test('provenance renders every step for the debug log', () => {
    noteLongContextEntitlementRefused()
    expect(
      formatContextWindowProvenance(
        resolveContextWindowPolicy('claude-sonnet-5'),
      ),
    ).toBe(
      'native=1000000(frontier_1m_default) long_context_entitlement=1000000->200000 output_reservation=200000->180000',
    )
  })
})

describe('long-context entitlement clamp', () => {
  test('a refusal narrows the nominal and effective windows', () => {
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)

    noteLongContextEntitlementRefused()

    const policy = resolveContextWindowPolicy('claude-sonnet-5')
    expect(policy.native).toBe(1_000_000)
    expect(policy.entitled).toBe(200_000)
    expect(policy.effective).toBe(180_000)
    expect(policy.clamps[0]).toEqual({
      reason: 'long_context_entitlement',
      from: 1_000_000,
      to: 200_000,
    })
    // The statusline/cost-tracker denominator narrows with it, so the gauge and
    // the compaction budget cannot disagree.
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(200_000)
  })

  test('the derived compaction thresholds move with it', () => {
    noteLongContextEntitlementRefused()

    expect(getAutoCompactThreshold('claude-sonnet-5')).toBe(162_600)
    expect(getBlockingLimit('claude-sonnet-5')).toBe(177_000)
  })

  test('an Anthropic entitlement refusal never narrows a Codex window', () => {
    noteLongContextEntitlementRefused()

    expect(getContextWindowForModel('gpt-5.6-luna')).toBe(372_000)
    expect(getEffectiveContextWindowSize('gpt-5.6-luna')).toBe(352_000)
    expect(getAutoCompactThreshold('gpt-5.6-luna')).toBe(320_840)
    expect(
      resolveContextWindowPolicy('gpt-5.6-luna').clamps.map(c => c.reason),
    ).toEqual(['output_reservation'])
  })

  test('an Anthropic entitlement refusal never narrows Astra', () => {
    noteLongContextEntitlementRefused()

    expect(getContextWindowForModel('gpt-6-astra')).toBe(1_050_000)
    expect(getEffectiveContextWindowSize('gpt-6-astra')).toBe(1_030_000)
    expect(
      resolveContextWindowPolicy('gpt-6-astra').clamps.map(c => c.reason),
    ).toEqual(['output_reservation'])
  })

  test('a different active Claude account regains its full window', () => {
    saveGlobalConfig(current => ({
      ...current,
      activeClaudeAccountUuid: 'account-a',
    }))
    noteLongContextEntitlementRefused()
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(200_000)

    saveGlobalConfig(current => ({
      ...current,
      activeClaudeAccountUuid: 'account-b',
    }))
    expect(isLongContextEntitlementRefused()).toBe(false)
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
  })

  test('models already at or below the cap are untouched', () => {
    noteLongContextEntitlementRefused()

    expect(getEffectiveContextWindowSize('claude-sonnet-4-6')).toBe(180_000)
    expect(
      resolveContextWindowPolicy('claude-sonnet-4-6').clamps.map(c => c.reason),
    ).toEqual(['output_reservation'])
  })

  test('the narrowed budget is what autocompact actually decides on', async () => {
    const MODEL = 'claude-sonnet-5'
    // Comfortably inside a 1M budget, far past a 200K one. This is the decision
    // that routes into reactive prefix compaction (autoCompact.ts
    // tryReactivePrefixCompaction), so a clamp that did not reach here would be
    // a number nothing spends.
    const messages: Message[] = [
      {
        type: 'assistant',
        uuid: 'anchor',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          id: 'anchor',
          model: MODEL,
          role: 'assistant',
          content: [{ type: 'text', text: 'anchor' }],
          usage: {
            input_tokens: 300_000,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as unknown as Message,
    ]

    expect(await shouldAutoCompact(messages, MODEL)).toBe(false)

    noteLongContextEntitlementRefused()

    expect(await shouldAutoCompact(messages, MODEL)).toBe(true)
  })
})

/**
 * These drive the real classifier, so they inherit its auth reads:
 * `isClaudeAISubscriber` sits first in the `&&` chain at errors.ts:826, and
 * under `NODE_ENV=test` with no credentials `getAnthropicApiKeyWithSource`
 * throws by design (auth.ts:284-302) rather than returning "no key". A
 * placeholder key is the repo's existing answer to that (see
 * services/api/deferredTerminalFailure.test.ts). It only decides which
 * user-facing wording the classifier picks; the latch below the message
 * branches is deliberately auth-independent, which is what these tests pin.
 */
const originalApiKey = process.env.ANTHROPIC_API_KEY

describe('long-context entitlement latch: live error path', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-placeholder'
  })

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })

  test('the real error classifier latches the refusal', () => {
    expect(isLongContextEntitlementRefused()).toBe(false)

    const message = getAssistantMessageFromError(
      new Error(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}',
      ),
      'claude-sonnet-5',
    )

    expect(isLongContextEntitlementRefused()).toBe(true)
    expect(message.isApiErrorMessage).toBe(true)
    expect(getEffectiveContextWindowSize('claude-sonnet-5')).toBe(180_000)
  })

  test('the shape the provider actually sends latches it too', () => {
    // The refusal arrives as an SDK APIError, not a bare Error, and the
    // classifier reaches the latch before any of the 429 message branches,
    // which are gated on subscriber status. Latching only on the branch a
    // subscriber sees would leave API-key sessions retrying into the wall.
    const message = getAssistantMessageFromError(
      new APIError(
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Extra usage is required for long context requests.',
          },
        },
        '429 Extra usage is required for long context requests.',
        new Headers(),
      ),
      'claude-sonnet-5',
    )

    expect(isLongContextEntitlementRefused()).toBe(true)
    expect(message.isApiErrorMessage).toBe(true)
    expect(getEffectiveContextWindowSize('claude-sonnet-5')).toBe(180_000)
  })

  test('an unrelated API error does not latch', () => {
    getAssistantMessageFromError(
      new Error(
        '429 {"error":{"message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      ),
      'claude-sonnet-5',
    )

    expect(isLongContextEntitlementRefused()).toBe(false)
    expect(getEffectiveContextWindowSize('claude-sonnet-5')).toBe(980_000)
  })
})
