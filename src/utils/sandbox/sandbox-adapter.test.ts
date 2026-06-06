import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'path'

describe('convertToSandboxRuntimeConfig', () => {
  afterEach(() => {
    mock.restore()
  })

  test('denies writes to .cat-code config + skills in cwd when cwd !== originalCwd', async () => {
    const originalCwd = '/home/user/project'
    const cwd = '/home/user/other'

    const stateActual = await import('../../bootstrap/state.js')
    await mock.module('../../bootstrap/state.js', () => ({
      ...stateActual,
      getCwdState: () => cwd,
      getOriginalCwd: () => originalCwd,
      getAdditionalDirectoriesForClaudeMd: () => [],
    }))

    const settingsActual = await import('../settings/settings.js')
    await mock.module('../settings/settings.js', () => ({
      ...settingsActual,
      getSettingsFilePathForSource: () => undefined,
      getSettingsForSource: () => null,
    }))

    const { convertToSandboxRuntimeConfig } = await import('./sandbox-adapter.js')
    const config = convertToSandboxRuntimeConfig({})
    const denyWrite = config.filesystem?.denyWrite ?? []

    // Real config now lives under .cat-code/ — the secondary cwd guard must cover it.
    expect(denyWrite).toContain(resolve(cwd, '.cat-code', 'settings.json'))
    expect(denyWrite).toContain(resolve(cwd, '.cat-code', 'settings.local.json'))
    expect(denyWrite).toContain(resolve(cwd, '.cat-code', 'skills'))

    // Legacy .claude paths are still denied.
    expect(denyWrite).toContain(resolve(cwd, '.claude', 'settings.json'))
    expect(denyWrite).toContain(resolve(cwd, '.claude', 'settings.local.json'))
    expect(denyWrite).toContain(resolve(cwd, '.claude', 'skills'))
  })
})
