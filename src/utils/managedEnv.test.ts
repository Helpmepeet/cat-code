import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { clearDebugModeCache } from './debug.js'

describe('applyConfigEnvironmentVariables', () => {
  const originalDebug = process.env.DEBUG
  let mocksEnabled = false

  beforeEach(() => {
    delete process.env.DEBUG
    clearDebugModeCache()
    mocksEnabled = true
  })

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.DEBUG
    } else {
      process.env.DEBUG = originalDebug
    }
    clearDebugModeCache()
    mocksEnabled = false
    mock.restore()
  })

  test('refreshes debug mode after settings env enables DEBUG', async () => {
    const realConfig = { ...await import('./config.js') }
    const realSettings = { ...await import('./settings/settings.js') }
    await mock.module('./config.js', () => ({
      ...realConfig,
      getGlobalConfig: (...args: Parameters<typeof realConfig.getGlobalConfig>) =>
        mocksEnabled ? { env: {} } : realConfig.getGlobalConfig(...args),
    }))
    await mock.module('./settings/settings.js', () => ({
      ...realSettings,
      getSettings_DEPRECATED: (...args: Parameters<typeof realSettings.getSettings_DEPRECATED>) =>
        mocksEnabled
          ? { env: { DEBUG: 'true' } }
          : realSettings.getSettings_DEPRECATED(...args),
      getSettingsForSource: (...args: Parameters<typeof realSettings.getSettingsForSource>) =>
        mocksEnabled
          ? null
          : realSettings.getSettingsForSource(...args),
    }))
    await mock.module('../services/remoteManagedSettings/syncCache.js', () => ({
      isRemoteManagedSettingsEligible: () => false,
    }))
    await mock.module('./caCerts.js', () => ({
      clearCACertsCache: () => {},
    }))
    await mock.module('./mtls.js', () => ({
      clearMTLSCache: () => {},
    }))
    await mock.module('./proxy.js', () => ({
      clearProxyCache: () => {},
      configureGlobalAgents: () => {},
    }))

    const { isDebugMode } = await import('./debug.js')
    expect(isDebugMode()).toBe(false)

    const { applyConfigEnvironmentVariables } = await import('./managedEnv.js')
    applyConfigEnvironmentVariables()

    expect(process.env.DEBUG).toBe('true')
    expect(isDebugMode()).toBe(true)
  })
})
