import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSettingsFile, updateSettingsForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

const scratchDirectories: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  resetSettingsCache()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Each case gets its own directory so the per-path parse cache never serves
 * one test's result to another.
 */
function parseFixture(contents: string): ReturnType<typeof parseSettingsFile> {
  const directory = mkdtempSync(join(tmpdir(), 'settings-section-tolerance-'))
  scratchDirectories.push(directory)
  const settingsPath = join(directory, 'settings.json')
  writeFileSync(settingsPath, contents)
  return parseSettingsFile(settingsPath)
}

test('keeps the valid sections when one section has the wrong type', () => {
  const { settings, errors } = parseFixture(
    '{"model":"opus","env":{"A":"b"},"hooks":{"PreToolUse":"not-an-array"}}',
  )

  expect(settings).toEqual({ model: 'opus', env: { A: 'b' } })
  expect(errors.map(error => error.path)).toEqual(['hooks'])
})

test('keeps the valid sections when one section has an invalid enum value', () => {
  const { settings, errors } = parseFixture(
    '{"model":"opus","permissions":{"defaultMode":"bogus"}}',
  )

  expect(settings).toEqual({ model: 'opus' })
  expect(errors.map(error => error.path)).toEqual(['permissions'])
})

test('names the rejected section and its reason in the reported error', () => {
  const { errors } = parseFixture(
    '{"model":"opus","hooks":{"PreToolUse":"not-an-array"}}',
  )

  expect(errors).toHaveLength(1)
  expect(errors[0]!.message).toBe(
    'Ignored the "hooks" settings because PreToolUse: Expected array, but ' +
      'received string. Fix it to turn them back on.',
  )
  expect(errors[0]!.file).toContain('settings.json')
})

test('parses a fully valid file unchanged and reports nothing', () => {
  const { settings, errors } = parseFixture(
    '{"model":"opus","env":{"A":"b"},"permissions":{"allow":["Bash(ls:*)"],"defaultMode":"acceptEdits"}}',
  )

  expect(settings).toEqual({
    model: 'opus',
    env: { A: 'b' },
    permissions: { allow: ['Bash(ls:*)'], defaultMode: 'acceptEdits' },
  })
  expect(errors).toEqual([])
})

test('returns empty settings, not null, when the only section is malformed', () => {
  const { settings, errors } = parseFixture(
    '{"hooks":{"PreToolUse":"not-an-array"}}',
  )

  expect(settings).toEqual({})
  expect(errors.map(error => error.path)).toEqual(['hooks'])
})

test('still rejects the whole file when no single section is at fault', () => {
  const { settings, errors } = parseFixture('[1,2,3]')

  expect(settings).toBeNull()
  expect(errors.map(error => error.path)).toEqual([''])
})

/**
 * Points userSettings at a throwaway config directory so the write tests never
 * touch the real one, and returns the settings path they operate on.
 */
function useScratchUserSettings(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'settings-section-write-'))
  scratchDirectories.push(directory)
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const settingsPath = join(directory, 'settings.json')
  writeFileSync(settingsPath, contents)
  return settingsPath
}

test('a write keeps a malformed section it was not asked to touch', () => {
  const settingsPath = useScratchUserSettings(
    '{"model":"opus","hooks":{"PreToolUse":"not-an-array"}}\n',
  )

  const { error } = updateSettingsForSource('userSettings', { model: 'sonnet' })

  expect(error).toBeNull()
  const written = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(written.model).toBe('sonnet')
  expect(written.hooks).toEqual({ PreToolUse: 'not-an-array' })
})

test('a write still drops invalid permission rules, as it did before', () => {
  const settingsPath = useScratchUserSettings(
    '{"model":"opus","permissions":{"allow":["Bash(ls:*)","NotARule((("]}}\n',
  )

  const { error } = updateSettingsForSource('userSettings', { model: 'sonnet' })

  expect(error).toBeNull()
  const written = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(written.model).toBe('sonnet')
  expect(written.permissions).toEqual({ allow: ['Bash(ls:*)'] })
})
