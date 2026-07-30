import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getAutoCompactRecoveryWindowTokens,
  getAutoCompactThreshold,
  getBlockingLimit,
  getEffectiveContextWindowSize,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from './autoCompact.js'
import { getContextWindowForModel } from '../../utils/context.js'

const ENV_KEYS = [
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const

const envSnapshot = new Map<string, string | undefined>()

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
})
