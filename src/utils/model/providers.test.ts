import { afterEach, describe, expect, test } from 'bun:test'
import {
  isProviderSwitchLocked,
  setProviderSwitchLocked,
} from '../../bootstrap/state.js'

import {
  canApplyModelSelection,
  resolveModelSelectionProvider,
  resolveStartupProvider,
} from './providers.js'

const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
const originalProviderLock = isProviderSwitchLocked()

afterEach(() => {
  if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock
  if (originalVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
  else process.env.CLAUDE_CODE_USE_VERTEX = originalVertex
  if (originalFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = originalFoundry
  setProviderSwitchLocked(originalProviderLock)
})

describe('resolveModelSelectionProvider', () => {
  test('routes GPT selections to OpenAI', () => {
    expect(resolveModelSelectionProvider('gpt-5.6-terra', 'firstParty')).toBe(
      'openai',
    )
  })

  test('routes a Claude alias selected from OpenAI back to first-party Anthropic', () => {
    expect(resolveModelSelectionProvider('opus', 'openai')).toBe('firstParty')
    expect(resolveModelSelectionProvider('claude-sonnet-4-6', 'openai')).toBe(
      'firstParty',
    )
  })

  test('restores the configured Anthropic cloud provider instead of forcing first-party', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(resolveModelSelectionProvider('sonnet', 'openai')).toBe('bedrock')
  })

  test('preserves an active non-OpenAI provider for custom model ids', () => {
    expect(resolveModelSelectionProvider('custom-vertex-model', 'vertex')).toBe(
      'vertex',
    )
  })

  test('keeps Default and ambiguous custom ids on the current OpenAI provider', () => {
    expect(resolveModelSelectionProvider(null, 'openai')).toBe('openai')
    expect(resolveModelSelectionProvider('custom-openai-model', 'openai')).toBe(
      'openai',
    )
  })

  test('blocks a cross-provider alias after input tokens exist', () => {
    setProviderSwitchLocked(false)
    expect(canApplyModelSelection('opus', 1, 'openai')).toBe(false)
    expect(canApplyModelSelection('opus', 0, 'openai')).toBe(true)
    expect(canApplyModelSelection('gpt-5.6-terra', 1, 'openai')).toBe(true)
    expect(canApplyModelSelection(null, 1, 'openai')).toBe(true)
  })

  test('blocks a cross-provider alias when restored history is locked without token cost', () => {
    setProviderSwitchLocked(true)
    expect(canApplyModelSelection('opus', 0, 'openai')).toBe(false)
    expect(canApplyModelSelection('gpt-5.6-terra', 0, 'openai')).toBe(true)
  })

  test('implicit startup preserves an explicit OpenAI environment route', () => {
    expect(
      resolveStartupProvider('claude-sonnet-4-6', false, 'openai'),
    ).toBe('openai')
    expect(resolveStartupProvider('opus', true, 'openai')).toBe('firstParty')
  })
})
