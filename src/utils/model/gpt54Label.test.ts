import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { CODEX_MODELS } from '../../services/api/codex-fetch-adapter.js'
import { getAgentModelOptions } from './agent.js'
import { getPublicModelDisplayName } from './model.js'

describe('gpt-5.4 labels', () => {
  test('drops the previous suffix across user-facing surfaces', () => {
    expect(getPublicModelDisplayName('gpt-5.4')).toBe('GPT 5.4')

    expect(
      getAgentModelOptions().find(option => option.value === 'gpt-5.4')?.label,
    ).toBe('GPT-5.4')

    expect(
      CODEX_MODELS.find(model => model.id === 'gpt-5.4')?.label,
    ).toBe('GPT-5.4')

    expect(
      readFileSync(new URL('./modelOptions.ts', import.meta.url), 'utf8'),
    ).not.toContain('GPT-5.4 (previous)')
  })
})
