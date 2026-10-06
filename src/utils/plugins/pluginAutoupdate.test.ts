import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let policySettings: Record<string, unknown> = {}
let requestCount = 0
let gitContactCount = 0

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

const {
  getMarketplacesCacheDir,
  saveKnownMarketplacesConfig,
} = await import('./marketplaceManager.js')
const { autoUpdateMarketplacesAndPluginsInBackground } = await import(
  './pluginAutoupdate.js'
)

let tempDir: string
let oldConfigDir: string | undefined
let oldPluginCacheDir: string | undefined

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-autoupdate-policy-'))
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR
  oldPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugins')
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
})

afterEach(() => {
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  if (oldPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = oldPluginCacheDir
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
