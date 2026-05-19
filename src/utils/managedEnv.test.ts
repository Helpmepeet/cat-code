import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

describe('applyConfigEnvironmentVariables', () => {
  const originalDebug = process.env.DEBUG

  beforeEach(() => {
    delete process.env.DEBUG
  })

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.DEBUG
    } else {
      process.env.DEBUG = originalDebug
    }
    mock.restore()
  })

  test('refreshes debug mode after settings env enables DEBUG', async () => {
    await mock.module('./config.js', () => ({
      getGlobalConfig: () => ({ env: {} }),
    }))
    await mock.module('./settings/settings.js', () => ({
      getSettings_DEPRECATED: () => ({ env: { DEBUG: 'true' } }),
      getSettingsForSource: () => null,
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
