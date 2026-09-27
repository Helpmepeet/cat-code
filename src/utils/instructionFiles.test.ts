import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../bootstrap/state.js'
import {
  DEFAULT_INSTRUCTION_FILES_MODE,
  INSTRUCTION_FILES_MODE_LABELS,
  INSTRUCTION_FILES_MODES,
  getInstructionFilesSetting,
  resolveInstructionFilesSetting,
  updateUserInstructionFilesOption,
} from './instructionFiles.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from './settings/managedPath.js'
import {
  getSettingsForSource,
  loadManagedFileSettings,
} from './settings/settings.js'
import { parseCommandOutputAsSettings } from './settings/mdm/settings.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import type { SettingsJson } from './settings/types.js'

const originalSources = getAllowedSettingSources()
const originalFlagSettingsInline = getFlagSettingsInline()
const originalFlagSettingsPath = getFlagSettingsPath()
const originalEnv = {
  home: process.env.HOME,
  configDir: process.env.CLAUDE_CONFIG_DIR,
  managedSettingsPath: process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH,
  userType: process.env.USER_TYPE,
  nodeEnv: process.env.NODE_ENV,
}
const scratchDirectories: string[] = []

afterEach(() => {
  setAllowedSettingSources(originalSources)
  setFlagSettingsInline(originalFlagSettingsInline)
  setFlagSettingsPath(originalFlagSettingsPath)
  getManagedFilePath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  resetSettingsCache()
  for (const [name, value] of [
    ['HOME', originalEnv.home],
    ['CLAUDE_CONFIG_DIR', originalEnv.configDir],
    ['CLAUDE_CODE_MANAGED_SETTINGS_PATH', originalEnv.managedSettingsPath],
    ['USER_TYPE', originalEnv.userType],
    ['NODE_ENV', originalEnv.nodeEnv],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function settingsWithMode(value: unknown): SettingsJson {
  return {
    pluginConfigs: {
      'agents-md@builtin': {
        options: { instructionFiles: value as string },
      },
    },
  } as SettingsJson
}

function resolve({
  userSettings,
  userSettingsEnabled = true,
  flagSettings = null,
  policySettings = null,
}: {
  userSettings?: SettingsJson | null
  userSettingsEnabled?: boolean
  flagSettings?: SettingsJson | null
  policySettings?: SettingsJson | null
} = {}) {
  return resolveInstructionFilesSetting({
    userSettings: userSettings ?? null,
    userSettingsEnabled,
    flagSettings,
    policySettings,
  })
}

test('defaults to CLAUDE.md or AGENTS.md and accepts every supported mode', () => {
  expect(resolve().mode).toBe(DEFAULT_INSTRUCTION_FILES_MODE)
  expect(Object.values(INSTRUCTION_FILES_MODE_LABELS)).toEqual([
    'CLAUDE.md or AGENTS.md',
    'CLAUDE.md only',
    'CLAUDE.md and AGENTS.md',
    'Managed instructions only',
  ])

  for (const mode of INSTRUCTION_FILES_MODES) {
    expect(resolve({ userSettings: settingsWithMode(mode) })).toEqual({
      mode,
      source: 'userSettings',
    })
  }
})

test('ignores disabled user settings and does not let project settings own the option', () => {
  expect(
    resolve({
      userSettings: settingsWithMode('claude-md'),
      userSettingsEnabled: false,
    }),
  ).toEqual({ mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'default' })

  // The resolver has no project/local inputs by design. Only the user-owned,
  // flag, and policy sources are passed to it.
  expect(resolve()).toEqual({
    mode: DEFAULT_INSTRUCTION_FILES_MODE,
    source: 'default',
  })
})

test('flag and policy override lower sources, and an invalid winner defaults without falling through', () => {
  expect(
    resolve({
      userSettings: settingsWithMode('claude-md'),
      flagSettings: settingsWithMode('claude-md-and-agents-md'),
    }),
  ).toEqual({ mode: 'claude-md-and-agents-md', source: 'flagSettings' })

  expect(
    resolve({
      userSettings: settingsWithMode('claude-md'),
      flagSettings: settingsWithMode('claude-md-and-agents-md'),
      policySettings: settingsWithMode('managed-only'),
    }),
  ).toEqual({ mode: 'managed-only', source: 'policySettings' })

  expect(
    resolve({
      userSettings: settingsWithMode('claude-md'),
      flagSettings: settingsWithMode('not-a-mode'),
    }),
  ).toEqual({
    mode: DEFAULT_INSTRUCTION_FILES_MODE,
    source: 'flagSettings',
  })
})

test('reads user mode from the isolated user settings source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'instruction-files-settings-'))
  scratchDirectories.push(directory)
  const home = join(directory, 'home')
  const configDir = join(directory, 'config')
  const managedDir = join(directory, 'managed')
  mkdirSync(home)
  mkdirSync(configDir)
  mkdirSync(managedDir)
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'ant'
  setAllowedSettingSources(['userSettings'])
  getManagedSettingsDropInDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify(settingsWithMode('claude-md')),
  )
  resetSettingsCache()

  expect(getInstructionFilesSetting()).toEqual({
    mode: 'claude-md',
    source: 'userSettings',
  })
})

test('updates and reverts only the builtin instruction option', () => {
  const directory = mkdtempSync(join(tmpdir(), 'instruction-files-write-'))
  scratchDirectories.push(directory)
  const home = join(directory, 'home')
  const configDir = join(directory, 'config')
  const managedDir = join(directory, 'managed')
  mkdirSync(home)
  mkdirSync(configDir)
  mkdirSync(managedDir)
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'ant'
  setAllowedSettingSources(['userSettings'])
  getManagedSettingsDropInDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()

  const originalSettings = {
    permissions: { allow: ['Read(*)'] },
    pluginConfigs: {
      'agents-md@builtin': {
        mcpServers: { local: { command: 'test-server' } },
        options: { keep: 'sibling', instructionFiles: 'claude-md' },
      },
      'another@builtin': {
        options: { keep: 'other-plugin' },
      },
    },
  }
  const settingsPath = join(configDir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(originalSettings))
  resetSettingsCache()

  expect(
    updateUserInstructionFilesOption('claude-md-and-agents-md').error,
  ).toBeNull()

  const updated = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(updated).toEqual({
    ...originalSettings,
    pluginConfigs: {
      ...originalSettings.pluginConfigs,
      'agents-md@builtin': {
        ...originalSettings.pluginConfigs['agents-md@builtin'],
        options: {
          ...originalSettings.pluginConfigs['agents-md@builtin'].options,
          instructionFiles: 'claude-md-and-agents-md',
        },
      },
    },
  })

  expect(updateUserInstructionFilesOption(undefined).error).toBeNull()
  const cleared = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(cleared.pluginConfigs['agents-md@builtin']).toEqual({
    mcpServers: { local: { command: 'test-server' } },
    options: { keep: 'sibling' },
  })
  expect(updateUserInstructionFilesOption('claude-md').error).toBeNull()
  const reverted = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(reverted).toEqual(originalSettings)
})

test('schema-rejected flag and policy options remain present and select the default', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'instruction-files-invalid-source-'),
  )
  scratchDirectories.push(directory)
  const home = join(directory, 'home')
  const configDir = join(directory, 'config')
  const managedDir = join(directory, 'managed')
  for (const path of [home, configDir, managedDir]) mkdirSync(path)
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'ant'
  setAllowedSettingSources(['userSettings'])
  setFlagSettingsInline(null)
  const invalidOption = {
    pluginConfigs: {
      'agents-md@builtin': {
        options: { instructionFiles: { invalid: true } },
      },
    },
  } as unknown as SettingsJson
  const userSettings = settingsWithMode('claude-md')
  const flagPath = join(directory, 'flag-settings.json')
  writeFileSync(flagPath, JSON.stringify(invalidOption))
  setFlagSettingsPath(flagPath)
  getManagedFilePath.cache.clear?.()
  getManagedFilePath.cache.set(undefined, managedDir)
  getManagedSettingsDropInDir.cache.clear?.()
  resetSettingsCache()

  const flagFileSettings = getSettingsForSource('flagSettings')
  expect(
    resolve({
      userSettings,
      flagSettings: flagFileSettings,
      policySettings: null,
    }),
  ).toEqual({ mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'flagSettings' })

  setFlagSettingsPath(undefined)
  setFlagSettingsInline(invalidOption)
  resetSettingsCache()
  const inlineFlagSettings = getSettingsForSource('flagSettings')
  expect(
    resolve({
      userSettings,
      flagSettings: inlineFlagSettings,
      policySettings: null,
    }),
  ).toEqual({ mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'flagSettings' })

  setFlagSettingsInline(null)
  writeFileSync(
    join(managedDir, 'managed-settings.json'),
    JSON.stringify(invalidOption),
  )
  resetSettingsCache()
  const { settings: policySettings } = loadManagedFileSettings()
  expect(
    resolve({
      userSettings,
      flagSettings: null,
      policySettings,
    }),
  ).toEqual({ mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'policySettings' })

  const mdmSettings = parseCommandOutputAsSettings(
    JSON.stringify(invalidOption),
    'isolated MDM fixture',
  ).settings
  expect(
    resolve({
      userSettings,
      flagSettings: null,
      policySettings: mdmSettings,
    }),
  ).toEqual({ mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'policySettings' })
})
