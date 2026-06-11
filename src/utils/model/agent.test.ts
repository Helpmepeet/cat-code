import { beforeAll, describe, expect, test } from 'bun:test'

import { getAgentModel, isSameFamilyDowngrade } from './agent.js'
import { getCanonicalName } from './model.js'

describe('getAgentModel downgrade guard', () => {
  beforeAll(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })

  test('ignores tool-specified gpt-5.4 when parent is gpt-5.5', () => {
    expect(getAgentModel(undefined, 'gpt-5.5', 'gpt-5.4', 'default')).toBe(
      'gpt-5.5',
    )
  })

  test('ignores tool-specified gpt-5.4-mini when parent is gpt-5.4', () => {
    expect(getAgentModel(undefined, 'gpt-5.4', 'gpt-5.4-mini', 'default')).toBe(
      'gpt-5.4',
    )
  })

  test('honors tool-specified gpt-5.5 upgrade from gpt-5.4 parent', () => {
    expect(
      getCanonicalName(getAgentModel(undefined, 'gpt-5.4', 'gpt-5.5', 'default')),
    ).toBe('gpt-5.5')
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
      getCanonicalName(getAgentModel(undefined, 'gpt-5.5', 'sonnet', 'default')),
    ).toContain('sonnet')
  })

  test('agent-file model pins are unaffected (Explore keeps its cheap pin)', () => {
    expect(getAgentModel('gpt-5.4-mini', 'gpt-5.5', undefined, 'default')).toBe(
      'gpt-5.4-mini',
    )
  })

  test('falls back to agent-file pin when the tool arg is a downgrade', () => {
    expect(
      getAgentModel('gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4', 'default'),
    ).toBe('gpt-5.4-mini')
  })
})

describe('isSameFamilyDowngrade', () => {
  test('same model is not a downgrade', () => {
    expect(isSameFamilyDowngrade('gpt-5.5', 'gpt-5.5')).toBe(false)
  })

  test('unknown models never trigger the guard', () => {
    expect(isSameFamilyDowngrade('gpt-5.4', 'gpt-5.3-codex')).toBe(false)
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
