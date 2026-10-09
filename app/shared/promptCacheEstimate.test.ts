import { expect, test } from 'bun:test'
import {
  ANTHROPIC_CACHE_1H_MS,
  ANTHROPIC_CACHE_5M_MS,
  CODEX_CACHE_IDLE_ESTIMATE_MS,
  estimatePromptCacheExpiry,
  isCacheExpiryTimestamp,
} from './promptCacheEstimate.js'

const AT = Date.parse('2026-10-08T08:00:00Z')
const codex = { input_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const claude = { input_tokens: 10, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 }

test('Codex uses the conservative retention estimate, not the 30-minute minimum', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.2-codex']) {
    expect(estimatePromptCacheExpiry(model, AT, codex)).toBe(AT + 24 * 60 * 60_000)
  }
  expect(CODEX_CACHE_IDLE_ESTIMATE_MS).toBe(24 * 60 * 60_000)
})

test('Codex counts read and write tokens toward the eligible prefix and ignores short inputs', () => {
  expect(estimatePromptCacheExpiry('gpt-6.1-sol', AT, { input_tokens: 1_023 })).toBeNull()
  expect(estimatePromptCacheExpiry('gpt-6.1-sol', AT, { input_tokens: 0, cache_read_input_tokens: 1_024 }))
    .toBe(AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('historical Claude uses reported write TTLs and a conservative TTL for read-only usage', () => {
  expect(estimatePromptCacheExpiry('claude-opus-5-5', AT, claude)).toBe(AT + ANTHROPIC_CACHE_1H_MS)
  expect(estimatePromptCacheExpiry('claude-opus-5-5', AT, {
    ...claude, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
  })).toBe(AT + ANTHROPIC_CACHE_5M_MS)
  expect(estimatePromptCacheExpiry('us.anthropic.claude-sonnet-5-5', AT, {
    ...claude, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 },
  })).toBe(AT + ANTHROPIC_CACHE_1H_MS)
})

test('live Claude can use the engine cache control, without shortening an observed one-hour write', () => {
  expect(estimatePromptCacheExpiry('claude-opus-5-5', AT, claude, ANTHROPIC_CACHE_5M_MS))
    .toBe(AT + ANTHROPIC_CACHE_5M_MS)
  expect(estimatePromptCacheExpiry('claude-opus-5-5', AT, {
    ...claude, cache_creation: { ephemeral_1h_input_tokens: 100 },
  }, ANTHROPIC_CACHE_5M_MS)).toBe(AT + ANTHROPIC_CACHE_1H_MS)
})

test('unsupported models and responses without eligible usage have no estimate', () => {
  expect(estimatePromptCacheExpiry('custom-deployment', AT, codex)).toBeNull()
  expect(estimatePromptCacheExpiry('<synthetic>', AT, codex)).toBeNull()
  expect(estimatePromptCacheExpiry('claude-opus-5-5', AT, codex)).toBeNull()
  for (const usage of [null, [], {}, { input_tokens: -1 }, { input_tokens: Number.NaN }]) {
    expect(estimatePromptCacheExpiry('gpt-6.1-sol', AT, usage)).toBeNull()
  }
})

test('invalid or overflowing timestamps cannot become deadlines', () => {
  for (const at of [-1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    expect(estimatePromptCacheExpiry('gpt-6.1-sol', at, codex)).toBeNull()
  }
  for (const value of ['123', null, {}, Number.NaN, Infinity, -1, 1.5]) {
    expect(isCacheExpiryTimestamp(value)).toBe(false)
  }
  expect(isCacheExpiryTimestamp(AT)).toBe(true)
})
