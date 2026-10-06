import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { strToU8, zipSync } from 'fflate'
import { OFFICIAL_MARKETPLACE_SOURCE } from './officialMarketplace.js'

let policySettings: Record<string, unknown> = {}
let requestUrls: string[] = []
let waitForIdle: Promise<void> = Promise.resolve()
let revokeAfterLatest = false
let revokeOnBackupRename = false
let failStagingRename = false

const validArchive = Buffer.from(
  zipSync({
    'marketplaces/claude-plugins-official/.claude-plugin/marketplace.json':
      strToU8(
        JSON.stringify({
          name: 'claude-plugins-official',
          owner: { name: 'Anthropic' },
          plugins: [],
        }),
      ),
    'marketplaces/claude-plugins-official/plugins/example/run.sh': [
      strToU8('#!/bin/sh\nexit 0\n'),
      { os: 3, attrs: 0o100755 << 16 },
    ],
  }),
)
let responseArchive = validArchive

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

const actualState = await import('../../bootstrap/state.js')
mock.module('../../bootstrap/state.js', () => ({
  ...actualState,
  waitForScrollIdle: () => waitForIdle,
}))

const actualAxios = await import('axios')
mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...actualAxios.default,
    get: async (url: string) => {
      requestUrls.push(url)
      if (url.endsWith('/latest')) {
        if (revokeAfterLatest) denyOfficialSource()
        return { data: 'new-sha' }
      }
      return { data: responseArchive }
    },
  },
}))

const actualFsPromises = await import('fs/promises')
const actualRename = actualFsPromises.rename.bind(actualFsPromises)
mock.module('fs/promises', () => ({
  ...actualFsPromises,
  rename: async (source: string, destination: string) => {
    if (
      failStagingRename &&
      source.includes('marketplace-gcs-staging-') &&
      destination.endsWith('claude-plugins-official')
    ) {
      failStagingRename = false
      throw new Error('mock staging publication failure')
    }
    await actualRename(source, destination)
    if (revokeOnBackupRename && destination.includes('marketplace-gcs-backup-')) {
      revokeOnBackupRename = false
      denyOfficialSource()
    }
  },
}))

const { assertMarketplaceSourceAllowed } = await import(
  './marketplaceHelpers.js'
)
const {
  getMarketplacesCacheDir: getManagerMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
  saveKnownMarketplacesConfig,
} = await import('./marketplaceManager.js')
const { fetchOfficialMarketplaceFromGcs } = await import(
  './officialMarketplaceGcs.js'
)

let tempDir: string
let installLocation: string
let marketplacesCacheDir: string
let oldPluginCacheDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'official-gcs-policy-'))
  oldPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugins')
  marketplacesCacheDir = join(tempDir, 'marketplaces')
  installLocation = join(marketplacesCacheDir, 'claude-plugins-official')
  mkdirSync(installLocation, { recursive: true })
  writeFileSync(join(installLocation, '.gcs-sha'), 'old-sha')
  writeFileSync(join(installLocation, 'sentinel-file'), 'unchanged')
  policySettings = {}
  requestUrls = []
  waitForIdle = Promise.resolve()
  revokeAfterLatest = false
  revokeOnBackupRename = false
  failStagingRename = false
  responseArchive = validArchive
})

afterEach(() => {
  if (oldPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = oldPluginCacheDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

function denyOfficialSource(): void {
  policySettings = {
    blockedMarketplaces: [OFFICIAL_MARKETPLACE_SOURCE],
  }
}

test('GCS request rechecks policy after waiting for scroll idle', async () => {
  let resumeIdle!: () => void
  waitForIdle = new Promise<void>(resolve => {
    resumeIdle = resolve
  })

  const pending = fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )
  await Promise.resolve()
  denyOfficialSource()
  resumeIdle()

  await expect(pending).rejects.toThrow(/enterprise policy/)

  expect(requestUrls).toEqual([])
  expect(readdirSync(installLocation).sort()).toEqual([
    '.gcs-sha',
    'sentinel-file',
  ])
  expect(readFileSync(join(installLocation, 'sentinel-file'), 'utf-8')).toBe(
    'unchanged',
  )
})

test('GCS latest response rechecks policy before download or cache mutation', async () => {
  revokeAfterLatest = true
  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBeNull()
  expect(requestUrls).toHaveLength(1)
  expect(requestUrls[0]).toEndWith('/latest')
  expect(readdirSync(installLocation).sort()).toEqual([
    '.gcs-sha',
    'sentinel-file',
  ])
  expect(readFileSync(join(installLocation, '.gcs-sha'), 'utf-8')).toBe(
    'old-sha',
  )
  expect(readFileSync(join(installLocation, 'sentinel-file'), 'utf-8')).toBe(
    'unchanged',
  )
})

test('revocation during publication restores prior cache and removes staging', async () => {
  writeFileSync(join(installLocation, 'trusted-file'), 'trusted bytes')
  revokeOnBackupRename = true

  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBeNull()
  expect(requestUrls).toHaveLength(2)
  expect(readFileSync(join(installLocation, '.gcs-sha'), 'utf-8')).toBe(
    'old-sha',
  )
  expect(readFileSync(join(installLocation, 'trusted-file'), 'utf-8')).toBe(
    'trusted bytes',
  )
  expect(readdirSync(marketplacesCacheDir)).toEqual(['claude-plugins-official'])
})

test('revocation during manager publication preserves old cache and refresh metadata', async () => {
  const managerCacheDir = getManagerMarketplacesCacheDir()
  const managerInstall = join(managerCacheDir, 'claude-plugins-official')
  mkdirSync(managerInstall, { recursive: true })
  writeFileSync(join(managerInstall, '.gcs-sha'), 'old-sha')
  writeFileSync(join(managerInstall, 'trusted-file'), 'trusted manager bytes')
  await saveKnownMarketplacesConfig({
    'claude-plugins-official': {
      source: OFFICIAL_MARKETPLACE_SOURCE,
      installLocation: managerInstall,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const configPath = join(
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!,
    'known_marketplaces.json',
  )
  const originalConfig = readFileSync(configPath, 'utf-8')
  revokeOnBackupRename = true

  await expect(
    refreshMarketplace('claude-plugins-official'),
  ).rejects.toThrow(/enterprise policy/)

  expect(readFileSync(join(managerInstall, '.gcs-sha'), 'utf-8')).toBe('old-sha')
  expect(
    readFileSync(join(managerInstall, 'trusted-file'), 'utf-8'),
  ).toBe('trusted manager bytes')
  expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig)
  expect(
    (await loadKnownMarketplacesConfig())['claude-plugins-official']?.lastUpdated,
  ).toBe('2026-01-01T00:00:00.000Z')
  expect(readdirSync(managerCacheDir)).toEqual(['claude-plugins-official'])
})

test('failed staging publication restores the previous cache', async () => {
  writeFileSync(join(installLocation, 'trusted-file'), 'trusted bytes')
  failStagingRename = true

  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBeNull()
  expect(readFileSync(join(installLocation, '.gcs-sha'), 'utf-8')).toBe(
    'old-sha',
  )
  expect(readFileSync(join(installLocation, 'trusted-file'), 'utf-8')).toBe(
    'trusted bytes',
  )
  expect(readdirSync(marketplacesCacheDir)).toEqual(['claude-plugins-official'])
})

test('valid GCS update publishes a validated manifest and executable mode', async () => {
  writeFileSync(join(installLocation, 'trusted-file'), 'old content')

  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBe('new-sha')
  expect(requestUrls).toHaveLength(2)
  expect(readFileSync(join(installLocation, '.gcs-sha'), 'utf-8')).toBe(
    'new-sha',
  )
  expect(() => readFileSync(join(installLocation, 'trusted-file'))).toThrow()
  expect(
    readFileSync(
      join(installLocation, '.claude-plugin', 'marketplace.json'),
      'utf-8',
    ),
  ).toContain('claude-plugins-official')
  if (process.platform !== 'win32') {
    expect(
      (await import('fs')).statSync(
        join(installLocation, 'plugins/example/run.sh'),
      ).mode & 0o111,
    ).not.toBe(0)
  }
  expect(readdirSync(marketplacesCacheDir)).toEqual(['claude-plugins-official'])
})

test('invalid GCS manifest cannot replace an existing cache', async () => {
  responseArchive = Buffer.from(
    zipSync({
      'marketplaces/claude-plugins-official/.claude-plugin/marketplace.json':
        strToU8(
          JSON.stringify({
            name: 'claude-plugins-official',
            plugins: [],
          }),
        ),
    }),
  )
  writeFileSync(join(installLocation, 'trusted-file'), 'trusted bytes')

  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBeNull()
  expect(readFileSync(join(installLocation, '.gcs-sha'), 'utf-8')).toBe(
    'old-sha',
  )
  expect(readFileSync(join(installLocation, 'trusted-file'), 'utf-8')).toBe(
    'trusted bytes',
  )
  expect(readdirSync(marketplacesCacheDir)).toEqual(['claude-plugins-official'])
})

test('GCS refuses a linked cache target without touching its external content', async () => {
  const externalDir = join(tempDir, 'external-cache')
  mkdirSync(externalDir)
  writeFileSync(join(externalDir, 'trusted-file'), 'external bytes')
  rmSync(installLocation, { recursive: true })
  symlinkSync(externalDir, installLocation, 'dir')

  const result = await fetchOfficialMarketplaceFromGcs(
    installLocation,
    marketplacesCacheDir,
    () => assertMarketplaceSourceAllowed(OFFICIAL_MARKETPLACE_SOURCE),
  )

  expect(result).toBeNull()
  expect(requestUrls).toEqual([])
  expect(readFileSync(join(externalDir, 'trusted-file'), 'utf-8')).toBe(
    'external bytes',
  )
})
