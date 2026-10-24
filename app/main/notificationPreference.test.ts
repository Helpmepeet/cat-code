import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_NOTIFICATION_PREFERENCES, parseNotificationPreferences } from '../shared/notificationPreferences.js'
import { readNotificationPreference, writeNotificationPreference } from './notificationPreference.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() {
  const path = mkdtempSync(join(tmpdir(), 'cat-code-notifications-'))
  roots.push(path)
  return path
}

test('accepts only the closed preference shape', () => {
  for (const notify of ['off', 'waiting', 'all'] as const) {
    for (const dockBadge of [true, false]) expect(parseNotificationPreferences({ notify, dockBadge })).toEqual({ notify, dockBadge })
  }
  for (const value of [null, [], true, {}, { notify: 'other', dockBadge: true }, { notify: 'all' }, { notify: 'all', dockBadge: 1 }, { notify: 'all', dockBadge: true, extra: false }]) {
    expect(parseNotificationPreferences(value)).toBeNull()
  }
})

test('defaults, round trips, and rejects invalid writes without replacing saved preferences', () => {
  const dir = root()
  expect(readNotificationPreference(dir)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  const value = { notify: 'waiting' as const, dockBadge: false }
  expect(writeNotificationPreference(dir, value)).toEqual(value)
  expect(readNotificationPreference(dir)).toEqual(value)
  expect(() => writeNotificationPreference(dir, { ...value, extra: true })).toThrow(TypeError)
  expect(readNotificationPreference(dir)).toEqual(value)
})

test('corrupt, unsupported and unreadable storage falls back without blocking', () => {
  const dir = root()
  for (const content of ['{', 'null', JSON.stringify({ version: 2, preferences: DEFAULT_NOTIFICATION_PREFERENCES }), JSON.stringify({ version: 1, preferences: { notify: 'all', dockBadge: 'true' } })]) {
    writeFileSync(join(dir, 'notification-preference.json'), content)
    expect(readNotificationPreference(dir)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  }
  const file = join(dir, 'not-a-directory')
  writeFileSync(file, '')
  expect(() => writeNotificationPreference(file, DEFAULT_NOTIFICATION_PREFERENCES)).not.toThrow()
  expect(readNotificationPreference(file)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
})
