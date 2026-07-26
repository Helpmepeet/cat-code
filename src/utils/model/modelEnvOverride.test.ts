import { afterEach, describe, expect, test } from 'bun:test'

// CAT_CODE_MODEL is cat-code's own name for the model-selection env lever.
// ANTHROPIC_MODEL (upstream Claude Code's name) must keep working when
// CAT_CODE_MODEL is unset, and CAT_CODE_MODEL must win when both are set.

afterEach(() => {
  delete process.env.CAT_CODE_MODEL
  delete process.env.ANTHROPIC_MODEL
})

describe('getModelEnvOverride', () => {
  test('returns undefined when neither var is set', async () => {
    const { getModelEnvOverride } = await import('./model.js')
    expect(getModelEnvOverride()).toBeUndefined()
  })

  test('falls back to ANTHROPIC_MODEL when CAT_CODE_MODEL is unset', async () => {
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-luna'
    const { getModelEnvOverride } = await import('./model.js')
    expect(getModelEnvOverride()).toBe('gpt-5.6-luna')
  })

  test('CAT_CODE_MODEL wins when both are set', async () => {
    process.env.CAT_CODE_MODEL = 'gpt-5.6-terra'
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-luna'
    const { getModelEnvOverride } = await import('./model.js')
    expect(getModelEnvOverride()).toBe('gpt-5.6-terra')
  })

  test('CAT_CODE_MODEL alone is used when ANTHROPIC_MODEL is unset', async () => {
    process.env.CAT_CODE_MODEL = 'gpt-5.6-terra'
    const { getModelEnvOverride } = await import('./model.js')
    expect(getModelEnvOverride()).toBe('gpt-5.6-terra')
  })
})
