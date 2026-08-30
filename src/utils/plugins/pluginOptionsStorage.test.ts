import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SettingsJson } from '../settings/types.js'

/**
 * TEST EVIDENCE
 * - Claim: a `sensitive: true` plugin option keeps its schema-declared type
 *   across a savePluginOptions -> loadPluginOptions round trip.
 * - Exact pre-fix failure: `sensitive[key] = String(value)` stored 42 as '42'
 *   and true as 'true', so getUnconfiguredOptions' validateUserConfig call
 *   reported the field as unconfigured and re-prompted forever.
 * - Production entry points: `savePluginOptions`, `loadPluginOptions`,
 *   `validateUserConfig`.
 * - Proof layer: module boundary. secureStorage and settings are faked, but
 *   both fakes serialize through JSON.parse(JSON.stringify(...)) — exactly what
 *   plainTextStorage and macOsKeychainStorage do — so a pass cannot come from
 *   holding a live object reference.
 * - UNVERIFIED: the real keychain / .credentials.json write, the real settings
 *   file, and the enable-time prompt flow.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

let secureStore: Record<string, unknown> | null = null
let settingsStore: SettingsJson = {}

function installMocks(): void {
  mock.module('../secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'test',
      read: () => (secureStore ? clone(secureStore) : null),
      update: (data: Record<string, unknown>) => {
        secureStore = clone(data)
        return { success: true }
      },
      delete: () => {
        secureStore = null
        return true
      },
    }),
  }))

  mock.module('../settings/settings.js', () => ({
    ...actualSettings,
    getSettings_DEPRECATED: () => clone(settingsStore),
    updateSettingsForSource: (_source: string, patch: SettingsJson) => {
      settingsStore = clone(patch)
      return { error: null }
    },
  }))
}

const actualSettings = await import('../settings/settings.js')
installMocks()

const { clearPluginOptionsCache, loadPluginOptions, savePluginOptions } =
  await import('./pluginOptionsStorage.js')
const { validateUserConfig } = await import('./mcpbHandler.js')
type PluginOptionSchema = Parameters<typeof validateUserConfig>[1]

const PLUGIN_ID = 'demo@marketplace'

describe('savePluginOptions type round trip', () => {
  beforeEach(() => {
    installMocks()
    secureStore = null
    settingsStore = {}
    clearPluginOptionsCache()
  })

  test('keeps a sensitive number a number', () => {
    const schema: PluginOptionSchema = {
      port: {
        type: 'number',
        title: 'Port',
        description: 'Port to connect on',
        sensitive: true,
      },
    }

    savePluginOptions(PLUGIN_ID, { port: 42 }, schema)
    const loaded = loadPluginOptions(PLUGIN_ID)

    expect(loaded.port).toBe(42)
    expect(validateUserConfig(loaded, schema)).toEqual({
      valid: true,
      errors: [],
    })
  })

  test('keeps a sensitive boolean a boolean', () => {
    const schema: PluginOptionSchema = {
      verify: {
        type: 'boolean',
        title: 'Verify TLS',
        description: 'Whether to verify TLS',
        sensitive: true,
      },
    }

    savePluginOptions(PLUGIN_ID, { verify: true }, schema)
    const loaded = loadPluginOptions(PLUGIN_ID)

    expect(loaded.verify).toBe(true)
    expect(validateUserConfig(loaded, schema)).toEqual({
      valid: true,
      errors: [],
    })
  })

  test('keeps a sensitive string array an array', () => {
    const schema: PluginOptionSchema = {
      tokens: {
        type: 'string',
        title: 'Tokens',
        description: 'Access tokens',
        multiple: true,
        sensitive: true,
      },
    }

    savePluginOptions(PLUGIN_ID, { tokens: ['a', 'b'] }, schema)
    const loaded = loadPluginOptions(PLUGIN_ID)

    expect(loaded.tokens).toEqual(['a', 'b'])
    expect(validateUserConfig(loaded, schema).valid).toBe(true)
  })

  test('still keeps a sensitive string out of settings.json', () => {
    const schema: PluginOptionSchema = {
      token: {
        type: 'string',
        title: 'Token',
        description: 'Bot token',
        sensitive: true,
      },
      host: {
        type: 'string',
        title: 'Host',
        description: 'Host name',
      },
    }

    savePluginOptions(
      PLUGIN_ID,
      { token: 'secret-value', host: 'example.com' },
      schema,
    )

    expect(settingsStore.pluginConfigs?.[PLUGIN_ID]?.options).toEqual({
      host: 'example.com',
    })
    expect(loadPluginOptions(PLUGIN_ID)).toEqual({
      token: 'secret-value',
      host: 'example.com',
    })
  })
})
