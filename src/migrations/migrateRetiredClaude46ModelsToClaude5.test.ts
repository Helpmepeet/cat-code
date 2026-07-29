import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SettingsJson } from '../utils/settings/types.js'

let userSettings: SettingsJson | null = null
let updateCalls: Array<Partial<SettingsJson>> = []
let mainLoopOverride: string | undefined
let mainLoopOverrideWrites: Array<string | undefined> = []
let provider = 'firstParty'

const actualSettings = await import('../utils/settings/settings.js')
mock.module('../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => userSettings ?? {},
  getSettingsForSource: () => userSettings,
  updateSettingsForSource: (
    _source: string,
    patch: Partial<SettingsJson>,
  ) => {
    updateCalls.push(patch)
    if (userSettings) {
      const mergedOverrides = patch.modelOverrides
        ? Object.fromEntries(
            Object.entries({
              ...userSettings.modelOverrides,
              ...patch.modelOverrides,
            }).filter(([, value]) => value !== undefined),
          )
        : userSettings.modelOverrides
      userSettings = {
        ...userSettings,
        ...patch,
        ...(patch.modelOverrides ? { modelOverrides: mergedOverrides } : {}),
      }
    }
    return { error: null }
  },
}))

const actualState = await import('../bootstrap/state.js')
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getMainLoopModelOverride: () => mainLoopOverride,
  setMainLoopModelOverride: (model: string | undefined) => {
    mainLoopOverrideWrites.push(model)
    mainLoopOverride = model
  },
}))

const actualProviders = await import('../utils/model/providers.js')
mock.module('../utils/model/providers.js', () => ({
  ...actualProviders,
  getAPIProvider: () => provider,
}))

const { migrateRetiredClaude46ModelsToClaude5 } = await import(
  './migrateRetiredClaude46ModelsToClaude5.js'
)
const {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  parseUserSpecifiedModel,
} = await import('../utils/model/model.js')

const ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
] as const
const envSnapshot = new Map<string, string | undefined>()

beforeEach(() => {
  userSettings = null
  updateCalls = []
  mainLoopOverride = undefined
  mainLoopOverrideWrites = []
  provider = 'firstParty'
  for (const key of ENV_KEYS) {
    envSnapshot.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  envSnapshot.clear()
  mock.restore()
})

describe('migrateRetiredClaude46ModelsToClaude5', () => {
  test('remaps every first-party user-owned model surface without overwriting a current override', () => {
    userSettings = {
      model: 'claude-sonnet-4-6[1m]',
      availableModels: [
        'claude-sonnet-4-6',
        'claude-sonnet-5',
        'claude-opus-4-6',
        'claude-fable-5',
      ],
      modelOverrides: {
        'claude-sonnet-4-6': 'legacy-sonnet-override',
        'claude-sonnet-5': 'keep-current-sonnet-override',
        'claude-opus-4-6': 'legacy-opus-override',
      },
    }
    mainLoopOverride = 'claude-opus-4-6[1m]'

    migrateRetiredClaude46ModelsToClaude5()
    migrateRetiredClaude46ModelsToClaude5()

    expect(updateCalls).toEqual([
      {
        model: 'claude-sonnet-5',
        availableModels: [
          'claude-sonnet-5',
          'claude-opus-5',
          'claude-fable-5',
        ],
        modelOverrides: {
          'claude-sonnet-4-6': undefined,
          'claude-sonnet-5': 'keep-current-sonnet-override',
          'claude-opus-4-6': undefined,
          'claude-opus-5': 'legacy-opus-override',
        },
      },
    ])
    expect(mainLoopOverrideWrites).toEqual(['claude-opus-5'])
    expect(mainLoopOverride).toBe('claude-opus-5')
  })

  test('remaps direct first-party pins at runtime but preserves third-party 4.6 pins', () => {
    expect(parseUserSpecifiedModel('claude-sonnet-4-6')).toBe('claude-sonnet-5')
    expect(parseUserSpecifiedModel('claude-opus-4-6[1m]')).toBe('claude-opus-5')

    provider = 'bedrock'
    expect(parseUserSpecifiedModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('remaps old first-party default-model environment pins', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6[1m]'

    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5')
    expect(getDefaultOpusModel()).toBe('claude-opus-5')
  })
})

test('startup wiring tripwire keeps the Claude 4.6 retirement migration active', () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL('../main.tsx', import.meta.url)),
    'utf8',
  )

  expect(mainSource).toContain(
    "import { migrateRetiredClaude46ModelsToClaude5 } from './migrations/migrateRetiredClaude46ModelsToClaude5.js';",
  )
  const runMigrations = mainSource.slice(mainSource.indexOf('function runMigrations'))
  expect(runMigrations).toContain('migrateRetiredClaude46ModelsToClaude5();')
})
