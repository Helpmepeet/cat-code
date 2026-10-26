import { afterEach, describe, expect, test } from 'bun:test'

import { setSessionProvider } from '../bootstrap/state.js'
import { reconcileEffortForModel } from './effort.js'

describe('reconcileEffortForModel', () => {
  afterEach(() => {
    setSessionProvider(null)
  })

  test('preserves an effort supported by the selected GPT model', () => {
    setSessionProvider('openai')
    expect(reconcileEffortForModel('gpt-6.1-terra', 'max')).toBe('max')
  })

  test('clears retired Terra ultra effort when moving to its successor', () => {
    setSessionProvider('openai')
    expect(reconcileEffortForModel('gpt-6.1-terra', 'ultra')).toBeUndefined()
  })

  test('clears a GPT-only effort after switching to Claude', () => {
    setSessionProvider('firstParty')
    expect(reconcileEffortForModel('claude-sonnet-4-6', 'ultra')).toBeUndefined()
  })

  test('clears model-specific effort for provider-local Default', () => {
    setSessionProvider('firstParty')
    expect(reconcileEffortForModel(null, 'high')).toBeUndefined()
  })

  test('clears numeric token budgets on model changes', () => {
    setSessionProvider('firstParty')
    expect(reconcileEffortForModel('claude-sonnet-4-6', 8_000)).toBeUndefined()
  })
})
