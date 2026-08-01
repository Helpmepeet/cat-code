import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  getInitialMainLoopModel,
  getMainLoopModelOverride,
  getSessionProvider,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setSessionProvider,
} from '../../bootstrap/state.js'

// The desktop picker rendered TWO identical "Sonnet 5" rows. The Max/Team
// Premium list offers Sonnet under the family alias `sonnet` (MaxSonnet5Option),
// but a Codex session persists the canonical `claude-sonnet-5` (getSonnet5Option's
// value is provider-dependent). getModelOptions()'s "current model is not offered,
// append it" fallback compared RAW strings, so the same model was appended a
// second time with a byte-identical label.

// A first-party Max fixture: these are the only auth reads getModelOptionsBase
// branches on, and real OAuth tokens are not available in a test process. The
// mock passes through to the real implementations whenever `tier` is null, so a
// leaked module registration cannot change behavior for other suites.
// `'codex'` selects the OTHER arm of getModelOptionsBase — the one a Codex
// session takes, which offers Anthropic models as cross-provider rows so you can
// switch before the first query.
let tier: 'max' | 'codex' | null = null

const previous = {
  override: getMainLoopModelOverride(),
  initial: getInitialMainLoopModel(),
  provider: getSessionProvider(),
  userType: process.env.USER_TYPE,
  disable1m: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
  customOption: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
  apiKey: process.env.ANTHROPIC_API_KEY,
}

// `mock.module` MUTATES the namespace object a prior `import` returned, so a
// pass-through written as `actual.isCodexSubscriber()` calls the mock itself and
// recurses forever the moment `tier` is null. Capture the implementations before
// registering anything; bun never unregisters the module, so every later file in
// the process would otherwise hang on the first auth read.
const actual = await import('../auth.js')
const real = {
  isClaudeAISubscriber: actual.isClaudeAISubscriber,
  isMaxSubscriber: actual.isMaxSubscriber,
  isTeamPremiumSubscriber: actual.isTeamPremiumSubscriber,
  isCodexSubscriber: actual.isCodexSubscriber,
  hasCodexTokens: actual.hasCodexTokens,
  hasAnthropicCredentials: actual.hasAnthropicCredentials,
}

beforeEach(async () => {
  await mock.module('src/utils/auth.js', () => ({
    ...actual,
    isClaudeAISubscriber: () =>
      tier === null ? real.isClaudeAISubscriber() : tier === 'max',
    isMaxSubscriber: () =>
      tier === null ? real.isMaxSubscriber() : tier === 'max',
    isTeamPremiumSubscriber: () =>
      tier === null ? real.isTeamPremiumSubscriber() : false,
    isCodexSubscriber: () =>
      tier === null ? real.isCodexSubscriber() : tier === 'codex',
    hasCodexTokens: () =>
      tier === null ? real.hasCodexTokens() : tier === 'codex',
    hasAnthropicCredentials: () =>
      tier === null ? real.hasAnthropicCredentials() : true,
  }))
  tier = 'max'
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  // Unmocked auth reads (isProSubscriber via isOpus1mMergeEnabled) throw under
  // NODE_ENV=test without a credential env var; a dummy key satisfies them.
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key'
  setSessionProvider('firstParty')
})

afterEach(() => {
  tier = null
  setMainLoopModelOverride(previous.override)
  setInitialMainLoopModel(previous.initial)
  setSessionProvider(previous.provider)
  if (previous.userType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = previous.userType
  if (previous.disable1m === undefined)
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = previous.disable1m
  if (previous.customOption === undefined)
    delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  else process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = previous.customOption
  if (previous.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previous.apiKey
})

function labelCount(options: { label: string }[], label: string): number {
  return options.filter(option => option.label === label).length
}

describe('getModelOptions duplicate-row fallback', () => {
  test('a canonical model id already offered under its alias does not add a second row', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    setMainLoopModelOverride('claude-sonnet-5')

    const options = getModelOptions(false)

    expect(labelCount(options, 'Sonnet 5')).toBe(1)
    expect(options.some(option => option.value === 'sonnet')).toBe(true)
    expect(options.some(option => option.value === 'claude-sonnet-5')).toBe(
      false,
    )
  })

  test('the initial model falls through the same check when Default clears the override', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    // Selecting "Default (recommended)" writes a null override, so the fallback
    // reads getInitialMainLoopModel() instead — a ghost row must not appear there.
    setMainLoopModelOverride(null)
    setInitialMainLoopModel('claude-sonnet-5')

    expect(labelCount(getModelOptions(false), 'Sonnet 5')).toBe(1)
  })

  test('opusplan keeps its own row even though it resolves to the Sonnet default', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    const { parseUserSpecifiedModel } = await import('./model.js')
    setMainLoopModelOverride('opusplan')

    // The trap: opusplan resolves to Sonnet (Opus applies in plan mode only).
    expect(parseUserSpecifiedModel('opusplan')).toBe(
      parseUserSpecifiedModel('sonnet'),
    )

    const options = getModelOptions(false)
    expect(options.some(option => option.value === 'opusplan')).toBe(true)
    expect(labelCount(options, 'Sonnet 5')).toBe(1)
  })

  test('best keeps its own row even though it resolves to Fable', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    const { parseUserSpecifiedModel } = await import('./model.js')
    setMainLoopModelOverride('best')

    expect(parseUserSpecifiedModel('best')).toBe(
      parseUserSpecifiedModel('fable'),
    )

    const options = getModelOptions(false)
    expect(options.some(option => option.value === 'best')).toBe(true)
    expect(labelCount(options, 'Fable 5')).toBe(1)
  })

  test('a 1M variant stays distinct from its base model', async () => {
    const { getModelOptions, optionCoversModelSetting } = await import(
      './modelOptions.js'
    )

    expect(optionCoversModelSetting('sonnet', 'claude-sonnet-5[1m]')).toBe(false)
    expect(optionCoversModelSetting('sonnet[1m]', 'claude-sonnet-5[1m]')).toBe(
      true,
    )

    setMainLoopModelOverride('claude-sonnet-5[1m]')
    const options = getModelOptions(false)
    // Not swallowed by the plain Sonnet row: the 1M setting still gets a row.
    expect(labelCount(options, 'Sonnet 5')).toBe(1)
    expect(
      options.some(option => option.value === 'claude-sonnet-5[1m]'),
    ).toBe(true)
  })

  test('opaque aliases only ever match by exact string', async () => {
    const { optionCoversModelSetting } = await import('./modelOptions.js')

    expect(optionCoversModelSetting('sonnet', 'opusplan')).toBe(false)
    expect(optionCoversModelSetting('opusplan', 'claude-sonnet-5')).toBe(false)
    expect(optionCoversModelSetting('fable', 'best')).toBe(false)
    expect(optionCoversModelSetting('opusplan', 'opusplan')).toBe(true)
    // The Default row (null) never covers a concrete setting.
    expect(optionCoversModelSetting(null, 'claude-sonnet-5')).toBe(false)
  })
})

describe('1M-context rows and Sonnet 4.6', () => {
  test('no roster row advertises "(1M context)" on first-party', async () => {
    // Claude 5 frontier models already use the 1M window with no suffix
    // (`modelUses1MContextByDefault`), so the suffix named a window identical to
    // the plain row beside it and read as arbitrary next to Opus 5 and Fable 5,
    // which are equally 1M and never carried it.
    const { getModelOptions } = await import('./modelOptions.js')

    for (const currentTier of ['max', 'codex'] as const) {
      tier = currentTier
      const options = getModelOptions(false)
      expect(options.length).toBeGreaterThan(0)
      expect(options.some(option => option.label.includes('(1M context)'))).toBe(
        false,
      )
    }
  })

  test('Sonnet 4.6 is gone from the roster entirely', async () => {
    const { getModelOptions } = await import('./modelOptions.js')

    for (const currentTier of ['max', 'codex'] as const) {
      tier = currentTier
      const options = getModelOptions(false)
      expect(options.some(option => option.label.includes('4.6'))).toBe(false)
      expect(options.some(option => option.value === 'sonnet[1m]')).toBe(false)
    }
  })

  test('the Codex arm still offers the Anthropic cross-provider rows', async () => {
    // Removing the 1M row must not take the cross-provider block with it: this
    // branch exists so you can switch provider before the first query.
    const { getModelOptions } = await import('./modelOptions.js')
    tier = 'codex'

    const labels = getModelOptions(false).map(option => option.label)

    expect(labels).toContain('Sonnet 5')
    expect(labels).toContain('Opus 5')
    expect(labels).toContain('Fable 5')
    expect(labels).toContain('GPT-5.6 Sol')
  })
})
