import { afterEach, describe, expect, test } from 'bun:test'
import {
  isProviderSwitchLocked,
  setProviderSwitchLocked,
} from '../../bootstrap/state.js'

import type { Message } from '../../types/message.js'
import {
  canApplyModelSelection,
  hasProviderBoundHistory,
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

  // A settings-file model reaches startup as "not explicit" so that
  // CLAUDE_CODE_USE_* keeps precedence over saved settings. That must not cost
  // the GPT implication: request routing sends every gpt-* id to OpenAI, and
  // the provider-shaped tool set (Apply_patch vs Edit) is chosen from this
  // result, so a settings-file `{"model":"gpt-5.6-terra"}` still has to land on
  // OpenAI. Before the fix this returned the implicit provider.
  test('a model-implied provider survives an implicit startup', () => {
    expect(resolveStartupProvider('gpt-5.6-terra', false, 'firstParty')).toBe(
      'openai',
    )
    expect(resolveStartupProvider('gpt-5.6-terra', false, 'bedrock')).toBe(
      'openai',
    )
  })
})

describe('hasProviderBoundHistory', () => {
  function assistant(model: string): Message {
    return {
      type: 'assistant',
      uuid: 'a',
      message: { role: 'assistant', model, content: [] },
    } as unknown as Message
  }

  test('a real assistant turn binds the session to its provider', () => {
    expect(hasProviderBoundHistory([assistant('gpt-5.6-terra')])).toBe(true)
  })

  test('cost-output and meta rows alone leave the session unbound', () => {
    expect(hasProviderBoundHistory([])).toBe(false)
    expect(hasProviderBoundHistory([assistant('<synthetic>')])).toBe(false)
    expect(
      hasProviderBoundHistory([
        {
          type: 'user',
          uuid: 'u',
          isMeta: true,
          message: { role: 'user', content: [] },
        } as unknown as Message,
      ]),
    ).toBe(false)
  })
})
