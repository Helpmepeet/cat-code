import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let policySettings: Record<string, unknown> = {}
let requestCount = 0
let gitContactCount = 0
let updateCalls: string[] = []
let installedPluginFixture: Record<string, unknown> = { plugins: {} }
let onMarketplaceRefresh: ((name: string) => Promise<void>) | null = null

const actualSettings = await import('../settings/settings.js')
mock.module('../settings/settings.js', () => ({
  ...actualSettings,
  getSettingsForSource: (source: string) =>
    source === 'policySettings'
      ? policySettings
      : actualSettings.getSettingsForSource(
          source as Parameters<typeof actualSettings.getSettingsForSource>[0],
        ),
}))

const actualAxios = await import('axios')
mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...actualAxios.default,
    get: async () => {
      requestCount += 1
      return { data: {} }
    },
  },
}))

const actualExec = await import('../execFileNoThrow.js')
mock.module('../execFileNoThrow.js', () => ({
  ...actualExec,
  execFileNoThrowWithCwd: async (_file: string, args: string[]) => {
    if (args.some(arg => ['clone', 'fetch', 'pull', 'submodule'].includes(arg))) {
      gitContactCount += 1
    }
    return { stdout: '', stderr: '', code: 0 }
  },
}))

const actualInstalledPlugins = await import('./installedPluginsManager.js')
mock.module('./installedPluginsManager.js', () => ({
  ...actualInstalledPlugins,
  loadInstalledPluginsFromDisk: () => installedPluginFixture,
  isInstallationRelevantToCurrentProject: () => true,
}))

const actualPluginOperations = await import(
  '../../services/plugins/pluginOperations.js'
)
mock.module('../../services/plugins/pluginOperations.js', () => ({
  ...actualPluginOperations,
  updatePluginOp: async (pluginId: string) => {
    updateCalls.push(pluginId)
    return {
      success: true,
      alreadyUpToDate: false,
      oldVersion: '1.0.0',
      newVersion: '2.0.0',
    }
  },
}))

const actualMarketplaceManager = await import('./marketplaceManager.js')
mock.module('./marketplaceManager.js', () => ({
  ...actualMarketplaceManager,
  refreshMarketplace: async (name: string) => {
    if (onMarketplaceRefresh) {
      await onMarketplaceRefresh(name)
      return
    }
    await actualMarketplaceManager.refreshMarketplace(name)
  },
}))

const {
  getMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
} = actualMarketplaceManager
const { isSourceAllowedByPolicy } = await import('./marketplaceHelpers.js')
const { autoUpdateMarketplacesAndPluginsInBackground } = await import(
  './pluginAutoupdate.js'
)

let tempDir: string
let oldConfigDir: string | undefined
let oldPluginCacheDir: string | undefined
let oldForceAutoupdate: string | undefined

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-autoupdate-policy-'))
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR
  oldPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  oldForceAutoupdate = process.env.FORCE_AUTOUPDATE_PLUGINS
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugins')
  process.env.FORCE_AUTOUPDATE_PLUGINS = 'true'
  mkdirSync(getMarketplacesCacheDir(), { recursive: true })
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    '{"name":"policy-marketplace","owner":{"name":"test"},"plugins":[]}',
  )
  await saveKnownMarketplacesConfig({
    'policy-marketplace': {
      source: {
        source: 'git',
        url: 'https://git.example.test/plugins.git',
      },
      installLocation: cachePath,
      autoUpdate: true,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  policySettings = {
    blockedMarketplaces: [
      { source: 'git', url: 'https://git.example.test/plugins.git' },
    ],
  }
  requestCount = 0
  gitContactCount = 0
  updateCalls = []
  installedPluginFixture = { plugins: {} }
  onMarketplaceRefresh = null
})

afterEach(() => {
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  if (oldPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = oldPluginCacheDir
  }
  if (oldForceAutoupdate === undefined) {
    delete process.env.FORCE_AUTOUPDATE_PLUGINS
  } else {
    process.env.FORCE_AUTOUPDATE_PLUGINS = oldForceAutoupdate
  }
  rmSync(tempDir, { recursive: true, force: true })
})

test('background auto-update excludes a persisted source denied by current policy', async () => {
  const configFile = join(tempDir, 'plugins', 'known_marketplaces.json')
  const originalConfig = readFileSync(configFile, 'utf-8')

  await autoUpdateMarketplacesAndPluginsInBackground()

  expect(requestCount).toBe(0)
  expect(gitContactCount).toBe(0)
  expect(readFileSync(configFile, 'utf-8')).toBe(originalConfig)
})

test('mixed-case marketplace refresh and plugin policy recheck use original config key', async () => {
  const name = 'Policy-Marketplace'
  const cachePath = join(getMarketplacesCacheDir(), name)
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'test' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    [name]: {
      source: {
        source: 'git',
        url: 'https://case.example.test/plugins.git',
      },
      installLocation: cachePath,
      autoUpdate: true,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  expect((await loadKnownMarketplacesConfig())[name]?.autoUpdate).toBe(true)
  policySettings = {}
  expect(
    isSourceAllowedByPolicy({
      source: 'git',
      url: 'https://case.example.test/plugins.git',
    }),
  ).toBe(true)
  installedPluginFixture = {
    plugins: {
      [`example@${name}`]: [{ scope: 'user' }],
    },
  }

  await autoUpdateMarketplacesAndPluginsInBackground()

  expect(updateCalls).toEqual([`example@${name}`])
})

test('case-colliding marketplace keys cannot authorize plugin autoupdates', async () => {
  const upperName = 'Policy-Marketplace'
  const lowerName = 'policy-marketplace'
  const upperCache = join(getMarketplacesCacheDir(), upperName)
  const lowerCache = join(getMarketplacesCacheDir(), lowerName)
  for (const [name, cachePath] of [
    [upperName, upperCache],
    [lowerName, lowerCache],
  ]) {
    mkdirSync(join(cachePath, '.git'), { recursive: true })
    mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(cachePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name, owner: { name: 'test' }, plugins: [] }),
    )
  }
  await saveKnownMarketplacesConfig({
    [upperName]: {
      source: { source: 'git', url: 'https://upper.example.test/plugins.git' },
      installLocation: upperCache,
      autoUpdate: true,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
    [lowerName]: {
      source: { source: 'git', url: 'https://lower.example.test/plugins.git' },
      installLocation: lowerCache,
      autoUpdate: true,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  policySettings = {
    blockedMarketplaces: [
      { source: 'git', url: 'https://lower.example.test/plugins.git' },
    ],
  }
  installedPluginFixture = {
    plugins: {
      [`example@${upperName}`]: [{ scope: 'user' }],
    },
  }

  await autoUpdateMarketplacesAndPluginsInBackground()

  expect(updateCalls).toEqual([])
})

test('a case collision added during refresh blocks normalized plugin authorization', async () => {
  const name = 'Policy-Marketplace'
  const cachePath = join(getMarketplacesCacheDir(), name)
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, owner: { name: 'test' }, plugins: [] }),
  )
  const allowedSource = {
    source: 'git' as const,
    url: 'https://case.example.test/plugins.git',
  }
  const blockedSource = {
    source: 'git' as const,
    url: 'https://blocked.example.test/plugins.git',
  }
  await saveKnownMarketplacesConfig({
    [name]: {
      source: allowedSource,
      installLocation: cachePath,
      autoUpdate: true,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  policySettings = { blockedMarketplaces: [blockedSource] }
  installedPluginFixture = {
    plugins: {
      [`example@${name}`]: [{ scope: 'user' }],
    },
  }
  onMarketplaceRefresh = async refreshedName => {
    expect(refreshedName).toBe(name)
    const config = await loadKnownMarketplacesConfig()
    await saveKnownMarketplacesConfig({
      ...config,
      [name.toLowerCase()]: {
        source: blockedSource,
        installLocation: cachePath,
        autoUpdate: true,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    })
  }

  await autoUpdateMarketplacesAndPluginsInBackground()

  expect(isSourceAllowedByPolicy(allowedSource)).toBe(true)
  expect(isSourceAllowedByPolicy(blockedSource)).toBe(false)
  expect(updateCalls).toEqual([])
})
