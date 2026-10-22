import { expect, test } from 'bun:test'
import { getProviderForModel } from '../../src/utils/model/providerForModel.js'
import { modelMarkProvider } from './modelProvider.js'

test('gpt ids earn the OpenAI mark and claude ids the Anthropic mark', () => {
  expect(modelMarkProvider('gpt-6-sol')).toBe('openai')
  expect(modelMarkProvider('claude-opus-5-5')).toBe('anthropic')
  expect(modelMarkProvider('claude-sonnet-4-6')).toBe('anthropic')
})

test('unknown, custom, alias and synthetic ids earn no mark', () => {
  for (const model of [null, undefined, '', 'llama-3', 'sonnet', 'opus[1m]', '<synthetic>', 'GPT-6', 'my-claude-fork']) {
    expect(modelMarkProvider(model)).toBeNull()
  }
})

test('the gpt rule agrees with the engine provider routing', () => {
  for (const model of ['gpt-6-sol', 'gpt-5.5', 'claude-opus-5-5', 'GPT-6', 'x']) {
    expect(modelMarkProvider(model) === 'openai').toBe(getProviderForModel(model) === 'openai')
  }
})
