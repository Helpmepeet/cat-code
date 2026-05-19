import { describe, expect, test } from 'bun:test'

import type { ToolPermissionContext } from '../../Tool.js'
import { generateSuggestions } from './filesystem.js'

function basePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  }
}

describe('generateSuggestions', () => {
  test('suggests persistent read rules for outside working directories', () => {
    const suggestions = generateSuggestions(
      '/tmp/cat-code-permissions/example.txt',
      'read',
      basePermissionContext(),
    )

    const readRuleSuggestions = suggestions.filter(
      suggestion => suggestion.type === 'addRules',
    )
    expect(readRuleSuggestions.length).toBeGreaterThan(0)
    expect(
      readRuleSuggestions.every(
        suggestion => suggestion.destination === 'localSettings',
      ),
    ).toBe(true)
  })

  test('suggests persistent directory access for outside writes while keeping mode changes session-scoped', () => {
    const suggestions = generateSuggestions(
      '/tmp/cat-code-permissions/example.txt',
      'write',
      basePermissionContext(),
    )

    expect(suggestions).toContainEqual({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    })
    const directorySuggestion = suggestions.find(
      suggestion => suggestion.type === 'addDirectories',
    )
    expect(directorySuggestion).toMatchObject({
      type: 'addDirectories',
      destination: 'localSettings',
    })
    expect(directorySuggestion?.directories).toContain(
      '/tmp/cat-code-permissions',
    )
  })
})
