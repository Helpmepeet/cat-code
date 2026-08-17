import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetToolSchemaTokensMemoForTest,
  calculateTokenWarningState,
  getAutoCompactRecoveryWindowTokens,
  getAutoCompactThreshold,
  getBlockingLimit,
  getEffectiveContextWindowSize,
  GPT_5_6_SOL_AUTOCOMPACT_THRESHOLD,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
  measureNonMessageOverheadTokens,
  shouldAutoCompact,
} from './autoCompact.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getEmptyToolPermissionContext, type Tool } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { NON_MESSAGE_REQUEST_OVERHEAD_TOKENS } from '../../utils/tokens.js'

const tokenWarningSource = await Bun.file(
  new URL('../../components/TokenWarning.tsx', import.meta.url),
).text()

const ENV_KEYS = [
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'DISABLE_AUTO_COMPACT',
] as const

const envSnapshot = new Map<string, string | undefined>()

test('TokenWarning uses the reactive compaction runtime predicate', () => {
  expect(tokenWarningSource).toContain('isReactiveCompactEnabled()')
  expect(tokenWarningSource).not.toContain(
    'getFeatureValue_CACHED_MAY_BE_STALE("tengu_cobalt_raccoon"',
  )
})

describe('autoCompact thresholds', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envSnapshot.set(key, process.env[key])
      delete process.env[key]
    }
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
  })

  test('recovery window grows for larger-context models', () => {
    const sonnetRecoveryWindow =
      (getEffectiveContextWindowSize('claude-sonnet-4-6') -
        MANUAL_COMPACT_BUFFER_TOKENS) -
      getAutoCompactThreshold('claude-sonnet-4-6')
    const gptRecoveryWindow =
      (getEffectiveContextWindowSize('gpt-5.6-luna') -
        MANUAL_COMPACT_BUFFER_TOKENS) -
      getAutoCompactThreshold('gpt-5.6-luna')
    const sonnet1mRecoveryWindow =
      (getEffectiveContextWindowSize('claude-sonnet-4-6 [1m]') -
        MANUAL_COMPACT_BUFFER_TOKENS) -
      getAutoCompactThreshold('claude-sonnet-4-6 [1m]')

    expect(gptRecoveryWindow).toBeGreaterThan(sonnetRecoveryWindow)
    expect(sonnet1mRecoveryWindow).toBeGreaterThan(gptRecoveryWindow)
  })

  test('recovery window uses scaled values with floor and cap', () => {
    expect(getAutoCompactRecoveryWindowTokens('claude-sonnet-4-6')).toBe(14_400)
    expect(getAutoCompactRecoveryWindowTokens('gpt-5.6-luna')).toBe(28_160)
    expect(getAutoCompactRecoveryWindowTokens('claude-sonnet-4-6 [1m]')).toBe(
      50_000,
    )
  })

  test('blocking limit stays tied to effective context window minus manual buffer', () => {
    expect(getBlockingLimit('claude-sonnet-4-6')).toBe(
      getEffectiveContextWindowSize('claude-sonnet-4-6') -
        MANUAL_COMPACT_BUFFER_TOKENS,
    )
    expect(getBlockingLimit('gpt-5.6-luna')).toBe(
      getEffectiveContextWindowSize('gpt-5.6-luna') -
        MANUAL_COMPACT_BUFFER_TOKENS,
    )
    expect(getBlockingLimit('claude-sonnet-4-6 [1m]')).toBe(
      getEffectiveContextWindowSize('claude-sonnet-4-6 [1m]') -
        MANUAL_COMPACT_BUFFER_TOKENS,
    )
  })

  test('uses the default 1M window for every Claude 5 frontier model', () => {
    for (const model of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
    ]) {
      expect(getContextWindowForModel(model)).toBe(1_000_000)
      // StatusLine uses this same effective window as its percentage denominator.
      expect(getEffectiveContextWindowSize(model)).toBe(980_000)
      expect(getAutoCompactThreshold(model)).toBe(927_000)
      expect(getBlockingLimit(model)).toBe(977_000)
    }
  })

  test('respects the compliance 1M disablement for Claude 5 models', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = 'true'
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(200_000)
  })

  test('gives GPT-5.6 Sol a 1M window and Codex’s 900k compaction limit', () => {
    expect(getContextWindowForModel('gpt-5.6-sol')).toBe(1_000_000)
    expect(getEffectiveContextWindowSize('gpt-5.6-sol')).toBe(980_000)
    // The buffer math alone would land on 927,000 here, exactly as it does for
    // the Claude 5 models above. Sol stops earlier because Codex publishes its
    // own limit for this model.
    expect(getAutoCompactThreshold('gpt-5.6-sol')).toBe(
      GPT_5_6_SOL_AUTOCOMPACT_THRESHOLD,
    )
    expect(getAutoCompactThreshold('gpt-5.6-sol')).toBe(900_000)
  })

  test('leaves the other GPT-5.6 Codex models on their 372k window', () => {
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getContextWindowForModel(model)).toBe(372_000)
      expect(getEffectiveContextWindowSize(model)).toBe(352_000)
      // 352,000 - (3,000 + min(50,000, floor(352,000 * 0.08))) = 320,840
      expect(getAutoCompactThreshold(model)).toBe(320_840)
    }
  })

  test('never lets the Sol limit sit above a narrowed window', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '400000'
    const effective = getEffectiveContextWindowSize('gpt-5.6-sol')
    expect(effective).toBe(380_000)
    const threshold = getAutoCompactThreshold('gpt-5.6-sol')
    // The 900k ceiling is inert here: a threshold above the window the session
    // can spend would simply never fire.
    expect(threshold).toBeLessThan(effective)
    expect(threshold).toBe(346_600)
  })

  test('keeps the percentage override able to lower the Sol threshold', () => {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
    expect(getAutoCompactThreshold('gpt-5.6-sol')).toBe(490_000)
  })

  test('does not let the percentage override raise the Sol threshold', () => {
    // 99% of the 980,000 effective window is 970,200, above Codex's limit.
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '99'
    expect(getAutoCompactThreshold('gpt-5.6-sol')).toBe(900_000)
  })

  // getModelAutoCompactCeiling keys on canonical identity precisely so a dated
  // or provider-prefixed id is not a different model to the budget.
  test('applies the Sol limit to a non-canonical Sol id', () => {
    expect(getAutoCompactThreshold('gpt-5.6-sol-20260101')).toBe(900_000)
  })

  test('confines the Sol limit to Sol', () => {
    for (const model of [
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-4-6',
    ]) {
      expect(getAutoCompactThreshold(model)).not.toBe(
        GPT_5_6_SOL_AUTOCOMPACT_THRESHOLD,
      )
    }
  })

  test('still honours DISABLE_AUTO_COMPACT for Sol above 900k', () => {
    // 950,000 is past Sol's threshold, so this fires unless something disables
    // it. Baselined against the real setting rather than assumed true: whether
    // auto-compact is on at all is the machine's config, not this test's.
    const enabledByConfig = isAutoCompactEnabled()
    expect(
      calculateTokenWarningState(950_000, 'gpt-5.6-sol')
        .isAboveAutoCompactThreshold,
    ).toBe(enabledByConfig)

    process.env.DISABLE_AUTO_COMPACT = '1'
    expect(isAutoCompactEnabled()).toBe(false)
    expect(
      calculateTokenWarningState(950_000, 'gpt-5.6-sol')
        .isAboveAutoCompactThreshold,
    ).toBe(false)
  })
})

describe('shouldAutoCompact pre-request savings', () => {
  const MODEL = 'claude-sonnet-4-6'

  // Snip and time-based microcompact shrink the request array only; the
  // anchor shouldAutoCompact reads still carries the pre-shrink usage.
  function anchoredAt(inputTokens: number): Message[] {
    return [
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
            input_tokens: inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as unknown as Message,
    ]
  }

  test('subtracts the pre-request freed tokens from the stale anchor', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    const messages = anchoredAt(threshold + 10_000)

    expect(await shouldAutoCompact(messages, MODEL)).toBe(true)
    expect(
      await shouldAutoCompact(messages, MODEL, undefined, 20_000),
    ).toBe(false)
  })

  test('freed tokens below the overshoot still compact', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    const messages = anchoredAt(threshold + 10_000)

    expect(await shouldAutoCompact(messages, MODEL, undefined, 5_000)).toBe(
      true,
    )
  })
})

describe('shouldAutoCompact measured non-message overhead', () => {
  const MODEL = 'claude-sonnet-4-6'
  let windowSnapshot: string | undefined

  beforeEach(() => {
    windowSnapshot = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // Shrink the window so the fixture is a 15KB string instead of 450KB.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '60000'
  })

  afterEach(() => {
    if (windowSnapshot === undefined) {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    } else {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = windowSnapshot
    }
  })

  // The decision-relevant fallback: a gpt-produced anchor is thrown away on a
  // switch to Claude, so the whole request is rough-estimated and the
  // non-message overhead is a guess rather than a server measurement.
  function gptAnchoredConversation(toolResultChars: number): Message[] {
    return [
      {
        type: 'user',
        uuid: 'user-tool-result',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'W'.repeat(toolResultChars),
            },
          ],
        },
      } as unknown as Message,
      {
        type: 'assistant',
        uuid: 'gpt-anchor',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'gpt-anchor',
          model: 'gpt-5.6-luna',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 130,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as unknown as Message,
    ]
  }

  test('a big measured overhead compacts where the 20K floor would not', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    // Sit 2K under the threshold once the floor is added. tool_result content
    // is rough-counted at 3 chars/token.
    const contentTokens = threshold - NON_MESSAGE_REQUEST_OVERHEAD_TOKENS - 2_000
    const messages = gptAnchoredConversation(contentTokens * 3)

    expect(await shouldAutoCompact(messages, MODEL)).toBe(false)
    expect(
      await shouldAutoCompact(
        messages,
        MODEL,
        undefined,
        0,
        NON_MESSAGE_REQUEST_OVERHEAD_TOKENS + 10_000,
      ),
    ).toBe(true)
  })

  test('a measured overhead under the floor changes nothing', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    const contentTokens = threshold - NON_MESSAGE_REQUEST_OVERHEAD_TOKENS - 2_000
    const messages = gptAnchoredConversation(contentTokens * 3)

    expect(
      await shouldAutoCompact(messages, MODEL, undefined, 0, 1_000),
    ).toBe(false)
  })
})

describe('measureNonMessageOverheadTokens', () => {
  const MODEL = 'claude-sonnet-4-6'

  beforeEach(() => {
    _resetToolSchemaTokensMemoForTest()
  })

  afterEach(() => {
    _resetToolSchemaTokensMemoForTest()
  })

  function fakeTool(name: string, descriptionChars: number): Tool {
    return {
      name,
      inputJSONSchema: { type: 'object', properties: {} },
      prompt: async () => 'd'.repeat(descriptionChars),
    } as unknown as Tool
  }

  function contextWith(tools: Tool[]): ToolUseContext {
    return {
      options: {
        tools,
        agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
      },
      getAppState: () => ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
    } as unknown as ToolUseContext
  }

  function measure(tools: Tool[], systemPrompt: string[] = []) {
    return measureNonMessageOverheadTokens({
      model: MODEL,
      toolUseContext: contextWith(tools),
      systemPrompt,
      userContext: {},
      systemContext: {},
    })
  }

  test('counts the serialized tool schemas', async () => {
    const tokens = await measure([fakeTool('AlphaTool', 30_000)])
    // 30K chars of description at the structured ratio of 3.
    expect(tokens).toBeGreaterThan(9_000)
    expect(tokens).toBeLessThan(11_000)
  })

  test('counts the system prompt, not only the tools', async () => {
    const withoutPrompt = await measure([fakeTool('BetaTool', 1_000)])
    _resetToolSchemaTokensMemoForTest()
    const withPrompt = await measure(
      [fakeTool('BetaTool', 1_000)],
      ['p'.repeat(8_000)],
    )
    // Prose ratio of 4 → ~2,000 tokens for the added system prompt.
    expect(withPrompt - withoutPrompt).toBeGreaterThan(1_800)
    expect(withPrompt - withoutPrompt).toBeLessThan(2_200)
  })

  test('a grown tool set is re-measured, not served from the memo', async () => {
    // Deferred-tool discovery adds tools mid-session. A memo that survived that
    // would keep reporting the old, smaller tool block forever.
    const first = await measure([fakeTool('GammaTool', 12_000)])
    const second = await measure([
      fakeTool('GammaTool', 12_000),
      fakeTool('DeltaTool', 12_000),
    ])
    expect(second).toBeGreaterThan(first * 1.8)
  })

  test('an unchanged tool set is stable across calls', async () => {
    const tools = [fakeTool('EpsilonTool', 5_000)]
    expect(await measure(tools)).toBe(await measure(tools))
  })

  test('two live tool sets keep their own measurements', async () => {
    // Subagents and the compact fork run alongside the main thread with
    // different tool sets; neither may be served the other's number.
    const main = [fakeTool('ZetaTool', 20_000)]
    const fork = [fakeTool('EtaTool', 2_000)]
    const mainFirst = await measure(main)
    const forkTokens = await measure(fork)
    const mainAgain = await measure(main)

    expect(mainAgain).toBe(mainFirst)
    expect(forkTokens).toBeLessThan(mainFirst)
  })
})
