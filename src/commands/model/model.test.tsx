import { afterEach, describe, expect, test } from 'bun:test'

import { setSessionProvider } from '../../bootstrap/state.js'
import { reconcileModelSelectionState } from './model.js'

describe('/model state reconciliation', () => {
  afterEach(() => {
    setSessionProvider(null)
  })

  test('clears an incompatible raw effort when selecting a Claude model', () => {
    setSessionProvider('firstParty')
    expect(
      reconcileModelSelectionState(
        {
          marker: 'preserved',
          effortValue: 'ultra' as const,
        },
        'claude-sonnet-4-6',
      ),
    ).toEqual({
      marker: 'preserved',
      mainLoopModel: 'claude-sonnet-4-6',
      mainLoopModelForSession: null,
      effortValue: undefined,
    })
  })

  test('preserves a raw effort supported by the selected GPT model', () => {
    setSessionProvider('openai')
    expect(
      reconcileModelSelectionState(
        { effortValue: 'ultra' as const },
        'gpt-5.6-terra',
      ).effortValue,
    ).toBe('ultra')
  })
})
