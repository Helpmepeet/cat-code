import { describe, expect, test } from 'bun:test'
import { selectSettingsSearchResults } from './settingsSearch.js'

describe('settings search', () => {
  test('transcript mode is searchable by transcript, collapse and updates', () => {
    for (const query of ['transcript', 'collapse', 'updates', 'focused']) {
      expect(selectSettingsSearchResults(query, 'project')).toContainEqual(
        expect.objectContaining({ key: 'transcriptMode', category: 'appearance', scope: 'app', label: 'Transcript' }),
      )
    }
  })
  test('notification controls route to Appearance with app scope', () => {
    expect(selectSettingsSearchResults('notifications', 'project').map(result => [result.key, result.category, result.scope]))
      .toEqual([['notify', 'appearance', 'app'], ['dockBadge', 'appearance', 'app']])
  })
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

  test('finds Remote and Diagnostics actions with their real scope', () => {
    expect(selectSettingsSearchResults('bridge', 'project')).toEqual([
      expect.objectContaining({ key: 'remoteBridge', category: 'remote', scopeLabel: 'This session' }),
    ])
    expect(selectSettingsSearchResults('server URL', 'user')).toEqual([
      expect.objectContaining({ key: 'remoteDirectConnect', category: 'remote', scopeLabel: 'This session' }),
    ])
    expect(selectSettingsSearchResults('logs', 'user')).toEqual([
      expect.objectContaining({ key: 'openLogs', category: 'diagnostics', scopeLabel: 'This app' }),
    ])
    expect(selectSettingsSearchResults('skills', 'project')[0]).toEqual(
      expect.objectContaining({ category: 'skills', scopeLabel: 'All sources' }),
    )
  })
})
