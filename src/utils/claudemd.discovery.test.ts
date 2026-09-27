import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getProjectRoot,
  setAdditionalDirectoriesForClaudeMd,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import { getAutoMemEntrypoint, getAutoMemPath } from '../memdir/paths.js'
import {
  getExternalClaudeMdIncludes,
  getManagedAndUserConditionalRules,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  isMemoryFilePath,
  shouldShowClaudeMdExternalIncludesWarning,
  type MemoryFileInfo,
} from './claudemd.js'
import {
  getManagedSessionPolicy,
  setManagedSessionPolicy,
} from './managedSessionPolicy.js'
import {
  _setGlobalConfigCacheForTesting,
  getCurrentProjectConfig,
} from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from './settings/managedPath.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import type { InstructionFilesMode } from './instructionFiles.js'
import { normalizePathForComparison } from './file.js'

const originalCwd = getOriginalCwd()
const originalProjectRoot = getProjectRoot()
const originalSources = getAllowedSettingSources()
const originalAdditionalDirectories = getAdditionalDirectoriesForClaudeMd()
const originalFlagSettingsPath = getFlagSettingsPath()
const originalFlagSettingsInline = getFlagSettingsInline()
const originalManagedSessionPolicy = getManagedSessionPolicy()
const originalExternalIncludesApproval =
  getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved
const environmentNames = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'NODE_ENV',
  'USER_TYPE',
] as const
const originalEnvironment = new Map(
  environmentNames.map(name => [name, process.env[name]]),
)
const scratchDirectories: string[] = []

function resetDiscoveryCaches(): void {
  getMemoryFiles.cache.clear?.()
  getAutoMemPath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()
  getClaudeConfigHomeDir.cache.clear?.()
  resetSettingsCache()
  _setGlobalConfigCacheForTesting(null)
}

function createFixture(): {
  root: string
  project: string
  config: string
  managed: string
  additional: string
} {
  const root = mkdtempSync(join(tmpdir(), 'claudemd-discovery-'))
  scratchDirectories.push(root)
  const home = join(root, 'home')
  const config = join(root, 'config')
  const managed = join(root, 'managed')
  const project = join(root, 'project')
  const additional = join(root, 'additional')
  for (const directory of [home, config, managed, project, additional]) {
    mkdirSync(directory, { recursive: true })
  }

  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managed
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'ant'
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

  setAllowedSettingSources([
    'userSettings',
    'projectSettings',
    'localSettings',
  ])
  setManagedSessionPolicy(null)
  setOriginalCwd(realpathSync(project))
  setProjectRoot(realpathSync(project))
  setAdditionalDirectoriesForClaudeMd([])
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  resetDiscoveryCaches()

  execFileSync('git', ['init', '--quiet', project], {
    env: process.env,
    stdio: 'ignore',
  })

  return { root, project, config, managed, additional }
}

function writeInstruction(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeUserSettings(
  config: string,
  settings: Record<string, unknown>,
): void {
  writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
  getMemoryFiles.cache.clear?.()
}

function writeInstructionMode(
  config: string,
  mode: InstructionFilesMode | undefined,
  extra: Record<string, unknown> = {},
): void {
  writeUserSettings(config, {
    ...extra,
    ...(mode === undefined
      ? {}
      : {
          pluginConfigs: {
            'agents-md@builtin': {
              options: { instructionFiles: mode },
            },
          },
        }),
  })
}

function agentPaths(files: MemoryFileInfo[]): string[] {
  return files
    .filter(file => basename(file.path) === 'AGENTS.md')
    .map(file => pathKey(file.path))
}

function processedPathsFor(files: MemoryFileInfo[]): Set<string> {
  return new Set(
    files.flatMap(file => [
      normalizePathForComparison(file.path),
      pathKey(file.path),
    ]),
  )
}

function pathKey(path: string): string {
  return normalizePathForComparison(path)
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
}

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setAllowedSettingSources(originalSources)
  setManagedSessionPolicy(originalManagedSessionPolicy)
  getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved =
    originalExternalIncludesApproval
  setOriginalCwd(originalCwd)
  setProjectRoot(originalProjectRoot)
  setAdditionalDirectoriesForClaudeMd(originalAdditionalDirectories)
  setFlagSettingsPath(originalFlagSettingsPath)
  setFlagSettingsInline(originalFlagSettingsInline)
  resetDiscoveryCaches()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('loads AGENTS.md as Project instructions by default when no CLAUDE claim exists', async () => {
  const { project } = createFixture()
  const agentsPath = join(project, 'AGENTS.md')
  writeInstruction(agentsPath, 'DEFAULT_AGENTS_MARKER')

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([pathKey(agentsPath)])
  expect(
    files.find(
      file =>
        pathKey(file.path) === pathKey(agentsPath),
    )?.type,
  ).toBe('Project')
})

test.each([
  ['CLAUDE.md', 'CLAUDE.md'],
  ['.cat-code/CLAUDE.md', '.cat-code/CLAUDE.md'],
  ['.claude/CLAUDE.md', '.claude/CLAUDE.md'],
  ['CLAUDE.local.md', 'CLAUDE.local.md'],
] as const)(
  '%s is a project-global fallback claim when its source is enabled',
  async (relativePath, _label) => {
    const { project } = createFixture()
    const agentsPath = join(project, 'AGENTS.md')
    writeInstruction(agentsPath, 'FALLBACK_AGENT_MARKER')

    expect(agentPaths(await getMemoryFiles())).toEqual([
      pathKey(agentsPath),
    ])

    writeInstruction(join(project, relativePath), 'CLAUDE_CLAIM_MARKER')
    getMemoryFiles.cache.clear?.()
    const files = await getMemoryFiles()

    expect(agentPaths(files)).toEqual([])
    expect(files.some(file => file.content.includes('CLAUDE_CLAIM_MARKER'))).toBe(
      true,
    )
    if (relativePath === 'CLAUDE.local.md') {
      setAllowedSettingSources(['userSettings', 'projectSettings'])
      getMemoryFiles.cache.clear?.()
      expect(agentPaths(await getMemoryFiles())).toEqual([
        pathKey(agentsPath),
      ])
    }
  },
)

test('a root CLAUDE claim suppresses eager and nested AGENTS throughout the project', async () => {
  const { project } = createFixture()
  const rootAgentsPath = join(project, 'AGENTS.md')
  writeInstruction(rootAgentsPath, 'ROOT_AGENT_MARKER')
  expect(agentPaths(await getMemoryFiles())).toEqual([
    pathKey(rootAgentsPath),
  ])

  writeInstruction(join(project, 'CLAUDE.md'), 'ROOT_CLAUDE_MARKER')
  const child = join(project, 'child')
  const childAgentsPath = join(child, 'AGENTS.md')
  writeInstruction(childAgentsPath, 'CHILD_AGENT_MARKER')
  getMemoryFiles.cache.clear?.()

  const eagerFiles = await getMemoryFiles()
  const nestedFiles = await getMemoryFilesForNestedDirectory(
    child,
    join(child, 'file.ts'),
    processedPathsFor(eagerFiles),
  )

  expect(agentPaths(eagerFiles)).toEqual([])
  expect(agentPaths(nestedFiles)).toEqual([])
})

test('nested CLAUDE claims only its directory while a deeper directory may use AGENTS', async () => {
  const { project } = createFixture()
  const rootAgentsPath = join(project, 'AGENTS.md')
  const child = join(project, 'child')
  const childAgentsPath = join(child, 'AGENTS.md')
  const deep = join(child, 'deep')
  const deepAgentsPath = join(deep, 'AGENTS.md')
  writeInstruction(rootAgentsPath, 'ROOT_AGENT_MARKER')
  writeInstruction(join(child, 'CLAUDE.md'), 'CHILD_CLAUDE_MARKER')
  writeInstruction(childAgentsPath, 'CHILD_AGENT_MARKER')
  writeInstruction(deepAgentsPath, 'DEEP_AGENT_MARKER')

  const eagerFiles = await getMemoryFiles()
  const processedPaths = processedPathsFor(eagerFiles)
  const childFiles = await getMemoryFilesForNestedDirectory(
    child,
    join(child, 'file.ts'),
    processedPaths,
  )
  for (const file of childFiles) processedPaths.add(file.path)
  const deepFiles = await getMemoryFilesForNestedDirectory(
    deep,
    join(deep, 'file.ts'),
    processedPaths,
  )

  expect(agentPaths(eagerFiles)).toEqual([
    pathKey(rootAgentsPath),
  ])
  expect(agentPaths(childFiles)).toEqual([])
  expect(childFiles.some(file => file.content.includes('CHILD_CLAUDE_MARKER'))).toBe(
    true,
  )
  expect(agentPaths(deepFiles)).toEqual([
    pathKey(deepAgentsPath),
  ])
})

test('claude-md mode ignores AGENTS while both mode loads the pinned directory order', async () => {
  const { project, config } = createFixture()
  const claudePath = join(project, 'CLAUDE.md')
  const catCodeClaudePath = join(project, '.cat-code', 'CLAUDE.md')
  const dotClaudePath = join(project, '.claude', 'CLAUDE.md')
  const agentsPath = join(project, 'AGENTS.md')
  const catCodeAgentsPath = join(project, '.cat-code', 'AGENTS.md')
  const dotClaudeAgentsPath = join(project, '.claude', 'AGENTS.md')
  const catCodeRulePath = join(project, '.cat-code', 'rules', 'a.md')
  const dotClaudeRulePath = join(project, '.claude', 'rules', 'b.md')
  const localPath = join(project, 'CLAUDE.local.md')
  for (const path of [
    claudePath,
    catCodeClaudePath,
    dotClaudePath,
    agentsPath,
    catCodeAgentsPath,
    dotClaudeAgentsPath,
    catCodeRulePath,
    dotClaudeRulePath,
    localPath,
  ]) {
    writeInstruction(path, `ORDER_MARKER_${basename(path)}`)
  }

  writeInstructionMode(config, 'claude-md')
  expect(agentPaths(await getMemoryFiles())).toEqual([])

  writeInstructionMode(config, 'claude-md-and-agents-md')
  const files = await getMemoryFiles()
  expect(files.map(file => pathKey(file.path))).toEqual(
    [
      claudePath,
      catCodeClaudePath,
      dotClaudePath,
      agentsPath,
      dotClaudeAgentsPath,
      catCodeRulePath,
      dotClaudeRulePath,
      localPath,
    ].map(pathKey),
  )
})

test('nested instructions put CLAUDE.local.md after project rules', async () => {
  const { project, config } = createFixture()
  const directory = join(project, 'child')
  const orderedPaths = [
    join(directory, 'CLAUDE.md'),
    join(directory, '.cat-code', 'CLAUDE.md'),
    join(directory, '.claude', 'CLAUDE.md'),
    join(directory, 'AGENTS.md'),
    join(directory, '.claude', 'AGENTS.md'),
    join(directory, '.cat-code', 'rules', 'a.md'),
    join(directory, '.claude', 'rules', 'b.md'),
    join(directory, 'CLAUDE.local.md'),
  ]
  for (const path of orderedPaths) {
    writeInstruction(path, `NESTED_ORDER_${basename(path)}`)
  }
  writeInstructionMode(config, 'claude-md-and-agents-md')

  const files = await getMemoryFilesForNestedDirectory(
    directory,
    join(directory, 'file.ts'),
    new Set(),
  )

  expect(files.map(file => pathKey(file.path))).toEqual(orderedPaths.map(pathKey))
})

test('CLAUDE.local.md only claims fallback when localSettings is enabled', async () => {
  const { project } = createFixture()
  const agentsPath = join(project, 'AGENTS.md')
  writeInstruction(agentsPath, 'LOCAL_SETTINGS_FALLBACK_MARKER')
  writeInstruction(join(project, 'CLAUDE.local.md'), 'LOCAL_CLAUDE_MARKER')

  setAllowedSettingSources(['userSettings', 'projectSettings'])

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([pathKey(agentsPath)])
  expect(files.some(file => file.content.includes('LOCAL_CLAUDE_MARKER'))).toBe(
    false,
  )
})

test('project and local settings cannot select the instruction-file mode', async () => {
  const { project } = createFixture()
  const agentsPath = join(project, 'AGENTS.md')
  writeInstruction(agentsPath, 'SOURCE_RULES_AGENT_MARKER')
  writeInstruction(
    join(project, '.cat-code', 'settings.json'),
    JSON.stringify({
      pluginConfigs: {
        'agents-md@builtin': {
          options: { instructionFiles: 'managed-only' },
        },
      },
    }),
  )
  writeInstruction(
    join(project, '.cat-code', 'settings.local.json'),
    JSON.stringify({
      pluginConfigs: {
        'agents-md@builtin': {
          options: { instructionFiles: 'claude-md' },
        },
      },
    }),
  )

  expect(agentPaths(await getMemoryFiles())).toEqual([
    pathKey(agentsPath),
  ])
})

test('claudeMdExcludes applies to AGENTS while another AGENTS candidate remains loadable', async () => {
  const { project, config } = createFixture()
  const excludedPath = join(project, 'AGENTS.md')
  const includedPath = join(project, '.claude', 'AGENTS.md')
  writeInstruction(excludedPath, 'EXCLUDED_AGENTS_MARKER')
  writeInstruction(includedPath, 'INCLUDED_AGENTS_MARKER')
  writeInstructionMode(config, 'claude-md-and-agents-md', {
    claudeMdExcludes: [excludedPath],
  })

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([pathKey(includedPath)])
  expect(isMemoryFilePath(includedPath)).toBe(true)
})

test('claudeMdExcludes applies to the resolved target of an AGENTS symlink', async () => {
  const { project, config } = createFixture()
  const targetPath = join(project, 'excluded', 'AGENTS.md')
  const aliasPath = join(project, 'AGENTS.md')
  writeInstruction(targetPath, 'EXCLUDED_SYMLINK_TARGET_MARKER')
  symlinkSync(targetPath, aliasPath)
  writeInstructionMode(config, 'claude-md-and-agents-md', {
    claudeMdExcludes: [targetPath],
  })

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([])
  expect(
    files.some(file => file.content.includes('EXCLUDED_SYMLINK_TARGET_MARKER')),
  ).toBe(false)
})

test('AGENTS symlink aliases do not duplicate CLAUDE while both mode still loads other AGENTS', async () => {
  const { project, config } = createFixture()
  const claudePath = join(project, 'CLAUDE.md')
  const agentsAlias = join(project, 'AGENTS.md')
  const dotClaudeAgentsPath = join(project, '.claude', 'AGENTS.md')
  writeInstruction(claudePath, 'SHARED_SYMLINK_CONTENT')
  mkdirSync(dirname(dotClaudeAgentsPath), { recursive: true })
  symlinkSync(claudePath, agentsAlias)
  writeInstruction(dotClaudeAgentsPath, 'DISTINCT_AGENTS_CONTENT')
  writeInstructionMode(config, 'claude-md-and-agents-md')

  const files = await getMemoryFiles()

  expect(files.filter(file => file.content.includes('SHARED_SYMLINK_CONTENT'))).toHaveLength(1)
  expect(agentPaths(files)).toEqual([
    pathKey(dotClaudeAgentsPath),
  ])
})

test('an eager AGENTS alias outside the working directory needs external-import approval', async () => {
  const { project, additional } = createFixture()
  const target = join(additional, 'AGENTS.md')
  const alias = join(project, 'AGENTS.md')
  writeInstruction(target, 'EXTERNAL_EAGER_AGENT_MARKER')
  symlinkSync(target, alias)

  expect(agentPaths(await getMemoryFiles())).toEqual([])
  expect(await shouldShowClaudeMdExternalIncludesWarning()).toBe(true)
  expect(
    getExternalClaudeMdIncludes(await getMemoryFiles(true)).map(file => ({
      path: pathKey(file.path),
      parent: pathKey(file.parent),
    })),
  ).toEqual([{ path: pathKey(target), parent: pathKey(alias) }])

  getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved = true
  getMemoryFiles.cache.clear?.()
  expect(agentPaths(await getMemoryFiles())).toEqual([pathKey(alias)])
})

test('external user and managed instructions remain loadable without project approval', async () => {
  const { project, additional, config, managed } = createFixture()
  const userTarget = join(additional, 'user.md')
  const managedTarget = join(additional, 'managed.md')
  writeInstruction(userTarget, 'EXTERNAL_USER_INSTRUCTION_MARKER')
  writeInstruction(managedTarget, 'EXTERNAL_MANAGED_INSTRUCTION_MARKER')
  symlinkSync(userTarget, join(config, 'CLAUDE.md'))
  symlinkSync(managedTarget, join(managed, 'CLAUDE.md'))
  writeInstruction(join(project, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MARKER')

  const files = await getMemoryFiles()
  expect(
    files.some(
      file =>
        file.type === 'User' &&
        file.content.includes('EXTERNAL_USER_INSTRUCTION_MARKER'),
    ),
  ).toBe(true)
  expect(
    files.some(
      file =>
        file.type === 'Managed' &&
        file.content.includes('EXTERNAL_MANAGED_INSTRUCTION_MARKER'),
    ),
  ).toBe(true)
  expect(await shouldShowClaudeMdExternalIncludesWarning()).toBe(false)
})

test('an ancestor AGENTS alias cannot bypass approval when the original cwd is nested', async () => {
  const { project, additional } = createFixture()
  const child = join(project, 'child')
  const alias = join(project, 'AGENTS.md')
  const target = join(additional, 'AGENTS.md')
  writeInstruction(target, 'EXTERNAL_ANCESTOR_AGENT_MARKER')
  mkdirSync(child)
  symlinkSync(target, alias)
  setOriginalCwd(realpathSync(child))
  resetDiscoveryCaches()

  expect(agentPaths(await getMemoryFiles())).toEqual([])
  expect(await shouldShowClaudeMdExternalIncludesWarning()).toBe(true)

  rmSync(alias)
  writeInstruction(alias, 'ORDINARY_ANCESTOR_AGENT_MARKER')
  getMemoryFiles.cache.clear?.()
  expect(agentPaths(await getMemoryFiles())).toEqual([pathKey(alias)])
})

test('nested AGENTS aliases outside the working directory stay blocked until approval', async () => {
  const { project, additional } = createFixture()
  const child = join(project, 'child')
  const target = join(additional, 'AGENTS.md')
  const alias = join(child, 'AGENTS.md')
  writeInstruction(target, 'EXTERNAL_NESTED_AGENT_MARKER')
  mkdirSync(child)
  symlinkSync(target, alias)

  expect(
    agentPaths(
      await getMemoryFilesForNestedDirectory(
        child,
        join(child, 'file.ts'),
        new Set(),
      ),
    ),
  ).toEqual([])

  getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved = true
  expect(
    agentPaths(
      await getMemoryFilesForNestedDirectory(
        child,
        join(child, 'file.ts'),
        new Set(),
      ),
    ),
  ).toEqual([pathKey(alias)])
})

test('nested AGENTS does not reload an eager file through a different alias', async () => {
  const { project } = createFixture()
  const eager = join(project, 'AGENTS.md')
  const child = join(project, 'child')
  const alias = join(child, 'AGENTS.md')
  const target = join(project, 'shared', 'AGENTS.md')
  writeInstruction(target, 'SHARED_EAGER_NESTED_MARKER')
  symlinkSync(target, eager)
  mkdirSync(child)
  symlinkSync(target, alias)

  const eagerFiles = await getMemoryFiles()
  const nestedFiles = await getMemoryFilesForNestedDirectory(
    child,
    join(child, 'file.ts'),
    new Set(eagerFiles.map(file => normalizePathForComparison(file.path))),
  )

  expect(agentPaths(eagerFiles)).toEqual([pathKey(eager)])
  expect(agentPaths(nestedFiles)).toEqual([])
})

test('managed-only keeps managed instructions and recalled memory but blocks every project and user entry path', async () => {
  const { project, config, managed, additional } = createFixture()
  const managedClaudePath = join(managed, 'CLAUDE.md')
  const projectRulePath = join(project, '.claude', 'rules', 'project.md')
  const additionalRulePath = join(additional, '.claude', 'rules', 'extra.md')
  writeInstruction(managedClaudePath, 'MANAGED_ONLY_MANAGED_MARKER')
  writeInstruction(join(managed, '.cat-code', 'rules', 'managed.md'), 'MANAGED_RULE_MARKER')
  writeInstruction(join(config, 'CLAUDE.md'), 'MANAGED_ONLY_USER_MARKER')
  writeInstruction(join(config, 'rules', 'user.md'), 'MANAGED_ONLY_USER_RULE_MARKER')
  writeInstruction(
    join(config, 'rules', 'conditional.md'),
    "---\npaths: '**/*'\n---\nMANAGED_ONLY_USER_CONDITIONAL_MARKER",
  )
  writeInstruction(join(project, 'CLAUDE.md'), 'MANAGED_ONLY_PROJECT_MARKER')
  writeInstruction(join(project, 'CLAUDE.local.md'), 'MANAGED_ONLY_LOCAL_MARKER')
  writeInstruction(join(project, 'AGENTS.md'), 'MANAGED_ONLY_AGENTS_MARKER')
  writeInstruction(projectRulePath, 'MANAGED_ONLY_PROJECT_RULE_MARKER')
  writeInstruction(
    join(project, '.claude', 'rules', 'conditional.md'),
    "---\npaths: '**/*'\n---\nMANAGED_ONLY_PROJECT_CONDITIONAL_MARKER",
  )
  writeInstruction(join(additional, 'CLAUDE.md'), 'MANAGED_ONLY_ADD_DIR_MARKER')
  writeInstruction(additionalRulePath, 'MANAGED_ONLY_ADD_DIR_RULE_MARKER')
  process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
  setAdditionalDirectoriesForClaudeMd([additional])
  writeInstructionMode(config, 'managed-only')

  const autoMemoryPath = getAutoMemEntrypoint()
  writeInstruction(autoMemoryPath, 'MANAGED_ONLY_RECALLED_MEMORY_MARKER')
  const files = await getMemoryFiles()
  const nestedFiles = await getMemoryFilesForNestedDirectory(
    project,
    join(project, 'file.ts'),
    new Set(),
  )
  const cwdRules = await getConditionalRulesForCwdLevelDirectory(
    project,
    join(project, 'file.ts'),
    new Set(),
  )
  const userRules = await getManagedAndUserConditionalRules(
    join(project, 'file.ts'),
    new Set(),
  )

  expect(files.map(file => file.type)).toEqual(['Managed', 'Managed', 'AutoMem'])
  expect(nestedFiles).toEqual([])
  expect(cwdRules).toEqual([])
  expect(userRules).toEqual([])
  expect(files.some(file => file.content.includes('MANAGED_ONLY_MANAGED_MARKER'))).toBe(
    true,
  )
  expect(files.some(file => file.content.includes('MANAGED_ONLY_RECALLED_MEMORY_MARKER'))).toBe(
    true,
  )
  for (const marker of [
    'MANAGED_ONLY_USER_MARKER',
    'MANAGED_ONLY_USER_RULE_MARKER',
    'MANAGED_ONLY_USER_CONDITIONAL_MARKER',
    'MANAGED_ONLY_PROJECT_MARKER',
    'MANAGED_ONLY_LOCAL_MARKER',
    'MANAGED_ONLY_AGENTS_MARKER',
    'MANAGED_ONLY_PROJECT_RULE_MARKER',
    'MANAGED_ONLY_PROJECT_CONDITIONAL_MARKER',
    'MANAGED_ONLY_ADD_DIR_MARKER',
    'MANAGED_ONLY_ADD_DIR_RULE_MARKER',
  ]) {
    expect(files.some(file => file.content.includes(marker))).toBe(false)
  }
})

test('AGENTS discovery stays out of --add-dir while project-root fallback still works', async () => {
  const { project, additional } = createFixture()
  const rootAgentsPath = join(project, 'AGENTS.md')
  const additionalAgentsPath = join(additional, 'AGENTS.md')
  writeInstruction(rootAgentsPath, 'ROOT_ADD_DIR_MARKER')
  writeInstruction(additionalAgentsPath, 'ADDITIONAL_AGENTS_MARKER')
  process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
  setAdditionalDirectoriesForClaudeMd([additional])

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([
    pathKey(rootAgentsPath),
  ])
})

test('a managed chat cannot receive AGENTS from its working directory, ancestors, nested reads, or user rules', async () => {
  const { root, project, config } = createFixture()
  const child = join(project, 'child')
  const rootAgentsPath = join(project, 'AGENTS.md')
  const childAgentsPath = join(child, 'AGENTS.md')
  const ancestorAgentsPath = join(root, 'AGENTS.md')
  writeInstruction(rootAgentsPath, 'MANAGED_CHAT_ROOT_AGENT_MARKER')
  writeInstruction(childAgentsPath, 'MANAGED_CHAT_CHILD_AGENT_MARKER')
  writeInstruction(ancestorAgentsPath, 'MANAGED_CHAT_ANCESTOR_AGENT_MARKER')
  writeInstruction(
    join(config, 'CLAUDE.md'),
    `@${rootAgentsPath}\n@${ancestorAgentsPath}\n@${childAgentsPath}`,
  )
  writeInstruction(
    join(config, 'rules', 'project-agent.md'),
    `@${rootAgentsPath}\n@${ancestorAgentsPath}\n@${childAgentsPath}`,
  )
  setManagedSessionPolicy({
    workingDirectory: project,
    temporaryDirectory: join(project, 'tmp'),
    storageRootId: '16fe164c-1b0f-494e-a9ad-6fd4e8d4f071',
    storageId: 'f54a27bd-b16b-4a96-b39b-3748c8f98344',
  })
  resetDiscoveryCaches()

  const eagerFiles = await getMemoryFiles()
  const nestedFiles = await getMemoryFilesForNestedDirectory(
    child,
    join(child, 'file.ts'),
    processedPathsFor(eagerFiles),
  )
  const cwdRules = await getConditionalRulesForCwdLevelDirectory(
    project,
    join(project, 'file.ts'),
    new Set(),
  )

  expect(agentPaths(eagerFiles)).toEqual([])
  expect(agentPaths(nestedFiles)).toEqual([])
  expect(agentPaths(cwdRules)).toEqual([])
  expect(
    eagerFiles.some(
      file =>
        file.content.includes('MANAGED_CHAT_ROOT_AGENT_MARKER') ||
        file.content.includes('MANAGED_CHAT_CHILD_AGENT_MARKER') ||
        file.content.includes('MANAGED_CHAT_ANCESTOR_AGENT_MARKER'),
    ),
  ).toBe(false)
  expect(eagerFiles.some(file => file.type === 'User')).toBe(true)
  expect(
    await getManagedAndUserConditionalRules(
      join(project, 'file.ts'),
      new Set(),
    ),
  ).toEqual([])
})

test('nested worktrees use their eligible instruction files instead of skipped main-repo files', async () => {
  const { root, project } = createFixture()
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  writeInstruction(join(project, 'README.md'), 'worktree fixture')
  execFileSync('git', ['-C', project, 'config', 'user.name', 'Test User'], {
    env: gitEnvironment,
    stdio: 'ignore',
  })
  execFileSync(
    'git',
    ['-C', project, 'config', 'user.email', 'test@example.invalid'],
    { env: gitEnvironment, stdio: 'ignore' },
  )
  execFileSync('git', ['-C', project, 'add', 'README.md'], {
    env: gitEnvironment,
    stdio: 'ignore',
  })
  execFileSync('git', ['-C', project, 'commit', '--quiet', '-m', 'fixture'], {
    env: gitEnvironment,
    stdio: 'ignore',
  })
  const worktree = join(root, 'worktree')
  execFileSync(
    'git',
    ['-C', project, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'],
    { env: gitEnvironment, stdio: 'ignore' },
  )
  writeInstruction(join(project, 'CLAUDE.md'), 'SKIPPED_MAIN_REPO_CLAIM')
  const worktreeAgentsPath = join(worktree, 'AGENTS.md')
  writeInstruction(worktreeAgentsPath, 'WORKTREE_AGENT_MARKER')
  setOriginalCwd(realpathSync(worktree))
  setProjectRoot(realpathSync(worktree))
  resetDiscoveryCaches()

  const files = await getMemoryFiles()

  expect(agentPaths(files)).toEqual([
    pathKey(worktreeAgentsPath),
  ])
  expect(files.some(file => file.content.includes('SKIPPED_MAIN_REPO_CLAIM'))).toBe(
    false,
  )
})
