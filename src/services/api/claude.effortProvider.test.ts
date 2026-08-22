import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { BetaOutputConfig } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { resetStateForTests, setSessionProvider } from '../../bootstrap/state.js'
import { EFFORT_BETA_HEADER } from '../../constants/betas.js'
import { configureEffortParams } from './claude.js'

/**
 * A Claude-family model that supports effort. `getProviderForModel` returns
 * null for it, so the request provider is whatever the caller supplies. That
 * is the only shape in which the caller's provider and the process-global
 * session provider can disagree, and it is exactly what `runAgent.ts:764`
 * hands a background child spawned by a gpt worker.
 */
const CLAUDE_MODEL = 'claude-opus-5-20260401'

function run(
  provider: 'openai' | 'firstParty',
): { betas: string[]; outputConfig: BetaOutputConfig } {
  const betas: string[] = []
  const outputConfig: BetaOutputConfig = {}
  configureEffortParams(
    'high',
    outputConfig,
    {},
    betas,
    CLAUDE_MODEL,
    provider,
  )
  return { betas, outputConfig }
}

describe('configureEffortParams request provider scoping', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  afterEach(() => {
    resetStateForTests()
  })

  test('omits the Anthropic effort beta for a Codex worker while the session is on Anthropic', () => {
    setSessionProvider('firstParty')

    const { betas, outputConfig } = run('openai')

    expect(outputConfig.effort).toBe('high')
    expect(betas).not.toContain(EFFORT_BETA_HEADER)
  })

  test('keeps the Anthropic effort beta for an Anthropic worker while the session is on Codex', () => {
    setSessionProvider('openai')

    const { betas, outputConfig } = run('firstParty')

    expect(outputConfig.effort).toBe('high')
    expect(betas).toContain(EFFORT_BETA_HEADER)
  })
})
