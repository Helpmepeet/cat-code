import { expect, test } from 'bun:test'
import { userSettingsWithDefaultPermissionMode } from './configPermissionSettings.js'

test('default-mode updater preserves the current user-scoped permission rules', () => {
  const current = {
    permissions: {
      allow: ['Bash(git status)'],
      deny: ['Read(.env)'],
    },
    outputStyle: 'concise',
  }

  expect(userSettingsWithDefaultPermissionMode('plan')(current)).toEqual({
    permissions: {
      allow: ['Bash(git status)'],
      deny: ['Read(.env)'],
      defaultMode: 'plan',
    },
    outputStyle: 'concise',
  })
})
