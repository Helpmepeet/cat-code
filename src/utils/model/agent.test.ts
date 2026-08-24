import { beforeAll, describe, expect, test } from 'bun:test'

import { getAgentModel } from './agent.js'
import { getCanonicalName } from './model.js'

describe('getAgentModel explicit override', () => {
  beforeAll(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })

  test('honors an explicit Terra selection when the parent uses Sol', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'gpt-5.6-sol', 'gpt-5.6-terra', 'default'),
      ),
    ).toBe('gpt-5.6-terra')
  })

  test('honors an explicit Luna selection when the parent uses Terra', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'gpt-5.6-terra', 'gpt-5.6-luna', 'default'),
      ),
    ).toBe('gpt-5.6-luna')
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

  test('honors an explicit Sonnet selection when the parent uses Opus', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'claude-opus-4-6', 'sonnet', 'default'),
      ),
    ).toContain('sonnet')
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

  test('tool-specified model takes precedence over an agent-file pin', () => {
    expect(
      getAgentModel('gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'default'),
    ).toBe('gpt-5.6-luna')
  })
})
