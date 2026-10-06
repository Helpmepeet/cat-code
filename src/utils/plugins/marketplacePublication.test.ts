import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
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
import type { FsOperations } from '../fsOperations.js'

let manifestName = 'safe-marketplace'
let manifestPlugins: unknown[] = []
let manifestOwner = 'test'
let updateManifestOnPull = false
let failConfigWrite = false
let policySettings: Record<string, unknown> = {}
let revokePolicyAtSshProbe = false
let copyCount = 0
let gitContactCount = 0
let urlManifest: unknown = {
  name: 'safe-marketplace',
  owner: { name: 'test' },
  plugins: [],
}
let urlRequestHeaders: Record<string, string> | undefined

const actualSettings = await import('../settings/settings.js')
const originalGetSettingsForSource = actualSettings.getSettingsForSource
mock.module('../settings/settings.js', () => ({
  ...actualSettings,
  getSettingsForSource: (source: string) =>
    source === 'policySettings'
      ? policySettings
      : originalGetSettingsForSource(
          source as Parameters<typeof actualSettings.getSettingsForSource>[0],
        ),
}))

const actualFsPromises = await import('fs/promises')
const originalCp = actualFsPromises.cp
mock.module('fs/promises', () => ({
  ...actualFsPromises,
  cp: (...args: Parameters<typeof actualFsPromises.cp>) => {
    copyCount += 1
    return originalCp(...args)
  },
}))

const actualAxios = await import('axios')
mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...actualAxios.default,
    get: async (_url: string, options: { headers: Record<string, string> }) => {
      urlRequestHeaders = options.headers
      return { data: urlManifest }
    },
  },
}))

const actualExecFileNoThrow = await import('../execFileNoThrow.js')
mock.module('../execFileNoThrow.js', () => ({
  ...actualExecFileNoThrow,
  execFileNoThrow: async () => {
    if (revokePolicyAtSshProbe) {
      policySettings = {
        blockedMarketplaces: [
          { source: 'github', repo: 'trusted/repository' },
        ],
      }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
  execFileNoThrowWithCwd: async (
    _file: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (args.some(arg => ['clone', 'fetch', 'pull', 'submodule'].includes(arg))) {
      gitContactCount += 1
    }
    const cloneIndex = args.indexOf('clone')
    if (cloneIndex !== -1) {
      const targetPath = args.at(-1)!
      mkdirSync(join(targetPath, '.git'), { recursive: true })
      mkdirSync(join(targetPath, '.claude-plugin'), { recursive: true })
      writeFileSync(
        join(targetPath, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: manifestName,
          owner: { name: manifestOwner },
          plugins: manifestPlugins,
        }),
      )
      return { stdout: '', stderr: '', code: 0 }
    }
    if (args.includes('config')) {
      return { stdout: '', stderr: 'not configured', code: 1 }
    }
    if (args.includes('pull')) {
      if (options?.cwd && updateManifestOnPull) {
        writeFileSync(
          join(options.cwd, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: manifestName,
            owner: { name: manifestOwner },
            plugins: manifestPlugins,
          }),
        )
      }
      return options?.cwd && existsSync(join(options.cwd, '.git'))
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'not a git repository', code: 1 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
}))

const actualAtomicFile = await import('../atomicFile.js')
const originalAtomicWrite = actualAtomicFile.writeFileAtomicDurable
mock.module('../atomicFile.js', () => ({
  ...actualAtomicFile,
  writeFileAtomicDurable: async (
    filePath: string,
    content: string | Uint8Array,
  ) => {
    if (failConfigWrite && filePath.endsWith('known_marketplaces.json')) {
      throw new Error('mock config persistence failure')
    }
    return originalAtomicWrite(filePath, content)
  },
}))

const fsOperations = await import('../fsOperations.js')
const {
  addMarketplaceSource,
  getMarketplace,
  getMarketplaceCacheOnly,
  getMarketplacesCacheDir,
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
  registerSeedMarketplaces,
  saveKnownMarketplacesConfig,
} = await import('./marketplaceManager.js')

let tempDir: string
let oldConfigDir: string | undefined
let oldPluginCacheDir: string | undefined
let oldSeedDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'marketplace-publication-'))
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR
  oldPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  oldSeedDir = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugins')
  delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  mkdirSync(getMarketplacesCacheDir(), { recursive: true })
  manifestName = 'safe-marketplace'
  manifestPlugins = []
  manifestOwner = 'test'
  updateManifestOnPull = false
  failConfigWrite = false
  policySettings = {}
  revokePolicyAtSshProbe = false
  copyCount = 0
  gitContactCount = 0
  urlManifest = {
    name: 'safe-marketplace',
    owner: { name: 'test' },
    plugins: [],
  }
  urlRequestHeaders = undefined
  getMarketplace.cache?.clear?.()
})

afterEach(() => {
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  if (oldPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = oldPluginCacheDir
  }
  if (oldSeedDir === undefined) delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  else process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = oldSeedDir
  rmSync(tempDir, { recursive: true, force: true })
  getMarketplace.cache?.clear?.()
})

const attackerSource = { source: 'git' as const, url: 'https://example.com/attacker.git' }
const internalMirrorSource = {
  source: 'git' as const,
  url: 'https://mirror.example.com/official-marketplace.git',
}

async function seedTrustedReservedMarketplace(): Promise<string> {
  const cachePath = join(getMarketplacesCacheDir(), 'claude-plugins-official')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'claude-plugins-official',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'claude-plugins-official': {
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  return cachePath
}

test('cache consumers reject persisted reserved-name provenance and identity mismatches', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'claude-plugins-official')
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'claude-plugins-official',
      owner: { name: 'forged' },
      plugins: [{ name: 'sample-plugin' }],
    }),
  )
  await saveKnownMarketplacesConfig({
    'claude-plugins-official': {
      source: attackerSource,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  manifestName = 'claude-plugins-official'

  expect(await getMarketplaceCacheOnly('claude-plugins-official')).toBeNull()
  expect(
    await getPluginByIdCacheOnly('sample-plugin@claude-plugins-official'),
  ).toBeNull()
  await expect(getMarketplace('claude-plugins-official')).rejects.toThrow(
    /reserved/,
  )
  expect(
    readFileSync(
      join(cachePath, '.claude-plugin', 'marketplace.json'),
      'utf-8',
    ),
  ).toContain('"forged"')
})

test('cache consumers reject a valid manifest stored under the wrong marketplace key', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'different-marketplace',
      owner: { name: 'test' },
      plugins: [{ name: 'sample-plugin' }],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: attackerSource,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  manifestName = 'different-marketplace'

  expect(await getMarketplaceCacheOnly('safe-marketplace')).toBeNull()
  expect(await getPluginByIdCacheOnly('sample-plugin@safe-marketplace')).toBeNull()
  await expect(getMarketplace('safe-marketplace')).rejects.toThrow(
    /manifest identity/,
  )
  expect(
    JSON.parse(
      readFileSync(join(cachePath, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ).name,
  ).toBe('different-marketplace')
})

test('rejected reserved identity leaves trusted content and config untouched', async () => {
  manifestName = 'claude-plugins-official'
  const cachePath = await seedTrustedReservedMarketplace()
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )

  await expect(addMarketplaceSource(attackerSource)).rejects.toThrow(/reserved/)

  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual([
    'claude-plugins-official',
  ])
})

test('seed-managed name collision rejects before cache publication', async () => {
  const seedDir = join(tempDir, 'seed')
  const seededCache = join(seedDir, 'marketplaces', 'safe-marketplace')
  mkdirSync(seededCache, { recursive: true })
  process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'github', repo: 'trusted/repository' },
      installLocation: seededCache,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )

  await expect(addMarketplaceSource(attackerSource)).rejects.toThrow(/seed-managed/)

  expect(readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8')).toBe(
    originalConfig,
  )
  expect(readdirSync(getMarketplacesCacheDir())).toEqual([])
})

test('official internal-mirror cache from configured seed remains trusted', async () => {
  const seedDir = join(tempDir, 'trusted-seed')
  const seedMarketplacesDir = join(seedDir, 'marketplaces')
  const seedCache = join(seedMarketplacesDir, 'claude-plugins-official')
  mkdirSync(join(seedCache, '.claude-plugin'), { recursive: true })
  process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir
  writeFileSync(
    join(seedDir, 'known_marketplaces.json'),
    JSON.stringify({
      'claude-plugins-official': {
        source: internalMirrorSource,
        installLocation: '/build-time/stale/seed/location',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }),
  )
  writeFileSync(
    join(seedCache, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'claude-plugins-official',
      owner: { name: 'admin-seed' },
      plugins: [],
    }),
  )

  expect(await registerSeedMarketplaces()).toBe(true)
  const seededConfig = await loadKnownMarketplacesConfig()
  expect(seededConfig['claude-plugins-official']?.source).toEqual(
    internalMirrorSource,
  )
  expect(seededConfig['claude-plugins-official']?.installLocation).toBe(seedCache)
  expect(await getMarketplaceCacheOnly('claude-plugins-official')).toMatchObject({
    name: 'claude-plugins-official',
    owner: { name: 'admin-seed' },
  })
})

test('seed manifest symlink to outside content is not trusted', async () => {
  const seedDir = join(tempDir, 'forged-seed')
  const seedMarketplacesDir = join(seedDir, 'marketplaces')
  const linkedSeedCache = join(seedMarketplacesDir, 'claude-plugins-official')
  const outsideCache = join(tempDir, 'outside-seed-content')
  mkdirSync(join(outsideCache, '.claude-plugin'), { recursive: true })
  mkdirSync(seedMarketplacesDir, { recursive: true })
  process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir
  writeFileSync(
    join(seedDir, 'known_marketplaces.json'),
    JSON.stringify({
      'claude-plugins-official': {
        source: internalMirrorSource,
        installLocation: outsideCache,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }),
  )
  const outsideManifest = join(
    outsideCache,
    '.claude-plugin',
    'marketplace.json',
  )
  writeFileSync(
    outsideManifest,
    JSON.stringify({
      name: 'claude-plugins-official',
      owner: { name: 'outside' },
      plugins: [],
    }),
  )
  symlinkSync(outsideCache, linkedSeedCache, 'dir')

  expect(await registerSeedMarketplaces()).toBe(false)
  await saveKnownMarketplacesConfig({
    'claude-plugins-official': {
      source: internalMirrorSource,
      installLocation: linkedSeedCache,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  expect(await getMarketplaceCacheOnly('claude-plugins-official')).toBeNull()
  expect(readFileSync(outsideManifest, 'utf-8')).toContain('"outside"')
})

test('invalid settings manifest does not overwrite existing cache', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(manifestPath, 'trusted existing bytes')
  manifestName = 'safe-marketplace'
  const settingsSource = {
    source: 'settings' as const,
    name: 'safe-marketplace',
    plugins: [{ name: 'invalid plugin name' }],
  }

  await expect(addMarketplaceSource(settingsSource as never)).rejects.toThrow()

  expect(readFileSync(manifestPath, 'utf-8')).toBe('trusted existing bytes')
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('valid replacement publishes new cache and preserves source update behavior', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(cachePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'safe-marketplace', owner: { name: 'old' }, plugins: [] }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/old.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  manifestName = 'safe-marketplace'
  await addMarketplaceSource(attackerSource)

  const config = await loadKnownMarketplacesConfig()
  expect(config['safe-marketplace']?.source).toEqual(attackerSource)
  expect(
    JSON.parse(
      readFileSync(join(cachePath, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ).owner.name,
  ).toBe('test')
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('failed staged-to-final rename restores the prior cache', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(manifestPath, 'original trusted bytes')
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/old.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })

  const originalFs = fsOperations.getFsImplementation()
  let failedPublication = false
  const failingFs = new Proxy(originalFs, {
    get(target, property, receiver) {
      if (property === 'rename') {
        return async (from: string, to: string) => {
          if (!failedPublication && to === cachePath) {
            failedPublication = true
            throw new Error('mock publication failure')
          }
          return target.rename(from, to)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as FsOperations
  fsOperations.setFsImplementation(failingFs)
  try {
    await expect(addMarketplaceSource(attackerSource)).rejects.toThrow(
      /mock publication failure/,
    )
  } finally {
    fsOperations.setFsImplementation(originalFs)
  }

  expect(readFileSync(manifestPath, 'utf-8')).toBe('original trusted bytes')
  expect((await loadKnownMarketplacesConfig())['safe-marketplace']?.source).toEqual(
    { source: 'git', url: 'https://example.com/old.git' },
  )
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('config persistence failure restores old cache bytes and old metadata', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(manifestPath, 'original trusted bytes')
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/old.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  failConfigWrite = true

  await expect(addMarketplaceSource(attackerSource)).rejects.toThrow(
    /mock config persistence failure/,
  )

  expect(readFileSync(manifestPath, 'utf-8')).toBe('original trusted bytes')
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('invalid Git refresh leaves trusted live cache and metadata untouched', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/trusted.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  manifestPlugins = [{ name: 'not a valid plugin entry' }]
  updateManifestOnPull = true

  await expect(refreshMarketplace('safe-marketplace')).rejects.toThrow()

  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('Git refresh rejects a reserved manifest from an untrusted source', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/trusted.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  manifestName = 'claude-plugins-official'
  updateManifestOnPull = true

  await expect(refreshMarketplace('safe-marketplace')).rejects.toThrow(/reserved/)

  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('Git refresh config persistence failure restores old cache and metadata', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'git', url: 'https://example.com/trusted.git' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  manifestOwner = 'new-owner'
  updateManifestOnPull = true
  failConfigWrite = true

  await expect(refreshMarketplace('safe-marketplace')).rejects.toThrow(
    /mock config persistence failure/,
  )

  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('URL refresh publishes back to its existing cache filename', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace.json')
  writeFileSync(
    cachePath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: {
        source: 'url',
        url: 'https://example.com/marketplace.json',
        headers: { Authorization: 'Bearer test-value' },
      },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  urlManifest = {
    name: 'safe-marketplace',
    owner: { name: 'refreshed' },
    plugins: [],
  }

  await refreshMarketplace('safe-marketplace')

  expect(urlRequestHeaders?.Authorization).toBe('Bearer test-value')
  expect(JSON.parse(readFileSync(cachePath, 'utf-8')).owner.name).toBe(
    'refreshed',
  )
  expect(existsSync(join(getMarketplacesCacheDir(), 'safe-marketplace'))).toBe(
    false,
  )
  expect(
    (await loadKnownMarketplacesConfig())['safe-marketplace']?.installLocation,
  ).toBe(cachePath)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual([
    'safe-marketplace.json',
  ])
})

test('Git refresh rechecks policy after SSH preflight before staging copy', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source: { source: 'github', repo: 'trusted/repository' },
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  revokePolicyAtSshProbe = true

  await expect(refreshMarketplace('safe-marketplace')).rejects.toThrow(
    /enterprise policy/,
  )

  expect(copyCount).toBe(0)
  expect(gitContactCount).toBe(0)
  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})

test('Git refresh rolls back when policy is revoked after backup rename', async () => {
  const cachePath = join(getMarketplacesCacheDir(), 'safe-marketplace')
  mkdirSync(join(cachePath, '.git'), { recursive: true })
  mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true })
  const manifestPath = join(cachePath, '.claude-plugin', 'marketplace.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'safe-marketplace',
      owner: { name: 'trusted' },
      plugins: [],
    }),
  )
  const source = {
    source: 'git' as const,
    url: 'https://example.com/trusted.git',
  }
  await saveKnownMarketplacesConfig({
    'safe-marketplace': {
      source,
      installLocation: cachePath,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  const originalContent = readFileSync(manifestPath, 'utf-8')
  const originalConfig = readFileSync(
    join(tempDir, 'plugins', 'known_marketplaces.json'),
    'utf-8',
  )
  manifestOwner = 'new-owner'
  updateManifestOnPull = true

  const originalFs = fsOperations.getFsImplementation()
  let publishedStaging = false
  let revokedAfterBackup = false
  const revokingFs = new Proxy(originalFs, {
    get(target, property, receiver) {
      if (property === 'rename') {
        return async (from: string, to: string) => {
          await target.rename(from, to)
          if (
            from === cachePath &&
            to.includes('marketplace-backup-')
          ) {
            revokedAfterBackup = true
            policySettings = { blockedMarketplaces: [source] }
          }
          if (from.includes('marketplace-refresh-') && to === cachePath) {
            publishedStaging = true
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as FsOperations
  fsOperations.setFsImplementation(revokingFs)
  try {
    await expect(refreshMarketplace('safe-marketplace')).rejects.toThrow(
      /enterprise policy/,
    )
  } finally {
    fsOperations.setFsImplementation(originalFs)
  }

  expect(revokedAfterBackup).toBe(true)
  expect(publishedStaging).toBe(false)
  expect(readFileSync(manifestPath, 'utf-8')).toBe(originalContent)
  expect(
    readFileSync(join(tempDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
  ).toBe(originalConfig)
  expect(readdirSync(getMarketplacesCacheDir())).toEqual(['safe-marketplace'])
})
