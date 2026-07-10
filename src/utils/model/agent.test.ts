import { beforeAll, describe, expect, test } from 'bun:test'

import { getAgentModel, isSameFamilyDowngrade } from './agent.js'
import { getCanonicalName } from './model.js'

describe('getAgentModel downgrade guard', () => {
  beforeAll(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })

  test('ignores a Terra subagent request when the parent uses Sol', () => {
    expect(
      getAgentModel(undefined, 'gpt-5.6-sol', 'gpt-5.6-terra', 'default'),
    ).toBe('gpt-5.6-sol')
  })

  test('ignores a Luna subagent request when the parent uses Terra', () => {
    expect(
      getAgentModel(undefined, 'gpt-5.6-terra', 'gpt-5.6-luna', 'default'),
    ).toBe('gpt-5.6-terra')
  })

  test('honors a Terra subagent request as an upgrade from Luna', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'gpt-5.6-luna', 'gpt-5.6-terra', 'default'),
      ),
    ).toBe('gpt-5.6-terra')
  })

  test('honors a Sol subagent request as an upgrade from Terra', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'gpt-5.6-terra', 'gpt-5.6-sol', 'default'),
      ),
    ).toBe('gpt-5.6-sol')
  })

  test('ignores tool-specified sonnet when parent is opus', () => {
    expect(
      getAgentModel(undefined, 'claude-opus-4-6', 'sonnet', 'default'),
    ).toBe('claude-opus-4-6')
  })

  test('honors tool-specified opus upgrade from sonnet parent', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'claude-sonnet-4-6', 'opus', 'default'),
      ),
    ).toContain('opus')
  })

  test('honors cross-family tool-specified model', () => {
    expect(
      getCanonicalName(getAgentModel(undefined, 'gpt-5.6-terra', 'sonnet', 'default')),
    ).toContain('sonnet')
  })

  test('agent-file model pins are unaffected (Explore keeps its Luna pin)', () => {
    expect(getAgentModel('gpt-5.6-luna', 'gpt-5.6-terra', undefined, 'default')).toBe(
      'gpt-5.6-luna',
    )
  })

  test('falls back to agent-file pin when the tool arg is a downgrade', () => {
    expect(
      getAgentModel('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'default'),
    ).toBe('gpt-5.6-luna')
  })
})

describe('isSameFamilyDowngrade', () => {
  test('same model is not a downgrade', () => {
    expect(isSameFamilyDowngrade('gpt-5.6-terra', 'gpt-5.6-terra')).toBe(false)
  })

  test('unknown models never trigger the guard', () => {
    expect(isSameFamilyDowngrade('gpt-5.2', 'gpt-5.1-codex')).toBe(false)
    expect(isSameFamilyDowngrade('sonnet', 'claude-fable-5')).toBe(false)
  })

  test('full parent model ids are canonicalized before comparison', () => {
    expect(isSameFamilyDowngrade('sonnet', 'claude-opus-4-6-20251101')).toBe(
      true,
    )
    expect(isSameFamilyDowngrade('opus', 'claude-haiku-4-5-20251001')).toBe(
      false,
    )
  })
})
