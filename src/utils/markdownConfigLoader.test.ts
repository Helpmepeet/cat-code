import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../bootstrap/state.js'
import { loadMarkdownFilesForSubdir } from './markdownConfigLoader.js'
import * as ripgrep from './ripgrep.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const scratchDirectories: string[] = []
const originalSources = getAllowedSettingSources()
const envNames = [
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
] as const
const originalEnv = new Map(envNames.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setAllowedSettingSources(originalSources)
  getManagedFilePath.cache.clear?.()
  loadMarkdownFilesForSubdir.cache.clear?.()
  resetSettingsCache()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createFixture(): { directory: string; cwd: string } {
  const directory = mkdtempSync(join(tmpdir(), 'markdown-discovery-'))
  scratchDirectories.push(directory)
  const cwd = join(directory, 'project')
  mkdirSync(cwd)
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'missing-user-config')
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = join(directory, 'missing-managed')
  delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  getManagedFilePath.cache.clear?.()
  resetSettingsCache()
  return { directory, cwd }
}

test('missing optional scopes do not discard a project agent discovered by ripgrep', async () => {
  const { cwd } = createFixture()
  const agentsDir = join(cwd, '.cat-code', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const agentPath = join(agentsDir, 'reviewer.md')
  writeFileSync(agentPath, '---\nname: reviewer\ndescription: Review code\n---\nReview it.\n')

  const files = await loadMarkdownFilesForSubdir('agents', cwd)

  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({
    filePath: agentPath,
    source: 'projectSettings',
    frontmatter: { name: 'reviewer', description: 'Review code' },
    content: 'Review it.\n',
  })
})

test('an installation with no optional markdown directories loads an empty catalog', async () => {
  const { cwd } = createFixture()

  await expect(loadMarkdownFilesForSubdir('agents', cwd)).resolves.toEqual([])
})

test('a ripgrep usage error from an existing source still propagates', async () => {
  const { directory, cwd } = createFixture()
  mkdirSync(join(cwd, '.cat-code', 'agents'), { recursive: true })
  mkdirSync(join(directory, 'missing-user-config', 'agents'), { recursive: true })
  mkdirSync(join(directory, 'missing-managed', '.cat-code', 'agents'), { recursive: true })
  const usageError = Object.assign(new Error('synthetic ripgrep usage error'), { code: 2 })
  const searchSpy = spyOn(ripgrep, 'ripGrep').mockRejectedValue(usageError)
  try {
    await expect(loadMarkdownFilesForSubdir('agents', cwd)).rejects.toBe(usageError)
  } finally {
    searchSpy.mockRestore()
  }
})
