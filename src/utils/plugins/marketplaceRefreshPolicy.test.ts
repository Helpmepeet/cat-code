import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let policySettings: Record<string, unknown> = {}
let requestCount = 0
let requestHeaders: Record<string, string> | undefined
let gitContactCount = 0
let responseManifestName = 'policy-marketplace'
let revokeDuringGitReconcile = false

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
    get: async (_url: string, options: { headers: Record<string, string> }) => {
      requestCount += 1
      requestHeaders = options.headers
      return {
        data: {
          name: responseManifestName,
          owner: { name: 'test' },
          plugins: [],
        },
      }
    },
  },
}))

const actualExec = await import('../execFileNoThrow.js')
mock.module('../execFileNoThrow.js', () => ({
  ...actualExec,
  execFileNoThrowWithCwd: async (
    _file: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (args.some(arg => ['clone', 'fetch', 'pull', 'submodule'].includes(arg))) {
      gitContactCount += 1
    }
    if (args.includes('config')) {
      if (revokeDuringGitReconcile) {
        policySettings = {
          blockedMarketplaces: [
            { source: 'git', url: 'https://git.example.test/plugins.git' },
          ],
        }
      }
      return { stdout: '', stderr: '', code: 1 }
    }
    if (
      args.includes('pull') &&
      options?.cwd &&
      existsSync(join(options.cwd, '.git'))
    ) {
      return { stdout: '', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
}))

const {
  getMarketplace,
  getMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
  saveKnownMarketplacesConfig,
} = await import('./marketplaceManager.js')

let tempDir: string
let oldConfigDir: string | undefined
let oldPluginCacheDir: string | undefined
const source = {
  source: 'url' as const,
  url: 'https://marketplaces.example.test/marketplace.json',
  headers: { Authorization: 'Bearer sensitive-test-value' },
}
const manifest = JSON.stringify({
  name: 'policy-marketplace',
  owner: { name: 'test' },
  plugins: [],
})

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'marketplace-refresh-policy-'))
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR
  oldPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugins')
  mkdirSync(getMarketplacesCacheDir(), { recursive: true })
  requestCount = 0
  requestHeaders = undefined
  gitContactCount = 0
  responseManifestName = 'policy-marketplace'
  revokeDuringGitReconcile = false
  policySettings = {}
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace.json')
  writeFileSync(cachePath, manifest)
  await saveKnownMarketplacesConfig({
    'policy-marketplace': {
      source,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  getMarketplace.cache?.clear?.()
})

afterEach(() => {
  getMarketplace.cache?.clear?.()
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  if (oldPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = oldPluginCacheDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

function revokeSource(): void {
  policySettings = {
    blockedMarketplaces: [source],
  }
}

test('explicit refresh and bulk refresh stop after a persisted URL source is denied', async () => {
  const configFile = join(tempDir, 'plugins', 'known_marketplaces.json')
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace.json')
  const originalConfig = readFileSync(configFile, 'utf-8')
  const originalCache = readFileSync(cachePath, 'utf-8')

  revokeSource()
  await expect(refreshMarketplace('policy-marketplace')).rejects.toThrow(
    /enterprise policy/,
  )
  await refreshAllMarketplaces()

  expect(requestCount).toBe(0)
  expect(requestHeaders).toBeUndefined()
  expect(readFileSync(cachePath, 'utf-8')).toBe(originalCache)
  expect(readFileSync(configFile, 'utf-8')).toBe(originalConfig)
})

test('allowed URL sources still refresh with their configured headers', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace.json')

  await refreshMarketplace('policy-marketplace')

  expect(requestCount).toBe(1)
  expect(requestHeaders?.Authorization).toBe('Bearer sensitive-test-value')
  expect(readFileSync(cachePath, 'utf-8')).toContain('"policy-marketplace"')
  expect(
    (await loadKnownMarketplacesConfig())['policy-marketplace']?.lastUpdated,
  ).not.toBe('2026-01-01T00:00:00.000Z')
})

test('URL refresh rejects an official reserved identity before overwriting cache', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace.json')
  const originalCache = readFileSync(cachePath, 'utf-8')
  responseManifestName = 'claude-plugins-official'

  await expect(refreshMarketplace('policy-marketplace')).rejects.toThrow(
    /reserved|official/i,
  )

  expect(requestCount).toBe(1)
  expect(readFileSync(cachePath, 'utf-8')).toBe(originalCache)
})

test('legacy reserved-name sources cannot reach explicit or bulk refresh', async () => {
  const cachePath = join(
    getMarketplacesCacheDir(),
    'claude-plugins-official.json',
  )
  const configFile = join(tempDir, 'plugins', 'known_marketplaces.json')
  const originalManifest = JSON.stringify({
    name: 'claude-plugins-official',
    owner: { name: 'test' },
    plugins: [],
  })
  writeFileSync(cachePath, originalManifest)
  await saveKnownMarketplacesConfig({
    'claude-plugins-official': {
      source,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalConfig = readFileSync(configFile, 'utf-8')

  await expect(
    refreshMarketplace('claude-plugins-official'),
  ).rejects.toThrow(/reserved/)
  await refreshAllMarketplaces()

  expect(requestCount).toBe(0)
  expect(gitContactCount).toBe(0)
  expect(readFileSync(cachePath, 'utf-8')).toBe(originalManifest)
  expect(readFileSync(configFile, 'utf-8')).toBe(originalConfig)
})

test('lazy cache recovery checks current policy before contacting a URL source', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'policy-marketplace.json')
  rmSync(cachePath)
  revokeSource()

  await expect(getMarketplace('policy-marketplace')).rejects.toThrow(
    /enterprise policy/,
  )

  expect(requestCount).toBe(0)
  expect(requestHeaders).toBeUndefined()
  expect(existsSync(cachePath)).toBe(false)
})

test('explicit refresh rejects a denied persisted Git source before Git contact', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'git-policy-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'git-policy-marketplace',
      owner: { name: 'test' },
      plugins: [],
    }),
  )
  const gitSource = {
    source: 'git' as const,
    url: 'https://git.example.test/plugins.git',
  }
  await saveKnownMarketplacesConfig({
    'git-policy-marketplace': {
      source: gitSource,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  policySettings = { blockedMarketplaces: [gitSource] }
  const originalCache = readFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    'utf-8',
  )

  await expect(refreshMarketplace('git-policy-marketplace')).rejects.toThrow(
    /enterprise policy/,
  )

  expect(gitContactCount).toBe(0)
  expect(
    readFileSync(join(cachePath, '.claude-plugin', 'marketplace.json'), 'utf-8'),
  ).toBe(originalCache)
})

test('Git transport rechecks policy after sparse reconciliation and before pull', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'git-policy-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'git-policy-marketplace',
      owner: { name: 'test' },
      plugins: [],
    }),
  )
  const gitSource = {
    source: 'git' as const,
    url: 'https://git.example.test/plugins.git',
  }
  await saveKnownMarketplacesConfig({
    'git-policy-marketplace': {
      source: gitSource,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  revokeDuringGitReconcile = true

  await expect(refreshMarketplace('git-policy-marketplace')).rejects.toThrow(
    /enterprise policy/,
  )

  expect(gitContactCount).toBe(0)
})

test('allowed Git marketplace refresh still contacts its configured remote', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'git-policy-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'git-policy-marketplace',
      owner: { name: 'test' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'git-policy-marketplace': {
      source: {
        source: 'git',
        url: 'https://git.example.test/plugins.git',
      },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })

  await refreshMarketplace('git-policy-marketplace')

  expect(gitContactCount).toBe(1)
  expect(
    (await loadKnownMarketplacesConfig())['git-policy-marketplace']?.lastUpdated,
  ).not.toBe('2026-01-01T00:00:00.000Z')
})
