import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
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
import { dirname, join, resolve } from 'path'
import { parseMarketplaceInput } from './parseMarketplaceInput.js'
import { MarketplaceSourceSchema } from './schemas.js'

type GitMode = 'fail-clone' | 'successful-clone'
let gitMode: GitMode = 'successful-clone'
let cloneTargets: string[] = []
let pullCount = 0

const actualExecFileNoThrow = await import('../execFileNoThrow.js')
mock.module('../execFileNoThrow.js', () => ({
  ...actualExecFileNoThrow,
  execFileNoThrow: async () => ({ stdout: '', stderr: '', code: 0 }),
  execFileNoThrowWithCwd: async (
    _file: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    const cloneIndex = args.indexOf('clone')
    if (cloneIndex !== -1) {
      const targetPath = args.at(-1)!
      cloneTargets.push(targetPath)
      mkdirSync(targetPath, { recursive: true })
      if (gitMode === 'successful-clone') {
        mkdirSync(join(targetPath, '.git'))
        mkdirSync(join(targetPath, '.claude-plugin'))
        writeFileSync(
          join(targetPath, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: 'safe-marketplace',
            owner: { name: 'test' },
            plugins: [],
          }),
        )
        return { stdout: '', stderr: '', code: 0 }
      }
      writeFileSync(join(targetPath, 'partial-clone'), 'incomplete')
      return { stdout: '', stderr: 'mock clone failure', code: 1 }
    }

    if (args[0] === 'pull') {
      if (options?.cwd && existsSync(join(options.cwd, '.git'))) {
        pullCount += 1
        return { stdout: '', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: 'not a git repository', code: 1 }
    }

    if (args[0] === 'config') {
      return { stdout: '', stderr: 'not configured', code: 1 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
}))

const {
  addMarketplaceSource,
  assertMarketplaceCachePath,
  getMarketplacesCacheDir,
  refreshMarketplace,
} = await import('./marketplaceManager.js')

let tempDir: string
let previousConfigDir: string | undefined
let previousPluginCacheDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'marketplace-cache-safety-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempDir, 'plugin-cache')
  mkdirSync(getMarketplacesCacheDir(), { recursive: true })
  gitMode = 'successful-clone'
  cloneTargets = []
  pullCount = 0
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  if (previousPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previousPluginCacheDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('marketplace cache path safety', () => {
  test('accepts valid GitHub repositories and rejects malformed paths', async () => {
    expect(
      MarketplaceSourceSchema().safeParse({
        source: 'github',
        repo: 'owner/repo.name-1',
      }).success,
    ).toBe(true)

    for (const repo of [
      'owner/repo/extra',
      '../outside/repo',
      'owner/../repo',
      'owner\\repo',
      'owner//repo',
      '/owner/repo',
      'owner/repo\n',
      'owner/repo\r',
      'owner/repo\0',
    ]) {
      expect(
        MarketplaceSourceSchema().safeParse({ source: 'github', repo }).success,
      ).toBe(false)
      if (!repo.endsWith('\n') && !repo.endsWith('\r')) {
        const parsed = await parseMarketplaceInput(repo)
        expect(
          Boolean(parsed && 'source' in parsed && parsed.source === 'github'),
        ).toBe(false)
      }
    }
    expect(await parseMarketplaceInput('owner/repo#ref')).toEqual({
      source: 'github',
      repo: 'owner/repo',
      ref: 'ref',
    })
  })

  test('requires a strict cache child and refuses linked targets', async () => {
    const cacheDir = getMarketplacesCacheDir()
    const target = join(cacheDir, 'generated-staging')
    expect(assertMarketplaceCachePath(target)).toBe(target)
    expect(() => assertMarketplaceCachePath(cacheDir)).toThrow()
    expect(() => assertMarketplaceCachePath(join(tempDir, 'sibling'))).toThrow()

    const outside = join(tempDir, 'user-owned-sibling')
    mkdirSync(outside)
    const sentinel = join(outside, 'keep.txt')
    writeFileSync(sentinel, 'preserve')
    const linkedTarget = join(cacheDir, 'linked-staging')
    symlinkSync(outside, linkedTarget, 'dir')
    expect(() => assertMarketplaceCachePath(linkedTarget)).toThrow(
      /symbolic link/,
    )
    expect(readFileSync(sentinel, 'utf-8')).toBe('preserve')
  })

  test('rejects traversal sources before Git and preserves adjacent data', async () => {
    const cacheDir = getMarketplacesCacheDir()
    const parentSentinel = join(dirname(cacheDir), 'keep-parent.txt')
    writeFileSync(parentSentinel, 'parent')
    const escapedStagingPath = resolve(cacheDir, 'owner-../../../../sibling')
    mkdirSync(escapedStagingPath, { recursive: true })
    const siblingSentinel = join(escapedStagingPath, 'keep-sibling.txt')
    writeFileSync(siblingSentinel, 'sibling')

    await expect(
      addMarketplaceSource({ source: 'github', repo: 'owner/../../../../sibling' }),
    ).rejects.toThrow(/valid owner\/repository path/)

    expect(cloneTargets).toEqual([])
    expect(readFileSync(parentSentinel, 'utf-8')).toBe('parent')
    expect(readFileSync(siblingSentinel, 'utf-8')).toBe('sibling')
  })

  test('failed clone removes partial staging and leaves cache parent and sibling intact', async () => {
    gitMode = 'fail-clone'
    const cacheDir = getMarketplacesCacheDir()
    const parentSentinel = join(dirname(cacheDir), 'keep-parent.txt')
    const siblingPath = join(dirname(cacheDir), 'sibling')
    mkdirSync(siblingPath)
    const siblingSentinel = join(siblingPath, 'keep-sibling.txt')
    writeFileSync(parentSentinel, 'parent')
    writeFileSync(siblingSentinel, 'sibling')

    await expect(
      addMarketplaceSource({ source: 'github', repo: 'valid/repository' }),
    ).rejects.toThrow(/mock clone failure/)

    expect(cloneTargets.length).toBeGreaterThan(0)
    expect(new Set(cloneTargets).size).toBe(1)
    expect(cloneTargets[0]!.startsWith(`${cacheDir}/`)).toBe(true)
    expect(readdirSync(cacheDir)).toEqual([])
    expect(readFileSync(parentSentinel, 'utf-8')).toBe('parent')
    expect(readFileSync(siblingSentinel, 'utf-8')).toBe('sibling')
  })

  test('valid marketplace add and refresh still work with mocked Git', async () => {
    const added = await addMarketplaceSource({
      source: 'github',
      repo: 'valid/repository',
    })
    expect(added.name).toBe('safe-marketplace')
    expect(existsSync(join(getMarketplacesCacheDir(), 'safe-marketplace'))).toBe(
      true,
    )

    await refreshMarketplace(added.name)
    expect(pullCount).toBeGreaterThan(0)
  })
})
