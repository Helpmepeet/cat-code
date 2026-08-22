import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const skillImprovementSource = await Bun.file(
  new URL('../hooks/skillImprovement.ts', import.meta.url),
).text()

// getSmallFastModelForProvider() routes cheap secondary calls (WebFetch
// post-processing, session titles, hook evaluations) to the GPT mini on the
// Codex/OpenAI fork, where the Anthropic Haiku default has no working
// credentials. It branches on isCodexSubscriber(), so we mock auth.js to flip
// that without needing real Codex tokens or an OpenAI session.

// `null` means "this file is not controlling the value": the override passes
// through to the real implementation. `mock.restore()` does NOT unregister a
// `mock.module`, so the registration below outlives this file and is what every
// later file in the process sees; a plain `false` default would pin
// isCodexSubscriber() to false for all of them.
let codexSubscriber: boolean | null = null

// Same contract for the two Anthropic tier predicates. The non-Codex branch of
// getDefaultMainLoopModelSetting() consults them, and both reach real
// credentials — which a test box on the Codex fork does not have.
let maxSubscriber: boolean | null = null
let teamPremiumSubscriber: boolean | null = null

// `mock.module` MUTATES the namespace object a prior `import` returned, so a
// pass-through written as `actualAuth.isCodexSubscriber()` calls the mock itself
// and recurses forever. Capture the implementation before registering anything.
const actualAuth = await import('../auth.js')
const real = {
  isCodexSubscriber: actualAuth.isCodexSubscriber,
  isMaxSubscriber: actualAuth.isMaxSubscriber,
  isTeamPremiumSubscriber: actualAuth.isTeamPremiumSubscriber,
}

beforeEach(async () => {
  await mock.module('src/utils/auth.js', () => ({
    ...actualAuth,
    isCodexSubscriber: () =>
      codexSubscriber === null ? real.isCodexSubscriber() : codexSubscriber,
    isMaxSubscriber: () =>
      maxSubscriber === null ? real.isMaxSubscriber() : maxSubscriber,
    isTeamPremiumSubscriber: () =>
      teamPremiumSubscriber === null
        ? real.isTeamPremiumSubscriber()
        : teamPremiumSubscriber,
  }))
})

afterEach(() => {
  codexSubscriber = null
  maxSubscriber = null
  teamPremiumSubscriber = null
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  mock.restore()
})

describe('getSmallFastModelForProvider', () => {
  test('skill improvement selects its side-call model through the provider-aware helper', () => {
    expect(skillImprovementSource).toContain('getSmallFastModelForProvider()')
    expect(skillImprovementSource).not.toContain('getSmallFastModel()')
  })

  test('uses GPT-5.6 Sol as the Codex main-loop default', async () => {
    codexSubscriber = true
    const { getDefaultMainLoopModelSetting } = await import('./model.js')
    expect(getDefaultMainLoopModelSetting()).toBe('gpt-5.6-sol')
  })

  test('leaves the non-Codex main-loop default alone', async () => {
    codexSubscriber = false
    maxSubscriber = false
    teamPremiumSubscriber = false
    const { getDefaultMainLoopModelSetting } = await import('./model.js')
    // Whichever Anthropic branch this account lands on, the Codex switch must
    // not reach it: no GPT id may leak into a non-Codex default.
    expect(getDefaultMainLoopModelSetting()).not.toStartWith('gpt-')
  })

  test('returns GPT-5.6 Luna on the Codex fork', async () => {
    codexSubscriber = true
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('gpt-5.6-luna')
  })

  test('falls back to the Anthropic Haiku default off the Codex fork', async () => {
    codexSubscriber = false
    const { getSmallFastModelForProvider, getDefaultHaikuModel } = await import(
      './model.js'
    )
    expect(getSmallFastModelForProvider()).toBe(getDefaultHaikuModel())
  })

  test('respects ANTHROPIC_SMALL_FAST_MODEL on the non-Codex path', async () => {
    codexSubscriber = false
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-custom-small'
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('claude-custom-small')
  })

  test('ignores ANTHROPIC_SMALL_FAST_MODEL on the Codex fork', async () => {
    codexSubscriber = true
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-custom-small'
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('gpt-5.6-luna')
  })
})
