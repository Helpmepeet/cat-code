import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSettingsFileAtomically } from './settings.js'

const scratchDirectories: string[] = []

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
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
