import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  getInitialMainLoopModel,
  getMainLoopModelOverride,
  getSessionProvider,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setSessionProvider,
} from '../../bootstrap/state.js'

// The desktop picker rendered TWO identical "Sonnet 5.5" rows. The Max/Team
// Premium list offers Sonnet under the family alias `sonnet` (MaxSonnet55Option),
// but a Codex session persists the canonical `claude-sonnet-5-5` (getSonnet55Option's
// value is provider-dependent). getModelOptions()'s "current model is not offered,
// append it" fallback compared RAW strings, so the same model was appended a
// second time with a byte-identical label.

// Subscription fixtures avoid reading real OAuth tokens in a test process. The
// mock passes through to the real implementations whenever `tier` is null, so a
// leaked module registration cannot change behavior for other suites.
// `'codex'` selects the OTHER arm of getModelOptionsBase — the one a Codex
// session takes, which offers Anthropic models as cross-provider rows so you can
// switch before the first query.
type TestTier =
  | 'max'
  | 'teamPremium'
  | 'pro'
  | 'teamStandard'
  | 'enterprise'
  | 'payg'
  | 'codex'
let tier: TestTier | null = null

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
  isProSubscriber: actual.isProSubscriber,
  isTeamPremiumSubscriber: actual.isTeamPremiumSubscriber,
  getSubscriptionType: actual.getSubscriptionType,
  isCodexSubscriber: actual.isCodexSubscriber,
  hasCodexTokens: actual.hasCodexTokens,
  hasAnthropicCredentials: actual.hasAnthropicCredentials,
}

beforeEach(async () => {
  await mock.module('src/utils/auth.js', () => ({
    ...actual,
    isClaudeAISubscriber: () =>
      tier === null
        ? real.isClaudeAISubscriber()
        : tier !== 'codex' && tier !== 'payg',
    isMaxSubscriber: () =>
      tier === null ? real.isMaxSubscriber() : tier === 'max',
    isProSubscriber: () =>
      tier === null ? real.isProSubscriber() : tier === 'pro',
    isTeamPremiumSubscriber: () =>
      tier === null ? real.isTeamPremiumSubscriber() : tier === 'teamPremium',
    getSubscriptionType: () =>
      tier === null
        ? real.getSubscriptionType()
        : tier === 'teamPremium' || tier === 'teamStandard'
          ? 'team'
          : tier === 'payg' || tier === 'codex'
            ? null
            : tier,
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
  // Other auth reads throw under NODE_ENV=test without a credential env var.
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

describe('stable first-party model roster', () => {
  for (const currentTier of [
    'pro',
    'teamStandard',
    'enterprise',
    'payg',
    'max',
    'teamPremium',
  ] as const) {
    test(`${currentTier} keeps Sonnet and Opus across switches in both directions`, async () => {
      const { getModelOptions } = await import('./modelOptions.js')
      const { parseUserSpecifiedModel } = await import('./model.js')
      const { buildRunControlsSnapshot } = await import(
        '../../../app/sidecar/runControlsDomain.js'
      )
      const { getDefaultAppState } = await import('../../state/AppStateStore.js')
      tier = currentTier
      setInitialMainLoopModel(null)
      setMainLoopModelOverride(null)
      const roster = getModelOptions(false)
      const sonnet = roster.find(option => option.label === 'Sonnet 5.5')
      const opus = roster.find(option => option.label === 'Opus 5.5')
      expect(sonnet).toBeDefined()
      expect(opus).toBeDefined()

      for (const selection of [
        sonnet!.value,
        opus!.value,
        sonnet!.value,
        parseUserSpecifiedModel(sonnet!.value!),
        parseUserSpecifiedModel(opus!.value!),
        null,
      ]) {
        setMainLoopModelOverride(selection)
        const options = getModelOptions(false)
        expect(options).toEqual(roster)
        expect(labelCount(options, 'Sonnet 5.5')).toBe(1)
        expect(labelCount(options, 'Opus 5.5')).toBe(1)
        expect(new Set(options.map(option => option.value)).size).toBe(
          options.length,
        )

        const snapshot = buildRunControlsSnapshot(getDefaultAppState())
        expect(snapshot.model.options.map(option => option.value)).toEqual(
          roster.map(option => option.value),
        )
        const selected = snapshot.model.options.filter(
          option => option.value === snapshot.model.selected,
        )
        expect(selected).toHaveLength(1)
        expect(snapshot.model.selected).toBe(
          selection === null
            ? null
            : selection === sonnet!.value ||
                selection === parseUserSpecifiedModel(sonnet!.value!)
              ? sonnet!.value
              : opus!.value,
        )
      }
    })
  }

  test('canonical Sonnet selection uses the standard roster row rather than adding a duplicate', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    tier = 'pro'
    setMainLoopModelOverride('claude-sonnet-5-5')
    const sonnetRoster = getModelOptions(false)
    expect(sonnetRoster.find(option => option.value === 'sonnet')?.label).toBe(
      'Sonnet 5.5',
    )
    expect(labelCount(sonnetRoster, 'Sonnet 5.5')).toBe(1)

    setMainLoopModelOverride('claude-opus-5-5')
    expect(getModelOptions(false)).toEqual(sonnetRoster)
  })

  test('a custom pinned model keeps its fallback alongside the standard roster', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    tier = 'pro'
    setMainLoopModelOverride('custom-pinned-model')
    const options = getModelOptions(false)
    expect(options).toContainEqual({
      value: 'custom-pinned-model',
      label: 'custom-pinned-model',
      description: 'Custom model',
    })
    expect(labelCount(options, 'Sonnet 5.5')).toBe(1)
    expect(labelCount(options, 'Opus 5.5')).toBe(1)
  })

  test('third-party PAYG keeps its destination catalog and custom Sonnet row', async () => {
    const keys = [
      'CLAUDE_CODE_USE_BEDROCK',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ] as const
    const saved = keys.map(key => process.env[key])
    try {
      tier = 'payg'
      setSessionProvider('bedrock')
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      setMainLoopModelOverride(null)
      setInitialMainLoopModel(null)
      const { getModelOptions } = await import('./modelOptions.js')
      const roster = getModelOptions(false)
      expect(labelCount(roster, 'Sonnet 5.5')).toBe(0)
      expect(labelCount(roster, 'Opus 5.5')).toBe(0)
      expect(roster.some(option => option.label === 'Opus 4.1')).toBe(true)

      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'custom-bedrock-sonnet'
      const customRoster = getModelOptions(false)
      expect(customRoster.some(option => option.value === 'sonnet')).toBe(true)
      for (const selection of ['sonnet', 'opus', 'sonnet']) {
        setMainLoopModelOverride(selection)
        const options = getModelOptions(false)
        expect(options).toEqual(customRoster)
        expect(new Set(options.map(option => option.value)).size).toBe(
          options.length,
        )
      }
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key]
        else process.env[key] = saved[index]
      })
    }
  })
})

describe('Haiku 5.5', () => {
  test('Codex cross-provider Haiku uses the configured destination catalog and custom metadata', async () => {
    const keys = ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION'] as const
    const saved = keys.map(key => process.env[key])
    try {
      tier = 'codex'
      setSessionProvider('openai')
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      const { getModelOptions } = await import('./modelOptions.js')
      expect(getModelOptions(false).find(option => option.value === 'haiku')?.label).toBe('Haiku 4.5')
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'custom-haiku'
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = 'Custom fast model'
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = 'Custom destination'
      expect(getModelOptions(false).find(option => option.value === 'haiku')).toMatchObject({
        label: 'Custom fast model', description: 'Custom destination', descriptionForModel: 'Custom destination (custom-haiku)',
      })
    } finally {
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
    }
  })

  test('the haiku alias resolves to Haiku 5.5 and the picker offers it once', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    const { parseUserSpecifiedModel, getMarketingNameForModel } = await import(
      './model.js'
    )

    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-5-5')
    expect(getMarketingNameForModel('claude-haiku-5-5')).toBe('Haiku 5.5')

    const options = getModelOptions(false)
    expect(labelCount(options, 'Haiku 5.5')).toBe(1)
    expect(labelCount(options, 'Haiku 4.5')).toBe(0)
    expect(options.find(option => option.label === 'Haiku 5.5')?.value).toBe(
      'haiku',
    )
  })

  test('a session pinned to Haiku 4.5 keeps its own labelled row', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    setMainLoopModelOverride('claude-haiku-4-5-20251001')

    const options = getModelOptions(false)
    expect(labelCount(options, 'Haiku 4.5')).toBe(1)
    expect(labelCount(options, 'Haiku 5.5')).toBe(1)
  })
})

describe('getModelOptions duplicate-row fallback', () => {
  test('a canonical model id already offered under its alias does not add a second row', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    setMainLoopModelOverride('claude-sonnet-5-5')

    const options = getModelOptions(false)

    expect(labelCount(options, 'Sonnet 5.5')).toBe(1)
    expect(options.some(option => option.value === 'sonnet')).toBe(true)
    expect(options.some(option => option.value === 'claude-sonnet-5-5')).toBe(
      false,
    )
  })

  test('the initial model falls through the same check when Default clears the override', async () => {
    const { getModelOptions } = await import('./modelOptions.js')
    // Selecting "Default (recommended)" writes a null override, so the fallback
    // reads getInitialMainLoopModel() instead — a ghost row must not appear there.
    setMainLoopModelOverride(null)
    setInitialMainLoopModel('claude-sonnet-5-5')

    expect(labelCount(getModelOptions(false), 'Sonnet 5.5')).toBe(1)
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
    expect(labelCount(options, 'Sonnet 5.5')).toBe(1)
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

    expect(optionCoversModelSetting('sonnet', 'claude-sonnet-5-5[1m]')).toBe(false)
    expect(optionCoversModelSetting('sonnet[1m]', 'claude-sonnet-5-5[1m]')).toBe(
      true,
    )

    setMainLoopModelOverride('claude-sonnet-5-5[1m]')
    const options = getModelOptions(false)
    // Not swallowed by the plain Sonnet row: the 1M setting still gets a row.
    expect(labelCount(options, 'Sonnet 5.5')).toBe(1)
    expect(
      options.some(option => option.value === 'claude-sonnet-5-5[1m]'),
    ).toBe(true)
  })

  test('opaque aliases only ever match by exact string', async () => {
    const { optionCoversModelSetting } = await import('./modelOptions.js')

    expect(optionCoversModelSetting('sonnet', 'opusplan')).toBe(false)
    expect(optionCoversModelSetting('opusplan', 'claude-sonnet-5-5')).toBe(false)
    expect(optionCoversModelSetting('fable', 'best')).toBe(false)
    expect(optionCoversModelSetting('opusplan', 'opusplan')).toBe(true)
    // The Default row (null) never covers a concrete setting.
    expect(optionCoversModelSetting(null, 'claude-sonnet-5-5')).toBe(false)
  })
})

describe('1M-context rows and Sonnet 4.6', () => {
  test('no roster row advertises "(1M context)" on first-party', async () => {
    // Claude 5 frontier models already use the 1M window with no suffix
    // (`modelUses1MContextByDefault`), so the suffix named a window identical to
    // the plain row beside it and read as arbitrary next to Opus 5.5 and Fable 5,
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

    const options = getModelOptions(false)
    const labels = options.map(option => option.label)

    expect(labels).toContain('Sonnet 5.5')
    expect(labels).toContain('Opus 5.5')
    expect(labels).toContain('Fable 5')
    expect(labels).toContain('GPT-6.1 Sol')
    expect(labels).toContain('GPT-6 Astra')
    expect(labels).not.toContain('GPT-6 Sol')
    expect(options.some(option => option.value === 'gpt-6.1-sol')).toBe(true)
    for (const retiredModel of [
      'gpt-6-sol',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.5',
    ]) {
      expect(options.some(option => option.value === retiredModel)).toBe(false)
    }
    expect(labels.indexOf('GPT-6.1 Sol')).toBe(
      labels.indexOf('GPT-6 Astra') + 1,
    )
  })
})
