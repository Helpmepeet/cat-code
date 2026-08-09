import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { cleanupOrphanedPluginVersionsInBackground } from './cacheUtils.js'
import {
  addPluginInstallation,
  clearInstalledPluginsCache,
  getInstalledPluginsFilePath,
  loadInstalledPluginsFromDisk,
  loadInstalledPluginsV2,
} from './installedPluginsManager.js'

describe('installed plugins registry durability', () => {
  const originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'installed-plugins-'))
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = tempDir
    clearInstalledPluginsCache()
  })

  afterEach(() => {
    clearInstalledPluginsCache()
    if (originalPluginCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('keeps additions made through separate registry updates', () => {
    addPluginInstallation(
      'one@marketplace',
      'user',
      join(tempDir, 'cache', 'marketplace', 'one', '1.0.0'),
      { version: '1.0.0' },
    )
    addPluginInstallation(
      'two@marketplace',
      'user',
      join(tempDir, 'cache', 'marketplace', 'two', '2.0.0'),
      { version: '2.0.0' },
    )

    expect(Object.keys(loadInstalledPluginsFromDisk().plugins).sort()).toEqual([
      'one@marketplace',
      'two@marketplace',
    ])
  })

  test('does not turn a corrupt registry into an empty installation set', async () => {
    const versionPath = join(
      tempDir,
      'cache',
      'marketplace',
      'plugin',
      '1.0.0',
    )
    mkdirSync(versionPath, { recursive: true })
    writeFileSync(getInstalledPluginsFilePath(), '{ truncated json')

    expect(() => loadInstalledPluginsFromDisk()).toThrow()
    expect(() => loadInstalledPluginsV2()).toThrow()

    await cleanupOrphanedPluginVersionsInBackground()

    expect(existsSync(join(versionPath, '.orphaned_at'))).toBe(false)
    expect(readFileSync(getInstalledPluginsFilePath(), 'utf8')).toBe(
      '{ truncated json',
    )
  })
})
