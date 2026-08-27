import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SettingsUpdater } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

let userSettings: SettingsJson | null = null
let updateCalls: Array<Partial<SettingsJson>> = []
let mainLoopOverride: string | undefined
let mainLoopOverrideWrites: Array<string | undefined> = []
let provider = 'firstParty'
let updateError: Error | null = null

const actualSettings = await import('../utils/settings/settings.js')
mock.module('../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => userSettings ?? {},
  getSettingsForSource: () => userSettings,
  updateSettingsForSource: (
    _source: string,
    patch: SettingsJson | SettingsUpdater,
  ) => {
    if (updateError) return { error: updateError }
    if (typeof patch === 'function') {
      const next = patch(userSettings)
      if (next) {
        updateCalls.push(next)
        userSettings = next
      }
      return { error: null }
    }
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
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
] as const
const envSnapshot = new Map<string, string | undefined>()

beforeEach(() => {
  userSettings = null
  updateCalls = []
  mainLoopOverride = undefined
  mainLoopOverrideWrites = []
  provider = 'firstParty'
  updateError = null
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
  test('reports a settings-write error so startup keeps the migration pending', () => {
    userSettings = { model: 'claude-sonnet-4-6' }
    updateError = new Error('settings lock unavailable')

    expect(migrateRetiredClaude46ModelsToClaude5()).toBe(updateError)
    expect(mainLoopOverrideWrites).toEqual([])
  })

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
          'claude-sonnet-5': 'keep-current-sonnet-override',
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

  // Regression for the startup-vs-setSessionProvider ordering bug: engine migrations
  // run from init before setSessionProvider() ever settles the session provider, so
  // getAPIProvider() at migration time falls back to whatever the
  // *persisted* lastUsedProvider preference resolves to. Gating the migration itself on
  // that made it a permanent no-op for anyone whose last session used Codex/OpenAI, since
  // the migration's version bump still fires unconditionally and it never runs again.
  test('runs the migration even when the current/persisted provider is not firstParty', () => {
    provider = 'openai'
    userSettings = {
      model: 'claude-opus-4-6',
      availableModels: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      modelOverrides: {
        'claude-opus-4-6': 'my-endpoint-id',
      },
    }

    migrateRetiredClaude46ModelsToClaude5()

    expect(updateCalls).toEqual([
      {
        model: 'claude-opus-5',
        availableModels: ['claude-opus-5', 'claude-sonnet-5'],
        modelOverrides: {
          'claude-opus-5': 'my-endpoint-id',
        },
      },
    ])
  })

  // Regression for the migration's substring canonicalization rewriting namespaced/proxy
  // ids: a gateway can route on a prefix like 'anthropic/claude-sonnet-4-6', and the
  // substring match that correctly resolves dated snapshots would otherwise also match
  // the retired id embedded in that namespaced string and clobber the prefix on disk.
  test('does not rewrite a namespaced model id when ANTHROPIC_BASE_URL points at a custom gateway', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'
    userSettings = {
      model: 'anthropic/claude-sonnet-4-6',
    }

    migrateRetiredClaude46ModelsToClaude5()

    expect(updateCalls).toEqual([])
    expect(userSettings.model).toBe('anthropic/claude-sonnet-4-6')
  })

  // The substring canonicalization itself is correct and required for dated snapshot ids
  // (e.g. claude-opus-4-6-20260101) — only the gateway-namespaced case above should be
  // excluded. Pins against the default (unset) ANTHROPIC_BASE_URL.
  test('still remaps a dated first-party snapshot id when no gateway is configured', () => {
    userSettings = {
      model: 'claude-opus-4-6-20260101',
    }

    migrateRetiredClaude46ModelsToClaude5()

    expect(updateCalls).toEqual([{ model: 'claude-opus-5' }])
  })

  // The migration must not lose the existing "third-party providers keep their 4.6
  // identifiers" protection just because it stops depending on the (ordering-unsafe)
  // session provider: a Bedrock-shaped ARN pin must not be rewritten to a bare Claude 5
  // id it can't route with.
  test('preserves a third-party-shaped 4.6 pin when a 3P provider is configured via env', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    userSettings = {
      model: 'us.anthropic.claude-opus-4-6-v1:0',
    }

    migrateRetiredClaude46ModelsToClaude5()

    expect(updateCalls).toEqual([])
    expect(userSettings.model).toBe('us.anthropic.claude-opus-4-6-v1:0')
  })
})

test('startup wiring tripwire keeps the Claude 4.6 retirement migration active', () => {
  const ownerSource = readFileSync(
    fileURLToPath(new URL('./runEngineMigrations.ts', import.meta.url)),
    'utf8',
  )
  const initSource = readFileSync(
    fileURLToPath(new URL('../entrypoints/init.ts', import.meta.url)),
    'utf8',
  )

  expect(ownerSource).toContain(
    "import { migrateRetiredClaude46ModelsToClaude5 } from './migrateRetiredClaude46ModelsToClaude5.js'",
  )
  expect(ownerSource).toContain(
    'const retiredClaudeError = migrateRetiredClaude46ModelsToClaude5()',
  )
  expect(ownerSource).toContain(
    'if (retiredClaudeError) return retiredClaudeError',
  )
  const gateIndex = ownerSource.indexOf('const needsVersionedMigrations')
  const callIndex = ownerSource.indexOf('const retiredClaudeError')
  const saveIndex = ownerSource.indexOf('saveGlobalConfig(')
  expect(gateIndex).toBeGreaterThanOrEqual(0)
  expect(callIndex).toBeGreaterThanOrEqual(0)
  expect(saveIndex).toBeGreaterThan(gateIndex)
  expect(initSource).toContain('await runEngineMigrations()')
})
