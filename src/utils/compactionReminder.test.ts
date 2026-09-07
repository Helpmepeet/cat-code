import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import type { Message } from '../types/message.js'

// First coverage for `getCompactionReminderAttachment`. The regression it
// protects is the WINDOW gate: the reminder exists to tell a model with room
// that it need not rush, so which models clear `>= 1_000_000` is the whole
// behaviour. GPT-5.6 Sol moved across that line when it took a 1M Codex window,
// and nothing pinned which side each Codex model lands on.
//
// The window resolution is deliberately NOT mocked — it is the thing under
// test. Only the gates around it are: the growthbook flag (default false, so
// the function is inert without this), auto-compact enablement (otherwise the
// machine's own config decides), and the token count (a real tokenizer walk
// over fixtures would make the 25% boundary a guess rather than an assertion).
//
// `null` means "this file is not controlling the value", and every override
// resets to it. `mock.restore()` does NOT unregister a `mock.module`, so these
// registrations outlive this file and are what every later file in the process
// sees; a plain boolean default would pin `tengu_marble_fox` on and freeze
// `tokenCountWithEstimation` at a constant for all of them.
const actualGrowthbook = await import('../services/analytics/growthbook.js')
const actualAutoCompact = await import('../services/compact/autoCompact.js')
const actualTokens = await import('./tokens.js')
// Captured BEFORE registering: `mock.module` mutates the namespace object a
// prior import returned, so calling through the namespace would recurse.
const real = {
  getFeatureValue: actualGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE,
  isAutoCompactEnabled: actualAutoCompact.isAutoCompactEnabled,
  tokenCountWithEstimation: actualTokens.tokenCountWithEstimation,
}

let marbleFox: boolean | null = null
let autoCompactOn: boolean | null = null
let usedTokens: number | null = null

beforeEach(async () => {
  await mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: (flag: string, fallback: unknown) =>
      flag === 'tengu_marble_fox' && marbleFox !== null
        ? marbleFox
        : (real.getFeatureValue as (f: string, d: unknown) => unknown)(flag, fallback),
  }))
  await mock.module('src/services/compact/autoCompact.js', () => ({
    ...actualAutoCompact,
    isAutoCompactEnabled: () =>
      autoCompactOn === null ? real.isAutoCompactEnabled() : autoCompactOn,
  }))
  await mock.module('src/utils/tokens.js', () => ({
    ...actualTokens,
    tokenCountWithEstimation: (...args: Parameters<typeof real.tokenCountWithEstimation>) =>
      usedTokens === null ? real.tokenCountWithEstimation(...args) : usedTokens,
  }))
})

afterEach(() => {
  marbleFox = null
  autoCompactOn = null
  usedTokens = null
  mock.restore()
})

const MESSAGES: Message[] = []

async function reminderFor(model: string) {
  const { getCompactionReminderAttachment } = await import('./attachments.js')
  return getCompactionReminderAttachment(MESSAGES, model)
}

// Sol: 1,000,000 native, 980,000 effective, so the 25% floor is 245,000.
// Terra and Luna: 372,000 native, below the gate at any usage.
test('only a model with a 1M window gets the reminder', async () => {
  marbleFox = true
  autoCompactOn = true
  usedTokens = 300_000

  expect(await reminderFor('gpt-5.6-sol')).toEqual([
    { type: 'compaction_reminder' },
  ])
  expect(await reminderFor('gpt-6-astra')).toEqual([
    { type: 'compaction_reminder' },
  ])
  expect(await reminderFor('claude-opus-5')).toEqual([
    { type: 'compaction_reminder' },
  ])

  for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna']) {
    expect(await reminderFor(model)).toEqual([])
  }
})

test('stays silent below a quarter of the effective window', async () => {
  marbleFox = true
  autoCompactOn = true

  // 980,000 * 0.25 = 245,000 exactly.
  usedTokens = 244_999
  expect(await reminderFor('gpt-5.6-sol')).toEqual([])

  usedTokens = 245_000
  expect(await reminderFor('gpt-5.6-sol')).toEqual([
    { type: 'compaction_reminder' },
  ])
})

test('each gate alone suppresses it', async () => {
  autoCompactOn = true
  usedTokens = 300_000

  marbleFox = false
  expect(await reminderFor('gpt-5.6-sol')).toEqual([])

  marbleFox = true
  autoCompactOn = false
  expect(await reminderFor('gpt-5.6-sol')).toEqual([])
})
