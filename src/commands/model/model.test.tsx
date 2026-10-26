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
        { effortValue: 'max' as const },
        'gpt-6.1-terra',
      ).effortValue,
    ).toBe('max')
  })

  test('new selections cannot restore a retired Terra model or its ultra effort', () => {
    setSessionProvider('openai')
    expect(reconcileModelSelectionState(
      { effortValue: 'ultra' as const }, 'gpt-5.6-terra',
    )).toEqual({
      mainLoopModel: 'gpt-6.1-terra',
      mainLoopModelForSession: null,
      effortValue: undefined,
    })
  })

  // Picking the Default row after choosing an effort dropped the effort:
  // ModelPicker had already written it to settings.json and to app state, and
  // the confirmation line still said "with low effort", so the session ran on
  // the model default while disk said otherwise and the level reappeared next
  // launch. There is no model to reconcile against here.
  test('keeps the chosen effort when selecting the Default row', () => {
    setSessionProvider('openai')
    expect(
      reconcileModelSelectionState({ effortValue: 'low' as const }, null),
    ).toEqual({
      mainLoopModel: null,
      mainLoopModelForSession: null,
      effortValue: 'low',
    })
  })
})
