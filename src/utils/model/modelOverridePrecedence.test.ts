import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOriginalCwd,
  getSessionProvider,
  resetModelStringsForTestingOnly,
  setOriginalCwd,
  setSessionProvider,
} from '../../bootstrap/state.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { getDefaultCodexModel } from './model.js'
import { getModelStrings } from './modelStrings.js'

test('legacy model override keys keep source precedence and leave settings files intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-code-model-overrides-'))
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalCwd = getOriginalCwd()
  const originalProvider = getSessionProvider()
  try {
    const userDir = join(directory, 'user')
    const projectDir = join(directory, 'workspace')
    const projectSettingsDir = join(projectDir, '.cat-code')
    mkdirSync(userDir)
    mkdirSync(projectSettingsDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = userDir
    setOriginalCwd(projectDir)
    setSessionProvider('openai')
    resetModelStringsForTestingOnly()
    resetSettingsCache()

    writeFileSync(join(userDir, 'settings.json'), JSON.stringify({
      modelOverrides: { 'gpt-6.2-sol': 'gpt-6-luna' },
    }))
    const projectSettingsPath = join(projectSettingsDir, 'settings.json')
    const projectSettings = JSON.stringify({
      modelOverrides: {
        'gpt-6.1-sol': 'gpt-6.1-terra',
        'gpt-6-astra': 'gpt-6-luna',
        'gpt-6.2-astra': 'gpt-6.2-sol',
      },
    })
    writeFileSync(projectSettingsPath, projectSettings)

    expect(getDefaultCodexModel()).toBe('gpt-6.1-terra')
    expect(getModelStrings().gpt62astra).toBe('gpt-6.2-sol')
    expect(readFileSync(projectSettingsPath, 'utf8')).toBe(projectSettings)
  } finally {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    setOriginalCwd(originalCwd)
    setSessionProvider(originalProvider)
    resetModelStringsForTestingOnly()
    resetSettingsCache()
    rmSync(directory, { recursive: true, force: true })
  }
})
