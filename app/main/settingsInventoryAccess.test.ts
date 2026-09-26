import { expect, test } from 'bun:test'
import { resolveSettingsInventoryCwd, settingsWriteMatchesScope } from './settingsInventoryAccess.js'

const known = new Set(['/known/project'])
const validate = (cwd: string) =>
  cwd === '/known/project' || cwd === '/home/user'
    ? { ok: true as const, realpath: cwd }
    : { ok: false as const }

test('settings inventory accepts home and a known project without a session', () => {
  expect(resolveSettingsInventoryCwd(null, '/home/user', known, validate)).toBe('/home/user')
  expect(resolveSettingsInventoryCwd('/known/project', '/home/user', known, validate)).toBe('/known/project')
})

test('settings inventory refuses renderer-authored and stale paths', () => {
  expect(resolveSettingsInventoryCwd('/private/secret', '/home/user', known, validate)).toBeNull()
  expect(resolveSettingsInventoryCwd('/known/project/', '/home/user', known, validate)).toBeNull()
  expect(resolveSettingsInventoryCwd(123, '/home/user', known, validate)).toBeNull()
  expect(resolveSettingsInventoryCwd('/known/project', '/gone', known, () => ({ ok: false }))).toBeNull()
})

test('durable setting writes keep user and project targets separate', () => {
  expect(settingsWriteMatchesScope('userSettings', null)).toBe(true)
  expect(settingsWriteMatchesScope('userSettings', '/known/project')).toBe(false)
  expect(settingsWriteMatchesScope('projectSettings', null)).toBe(false)
  expect(settingsWriteMatchesScope('localSettings', null)).toBe(false)
  expect(settingsWriteMatchesScope('projectSettings', '/known/project')).toBe(true)
  expect(settingsWriteMatchesScope('localSettings', '/known/project')).toBe(true)
})
