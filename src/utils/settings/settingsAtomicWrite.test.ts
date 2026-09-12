import { afterEach, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  updateSettingsForSource,
  writeSettingsFileAtomically,
} from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

const scratchDirectories: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  resetSettingsCache()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saving user settings preserves a relative symlink and updates its target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-symlink-write-'))
  scratchDirectories.push(directory)
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const targetDirectory = join(directory, 'dotfiles')
  mkdirSync(targetDirectory)
  const targetPath = join(targetDirectory, 'shared.json')
  const settingsPath = join(directory, 'settings.json')
  writeFileSync(targetPath, '{"model":"sonnet","env":{"KEEP":"yes"}}\n')
  symlinkSync('dotfiles/shared.json', settingsPath)

  const { error } = updateSettingsForSource('userSettings', { model: 'opus' })

  expect(error).toBeNull()
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  expect(readlinkSync(settingsPath)).toBe('dotfiles/shared.json')
  expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({
    model: 'opus',
    env: { KEEP: 'yes' },
  })
  expect(readdirSync(targetDirectory)).toEqual(['shared.json'])
})

test('a settings save creates a missing symlink target without replacing the link', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-symlink-missing-'))
  scratchDirectories.push(directory)
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const settingsPath = join(directory, 'settings.json')
  const targetPath = join(directory, 'shared.json')
  symlinkSync(targetPath, settingsPath)

  const { error } = updateSettingsForSource('userSettings', { model: 'opus' })

  expect(error).toBeNull()
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({ model: 'opus' })
})

test('an unresolved symlink target returns an error and leaves the link intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-symlink-invalid-'))
  scratchDirectories.push(directory)
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const settingsPath = join(directory, 'settings.json')
  symlinkSync('missing-directory/settings.json', settingsPath)

  const { error } = updateSettingsForSource('userSettings', { model: 'opus' })

  expect(error).toBeInstanceOf(Error)
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  expect(readlinkSync(settingsPath)).toBe('missing-directory/settings.json')
  expect(readdirSync(directory)).toEqual(['settings.json'])
})

test.each(['file', 'symlink'] as const)(
  'a settings save rejects a %s destination retargeted after the locked read',
  originalKind => {
    const directory = mkdtempSync(join(tmpdir(), 'settings-symlink-retarget-'))
    scratchDirectories.push(directory)
    process.env.CLAUDE_CONFIG_DIR = directory
    resetSettingsCache()
    const settingsPath = join(directory, 'settings.json')
    const originalPath = join(directory, 'original-settings.json')
    const otherPath = join(directory, 'other-settings.json')
    const original = '{"env":{"ORIGINAL":"keep"}}\n'
    const other = '{"env":{"OTHER":"keep"}}\n'
    writeFileSync(otherPath, other)
    if (originalKind === 'file') {
      writeFileSync(settingsPath, original)
    } else {
      writeFileSync(originalPath, original)
      symlinkSync(originalPath, settingsPath)
    }

    const { error } = updateSettingsForSource('userSettings', current => {
      if (originalKind === 'file') renameSync(settingsPath, originalPath)
      else unlinkSync(settingsPath)
      symlinkSync(otherPath, settingsPath)
      return { ...current, model: 'opus' }
    })

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('target changed')
    expect(readFileSync(originalPath, 'utf8')).toBe(original)
    expect(readFileSync(otherPath, 'utf8')).toBe(other)
    expect(readlinkSync(settingsPath)).toBe(otherPath)
    expect(readdirSync(directory).sort()).toEqual([
      'original-settings.json', 'other-settings.json', 'settings.json',
    ])
  },
)

test('a missing target resolves parent traversal after directory symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-symlink-parent-'))
  scratchDirectories.push(directory)
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  mkdirSync(join(directory, 'dotfiles', 'nested'), { recursive: true })
  symlinkSync('dotfiles/nested', join(directory, 'directory-link'))
  const settingsPath = join(directory, 'settings.json')
  symlinkSync('directory-link/../shared.json', settingsPath)

  const { error } = updateSettingsForSource('userSettings', { model: 'opus' })

  expect(error).toBeNull()
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  expect(
    JSON.parse(readFileSync(join(directory, 'dotfiles', 'shared.json'), 'utf8')),
  ).toEqual({ model: 'opus' })
  expect(readFileSync(settingsPath, 'utf8')).toBe(
    readFileSync(join(directory, 'dotfiles', 'shared.json'), 'utf8'),
  )
})

test('replaces settings through a same-directory temp file without leftovers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-atomic-write-'))
  scratchDirectories.push(directory)
  const settingsPath = join(directory, 'settings.json')

  writeSettingsFileAtomically(settingsPath, '{"model":"first"}\n')
  writeSettingsFileAtomically(settingsPath, '{"model":"second"}\n')

  expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"second"}\n')
  expect(readdirSync(directory)).toEqual(['settings.json'])
})

test('cleans up its temp file when the final rename cannot replace a directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-atomic-write-'))
  scratchDirectories.push(directory)
  const destinationDirectory = join(directory, 'settings.json')
  mkdirSync(destinationDirectory)

  expect(() =>
    writeSettingsFileAtomically(destinationDirectory, '{"model":"next"}\n'),
  ).toThrow()
  expect(readdirSync(directory)).toEqual(['settings.json'])
})
