import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettingsInventoryCwd, settingsInventoryScopeArgs, settingsWriteMatchesScope } from './settingsInventoryAccess.js'

const known = new Set(['/known/project'])
const configRoot = '/home/user/.cat-code'
const validate = (cwd: string) =>
  cwd === '/known/project' || cwd === '/home/user'
    ? { ok: true as const, realpath: cwd }
    : { ok: false as const }

test('settings inventory accepts home and a known project without a session', () => {
  expect(resolveSettingsInventoryCwd(null, '/home/user', known, validate, configRoot)).toBe('/home/user')
  expect(resolveSettingsInventoryCwd('/known/project', '/home/user', known, validate, configRoot)).toBe('/known/project')
})

test('settings inventory refuses renderer-authored and stale paths', () => {
  expect(resolveSettingsInventoryCwd('/private/secret', '/home/user', known, validate, configRoot)).toBeNull()
  expect(resolveSettingsInventoryCwd('/known/project/', '/home/user', known, validate, configRoot)).toBeNull()
  expect(resolveSettingsInventoryCwd(123, '/home/user', known, validate, configRoot)).toBeNull()
  expect(resolveSettingsInventoryCwd('/known/project', '/gone', known, () => ({ ok: false }), configRoot)).toBeNull()
})

test('a known project cannot target the user settings file, including with a custom config root', () => {
  const withHome = new Set(['/home/user', '/known/project'])
  expect(resolveSettingsInventoryCwd('/home/user', '/home/user', withHome, validate, configRoot)).toBeNull()
  expect(resolveSettingsInventoryCwd(null, '/home/user', withHome, validate, configRoot)).toBe('/home/user')
  expect(settingsInventoryScopeArgs(null)).toEqual(['--user-settings-scope'])
  expect(settingsInventoryScopeArgs('/home/user')).toEqual([])
  expect(resolveSettingsInventoryCwd('/home/user', '/home/user', withHome, validate, '/other/config')).toBe('/home/user')
  expect(resolveSettingsInventoryCwd('/known/project', '/home/user', withHome, validate, '/known/project/.cat-code')).toBeNull()
  expect(resolveSettingsInventoryCwd('/known/project', '/home/user', withHome, validate, '.cat-code')).toBeNull()
})

test('symlinked config roots cannot alias a known project settings file', () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-settings-alias-'))
  const project = join(root, 'project')
  const linkedConfig = join(root, 'config')
  try {
    mkdirSync(join(project, '.cat-code'), { recursive: true })
    symlinkSync(join(project, '.cat-code'), linkedConfig)
    expect(resolveSettingsInventoryCwd(
      project,
      root,
      new Set([project]),
      () => ({ ok: true, realpath: project }),
      linkedConfig,
    )).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('durable setting writes keep user and project targets separate', () => {
  expect(settingsWriteMatchesScope('userSettings', null)).toBe(true)
  expect(settingsWriteMatchesScope('userSettings', '/known/project')).toBe(false)
  expect(settingsWriteMatchesScope('projectSettings', null)).toBe(false)
  expect(settingsWriteMatchesScope('localSettings', null)).toBe(false)
  expect(settingsWriteMatchesScope('projectSettings', '/known/project')).toBe(true)
  expect(settingsWriteMatchesScope('localSettings', '/known/project')).toBe(true)
})
