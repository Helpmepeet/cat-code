import { afterEach, beforeAll, describe, expect, test } from 'bun:test'

import {
  getSessionProvider,
  resetModelStringsForTestingOnly,
  setSessionProvider,
} from '../../bootstrap/state.js'
import { AGENT_MODEL_OPTIONS, getAgentModel, getAgentModelOptions } from './agent.js'
import { getCanonicalName } from './model.js'
import { getModelStrings } from './modelStrings.js'
import type { APIProvider } from './providers.js'

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

  test('honors an explicit Astra selection', () => {
    expect(
      getCanonicalName(
        getAgentModel(undefined, 'gpt-5.6-terra', 'gpt-6-astra', 'default'),
      ),
    ).toBe('gpt-6-astra')
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

describe('subagent Opus resolution per session provider', () => {
  const originalProvider = getSessionProvider()

  const withProvider = <T,>(provider: APIProvider, run: () => T): T => {
    setSessionProvider(provider)
    resetModelStringsForTestingOnly()
    return run()
  }

  beforeAll(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })

  afterEach(() => {
    setSessionProvider(originalProvider)
    resetModelStringsForTestingOnly()
  })

  test('a Codex session resolves the opus alias to Opus 5, not Opus 4.6', () => {
    // The operator's real shape: settings model gpt-5.6-sol, session provider
    // openai. `getAPIProvider() !== 'firstParty'` used to sweep openai into the
    // lagging-3P branch and hand every subagent Opus 4.6.
    const resolved = withProvider('openai', () =>
      getAgentModel(undefined, 'gpt-5.6-sol', 'opus', 'default'),
    )
    expect(resolved).toBe('claude-opus-5')
  })

  test('an agent-file opus pin in a Codex session also resolves to Opus 5', () => {
    const resolved = withProvider('openai', () =>
      getAgentModel('opus', 'gpt-5.6-sol', undefined, 'default'),
    )
    expect(resolved).toBe('claude-opus-5')
  })

  test('first-party sessions are unchanged', () => {
    const resolved = withProvider('firstParty', () =>
      getAgentModel(undefined, 'gpt-5.6-sol', 'opus', 'default'),
    )
    expect(resolved).toBe('claude-opus-5')
  })

  for (const provider of ['bedrock', 'vertex', 'foundry'] as const) {
    test(`${provider} still gets Opus 4.6, since its catalog lags first-party`, () => {
      const { resolved, expected } = withProvider(provider, () => ({
        resolved: getAgentModel(undefined, 'gpt-5.6-sol', 'opus', 'default'),
        expected: getModelStrings().opus46,
      }))
      expect(resolved).toBe(expected)
      expect(resolved).not.toContain('opus-5')
    })
  }
})

describe('explicit Opus 5 subagent pin', () => {
  const originalProvider = getSessionProvider()

  beforeAll(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })

  afterEach(() => {
    setSessionProvider(originalProvider)
    resetModelStringsForTestingOnly()
  })

  test('is offered as a selectable subagent model', () => {
    expect(AGENT_MODEL_OPTIONS).toContain('claude-opus-5')
    expect(
      getAgentModelOptions().find(option => option.value === 'claude-opus-5')
        ?.label,
    ).toBe('Opus 5')
  })

  test('survives an Opus 4.6 parent, which the bare opus alias does not', () => {
    // aliasMatchesParentTier() hands a bare `opus` request the parent's own
    // string. A version pin carries more than "same tier as parent", so it must
    // not be swallowed the same way.
    expect(getAgentModel('claude-opus-5', 'claude-opus-4-6', undefined, 'default')).toBe(
      'claude-opus-5',
    )
    expect(getAgentModel('opus', 'claude-opus-4-6', undefined, 'default')).toBe(
      'claude-opus-4-6',
    )
  })

  test('is honored from a Codex parent, on both the tool and agent-file paths', () => {
    setSessionProvider('openai')
    resetModelStringsForTestingOnly()
    expect(
      getAgentModel(undefined, 'gpt-5.6-sol', 'claude-opus-5' as never, 'default'),
    ).toBe('claude-opus-5')
    expect(getAgentModel('claude-opus-5', 'gpt-5.6-sol', undefined, 'default')).toBe(
      'claude-opus-5',
    )
  })
})
