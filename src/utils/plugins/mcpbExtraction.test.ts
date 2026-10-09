import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { strToU8, zipSync } from 'fflate'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const testRoot = await mkdtemp(join(tmpdir(), 'mcpb-extraction-test-'))
const configHome = join(testRoot, 'config')
await mkdir(configHome, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configHome

const { loadMcpbFile } = await import('./mcpbHandler.js')
const { realpath } = await import('fs/promises')

const manifest = JSON.stringify({
  manifest_version: '0.3',
  name: 'fixture-server',
  version: '1.0.0',
  description: 'Extraction test fixture',
  author: { name: 'Test Author' },
  server: {
    type: 'node',
    entry_point: 'bin/server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/bin/server.js'] },
  },
})

function makeBundle(
  extra: Record<string, Uint8Array> = {},
  manifestData = manifest,
): Buffer {
  return Buffer.from(
    zipSync({
      'manifest.json': strToU8(manifestData),
      'bin/server.js': [strToU8('console.log("ok")'), { os: 3, attrs: 0o100755 << 16 }],
      ...extra,
    }),
  )
}

async function setupPlugin(name: string, bundle: Buffer) {
  const pluginPath = join(testRoot, name)
  await mkdir(pluginPath, { recursive: true })
  await writeFile(join(pluginPath, 'server.mcpb'), bundle)
  return pluginPath
}

const cacheKey = (text: string) =>
  createHash('sha256').update(text).digest('hex')
const canonicalConfigHome = await realpath(configHome)
const configHomeMode = (await stat(configHome)).mode & 0o777

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(testRoot, { recursive: true, force: true })
})

describe('MCPB extraction publication', () => {
  test('extracts nested files with executable modes and reuses the safe cache', async () => {
    const pluginPath = await setupPlugin('valid-plugin', makeBundle())
    const first = await loadMcpbFile('server.mcpb', pluginPath, 'fixture@marketplace')
    if ('status' in first) throw new Error('Unexpected MCPB config prompt')
    expect(first.extractedPath.startsWith(canonicalConfigHome)).toBe(true)
    expect(await readFile(join(first.extractedPath, 'bin/server.js'), 'utf8')).toBe(
      'console.log("ok")',
    )
    if (!('command' in first.mcpConfig)) {
      throw new Error('Expected a stdio MCP configuration')
    }
    expect(first.mcpConfig.command).toBe('node')
    expect(first.mcpConfig.args).toContain(join(first.extractedPath, 'bin/server.js'))
    if (process.platform !== 'win32') {
      expect((await stat(join(first.extractedPath, 'bin/server.js'))).mode & 0o111).not.toBe(0)
    }
    const second = await loadMcpbFile('server.mcpb', pluginPath, 'fixture@marketplace')
    expect(second.extractedPath).toBe(first.extractedPath)
  })

  test.each(['root', 'known-hash', 'intermediate'])('ignores plugin cache symlink: %s', async variant => {
    const bundle = makeBundle()
    const pluginPath = await setupPlugin(`symlink-${variant}`, bundle)
    const external = join(testRoot, `external-${variant}`)
    await mkdir(external)
    const sentinel = join(external, 'sentinel')
    await writeFile(sentinel, 'untouched')
    const legacyCache = join(pluginPath, '.mcpb-cache')
    if (variant === 'root') {
      await symlink(external, legacyCache)
    } else {
      await mkdir(legacyCache)
      if (variant === 'known-hash') {
        const hash = createHash('sha256').update(bundle).digest('hex').slice(0, 16)
        await symlink(external, join(legacyCache, hash))
      } else {
        const hash = createHash('sha256').update(bundle).digest('hex').slice(0, 16)
        const extraction = join(legacyCache, hash)
        await mkdir(extraction)
        await symlink(external, join(extraction, 'bin'))
      }
    }
    const result = await loadMcpbFile('server.mcpb', pluginPath, 'fixture@marketplace')
    expect(result.extractedPath.startsWith(canonicalConfigHome)).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('untouched')
  })

  test('does not honor attacker-authored cache metadata paths', async () => {
    const bundle = makeBundle()
    const pluginPath = await setupPlugin('metadata-plugin', bundle)
    const source = 'server.mcpb'
    const pluginKey = cacheKey(await realpath(pluginPath))
    const sourceKey = cacheKey(source)
    const cacheDir = join(canonicalConfigHome, 'mcpb-cache', pluginKey, sourceKey)
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(cacheDir, 0o700)
    const metadataName = createHash('md5').update(source).digest('hex').slice(0, 8)
    const external = join(testRoot, 'metadata-target')
    await mkdir(external)
    await writeFile(join(external, 'sentinel'), 'untouched')
    await writeFile(
      join(cacheDir, `${metadataName}.metadata.json`),
      JSON.stringify({
        source,
        contentHash: createHash('sha256').update(bundle).digest('hex').slice(0, 16),
        extractedPath: external,
        cachedAt: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
      }),
    )
    const result = await loadMcpbFile(source, pluginPath, 'fixture@marketplace')
    expect(result.extractedPath.startsWith(cacheDir)).toBe(true)
    expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('untouched')
  })

  test('rejects traversal archive entries before publication', async () => {
    const pluginPath = await setupPlugin(
      'traversal-plugin',
      makeBundle({ '../escape.txt': strToU8('outside') }),
    )
    await expect(
      loadMcpbFile('server.mcpb', pluginPath, 'fixture@marketplace'),
    ).rejects.toThrow(/Unsafe file path|traversal/i)
    expect(await Bun.file(join(testRoot, 'escape.txt')).exists()).toBe(false)
  })

  test('rejects malformed manifests through the real parser', async () => {
    const pluginPath = await setupPlugin(
      'malformed-manifest-plugin',
      makeBundle({}, JSON.stringify({ manifest_version: '0.3', name: 17 })),
    )
    await expect(
      loadMcpbFile('server.mcpb', pluginPath, 'fixture@marketplace'),
    ).rejects.toThrow(/Invalid manifest/)
  })

  test('canonicalizes a configured config-home symlink without changing its mode', async () => {
    const alias = join(testRoot, 'config-alias')
    await symlink(configHome, alias)
    const pluginPath = await setupPlugin('config-symlink-plugin', makeBundle())
    process.env.CLAUDE_CONFIG_DIR = alias
    try {
      const result = await loadMcpbFile(
        'server.mcpb',
        pluginPath,
        'fixture@marketplace',
      )
      expect(result.extractedPath.startsWith(canonicalConfigHome)).toBe(true)
      expect((await stat(configHome)).mode & 0o777).toBe(configHomeMode)
    } finally {
      process.env.CLAUDE_CONFIG_DIR = configHome
    }
  })
})
