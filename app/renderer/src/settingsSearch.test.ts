import { describe, expect, test } from 'bun:test'
import { selectSettingsSearchResults } from './settingsSearch.js'

describe('settings search', () => {
  test('finds a control outside the current scope and routes to its owner', () => {
    expect(selectSettingsSearchResults('code theme', 'project')).toEqual([
      expect.objectContaining({
        key: 'codeTheme',
        category: 'appearance',
        scope: 'app',
        label: 'Code theme',
        scopeLabel: 'This app',
        kind: 'setting',
      }),
    ])
    expect(selectSettingsSearchResults('accent', 'user')).toEqual([
      expect.objectContaining({ key: 'accent', category: 'appearance', scope: 'app' }),
    ])
  })

  test('engine results keep the chosen file scope and point to real setting keys', () => {
    expect(selectSettingsSearchResults('default model', 'project')[0]).toEqual(
      expect.objectContaining({ key: 'model', category: 'model', scope: 'project' }),
    )
    expect(selectSettingsSearchResults('retention', 'user')).toEqual([
      expect.objectContaining({ key: 'cleanupPeriodDays', category: 'privacy', scope: 'user' }),
    ])
    expect(selectSettingsSearchResults('output style', 'user')).toEqual([
      expect.objectContaining({ key: 'outputStyle', category: 'general', scope: 'user' }),
    ])
  })

  test('uses descriptions and all query words, then returns no phantom rows', () => {
    expect(selectSettingsSearchResults('file picker', 'user').map(result => result.key))
      .toEqual(['respectGitignore'])
    expect(selectSettingsSearchResults('theme code', 'user').map(result => result.key))
      .toEqual(['codeTheme'])
    expect(selectSettingsSearchResults('unfindable setting', 'user')).toEqual([])
    expect(selectSettingsSearchResults('  ', 'user')).toEqual([])
  })
})
