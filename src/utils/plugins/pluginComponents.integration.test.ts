import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Command } from '../../types/command.js'
import type { PluginError } from '../../types/plugin.js'
import type { PluginMarketplaceEntry } from './schemas.js'

const fixture = await mkdtemp(join(tmpdir(), 'plugin-components-'))
const previousEnv = { ...process.env }
const realFetch = globalThis.fetch
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'initial-config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
process.env.DISABLE_TELEMETRY = '1'
process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = join(fixture, 'managed')
delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
delete process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL
globalThis.fetch = (async () => {
  throw new Error('Network forbidden in plugin component integration tests')
}) as unknown as typeof fetch

const state = await import('../../bootstrap/state.js')
const previousSources = state.getAllowedSettingSources()
const previousCwd = state.getCwdState()
const previousOriginalCwd = state.getOriginalCwd()
const previousProjectRoot = state.getProjectRoot()
const { getManagedFilePath, getManagedSettingsDropInDir } = await import('../settings/managedPath.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')
const { clearInstalledPluginsCache } = await import('./installedPluginsManager.js')
const { saveKnownMarketplacesConfig } = await import('./marketplaceManager.js')
const { createPluginFromPath, clearPluginCache, loadAllPlugins, loadAllPluginsCacheOnly } = await import('./pluginLoader.js')
const { getPluginCommands, getPluginSkills } = await import('./loadPluginCommands.js')
const { loadPluginAgents } = await import('./loadPluginAgents.js')
const { loadPluginOutputStyles } = await import('./loadPluginOutputStyles.js')
let caseRoot: string

function clearCaches(): void {
  clearPluginCache()
  clearInstalledPluginsCache()
  resetSettingsCache()
  getPluginCommands.cache.clear?.()
  getPluginSkills.cache.clear?.()
  loadPluginAgents.cache.clear?.()
  loadPluginOutputStyles.cache.clear?.()
}

beforeEach(async () => {
  caseRoot = await mkdtemp(join(fixture, 'case-'))
  process.env.CLAUDE_CONFIG_DIR = join(caseRoot, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(caseRoot, 'plugin-cache')
  process.env.USER_TYPE = 'ant'
  getManagedFilePath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  state.setCwdState(caseRoot)
  state.setOriginalCwd(caseRoot)
  state.setProjectRoot(caseRoot)
  state.setInlinePlugins([])
  state.setAllowedSettingSources(['userSettings'])
  clearCaches()
})

afterEach(() => {
  state.setInlinePlugins([])
  clearCaches()
})

afterAll(async () => {
  state.setAllowedSettingSources(previousSources)
  state.setCwdState(previousCwd)
  state.setOriginalCwd(previousOriginalCwd)
  state.setProjectRoot(previousProjectRoot)
  globalThis.fetch = realFetch
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key]
  }
  Object.assign(process.env, previousEnv)
  getManagedFilePath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  await rm(fixture, { recursive: true, force: true })
})

async function file(root: string, path: string, content: string | object): Promise<void> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content))
}

function hooks(command: string) {
  return { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command' as const, command }] }] }
}

async function defaults(root: string): Promise<void> {
  await file(root, 'commands/default.md', '---\ndescription: Default command\n---\nCommand at ${CLAUDE_PLUGIN_ROOT}: $ARGUMENTS')
  await file(root, 'agents/guide.md', '---\nname: guide\ndescription: Review a source file\n---\nReview files at ${CLAUDE_PLUGIN_ROOT}.')
  await file(root, 'skills/inspect/SKILL.md', '---\ndescription: Inspect a source file\n---\nSkill at ${CLAUDE_SKILL_DIR}: $ARGUMENTS')
  await file(root, 'output-styles/clear.md', '---\nname: clear\ndescription: Clear output\n---\nUse concise concrete sentences.')
  await file(root, 'hooks/hooks.json', { hooks: hooks('echo standard-hook') })
}

function pathErrors(errors: PluginError[]) {
  return errors.map(error => {
    if (error.type !== 'path-not-found') throw new Error(`Unexpected error: ${error.type}`)
    return { component: error.component, path: error.path, plugin: error.plugin, source: error.source }
  })
}

async function marketplace(entry: Omit<PluginMarketplaceEntry, 'source'>): Promise<string> {
  const root = join(caseRoot, 'marketplace')
  await file(root, '.claude-plugin/marketplace.json', {
    name: 'component-fixtures', owner: { name: 'Integration fixture' },
    plugins: [{ ...entry, source: './payload' }],
  })
  await saveKnownMarketplacesConfig({
    'component-fixtures': {
      source: { source: 'directory', path: root },
      installLocation: root, lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  })
  await file(process.env.CLAUDE_CONFIG_DIR!, 'settings.json', {
    enabledPlugins: { [`${entry.name}@component-fixtures`]: true },
  })
  clearCaches()
  return join(root, 'payload')
}

// Plain-text fixtures have no prompt-shell expressions. Asking for shell
// permission state would fail the invocation instead of executing a command.
const promptContext = {
  getAppState() { throw new Error('Fixture commands must not execute prompt shell') },
} as unknown as Parameters<Extract<Command, { type: 'prompt' }>['getPromptForCommand']>[1]

test('default component discovery reaches command, skill, agent and output-style consumers', async () => {
  const root = join(caseRoot, 'default-plugin')
  await defaults(root)
  await file(root, '.claude-plugin/plugin.json', { name: 'discovery', version: '1.0.0' })
  state.setInlinePlugins([root])

  const loaded = await loadAllPluginsCacheOnly()
  expect(loaded.errors).toEqual([])
  const plugin = loaded.enabled.find(value => value.name === 'discovery')!
  expect(plugin).toMatchObject({
    commandsPath: join(root, 'commands'), agentsPath: join(root, 'agents'),
    skillsPath: join(root, 'skills'), outputStylesPath: join(root, 'output-styles'),
    hooksConfig: hooks('echo standard-hook'),
  })
  const commands = await getPluginCommands()
  const skills = await getPluginSkills()
  const command = commands.find(value => value.name === 'discovery:default')
  const skill = skills.find(value => value.name === 'discovery:inspect')
  if (command?.type !== 'prompt' || skill?.type !== 'prompt') throw new Error('Expected discovered prompts')
  expect(await command.getPromptForCommand('command-argument', promptContext)).toEqual([
    { type: 'text', text: `Command at ${root}: command-argument` },
  ])
  expect(await skill.getPromptForCommand('skill-argument', promptContext)).toEqual([
    { type: 'text', text: `Base directory for this skill: ${join(root, 'skills/inspect')}\n\nSkill at ${join(root, 'skills/inspect')}: skill-argument` },
  ])
  expect((await loadPluginAgents()).map(agent => agent.agentType)).toContain('discovery:guide')
  expect(await loadPluginOutputStyles()).toContainEqual({
    name: 'discovery:clear', description: 'Clear output',
    prompt: 'Use concise concrete sentences.', source: 'plugin', forceForPlugin: undefined,
  })
})

test.each([
  { format: 'source', commands: './explicit/run.md', commandPaths: ['explicit/run.md'] },
  { format: 'array', commands: ['./explicit/run.md', './absent-command.md', './explicit/run.md'], commandPaths: ['explicit/run.md', 'explicit/run.md'] },
  { format: 'mapping', commands: {
    renamed: { source: './explicit/run.md', description: 'Manifest alias' },
    inline: { content: 'Inline manifest prompt' },
    missing: { source: './absent-command.md' },
  }, commandPaths: ['explicit/run.md'] },
])('explicit $format commands suppress defaults and retain valid paths and ordered diagnostics', async ({ format, commands, commandPaths }) => {
  const root = join(caseRoot, 'explicit-plugin')
  await defaults(root)
  await file(root, 'explicit/run.md', 'Explicit command')
  await file(root, 'explicit/agent.md', 'Explicit agent')
  await file(root, 'explicit/skill/SKILL.md', 'Explicit skill')
  await file(root, 'explicit/style.md', 'Explicit style')
  await file(root, '.claude-plugin/plugin.json', {
    name: 'explicit', commands,
    agents: ['./explicit/agent.md', './absent-agent.md'],
    skills: ['./explicit/skill', './absent-skill'],
    outputStyles: ['./explicit/style.md', './absent-style.md'],
  })
  const { plugin, errors } = await createPluginFromPath(root, 'fixture-source', true, 'fallback')
  for (const field of ['commandsPath', 'agentsPath', 'skillsPath', 'outputStylesPath'] as const) expect(plugin[field]).toBeUndefined()
  expect(plugin.commandsPaths).toEqual(commandPaths.map(path => join(root, path)))
  expect(plugin.agentsPaths).toEqual([join(root, 'explicit/agent.md')])
  expect(plugin.skillsPaths).toEqual([join(root, 'explicit/skill')])
  expect(plugin.outputStylesPaths).toEqual([join(root, 'explicit/style.md')])
  const missing = [
    ...(format === 'source' ? [] : [['commands', 'absent-command.md'] as const]),
    ['agents', 'absent-agent.md'], ['skills', 'absent-skill'], ['output-styles', 'absent-style.md'],
  ] as const
  expect(pathErrors(errors)).toEqual(missing.map(([component, path]) => ({
    component, path: join(root, path!), plugin: 'explicit', source: 'fixture-source',
  })))
  if (format === 'mapping') {
    expect(plugin.commandsMetadata).toEqual({
      renamed: { source: './explicit/run.md', description: 'Manifest alias' },
      inline: { content: 'Inline manifest prompt' },
    })
    state.setInlinePlugins([root])
    const discovered = await getPluginCommands()
    expect(discovered.map(value => value.name).sort()).toEqual(['explicit:inline', 'explicit:renamed'])
    const inline = discovered.find(value => value.name === 'explicit:inline')!
    if (inline.type !== 'prompt') throw new Error('Expected inline prompt')
    expect(await inline.getPromptForCommand('', promptContext)).toEqual([{ type: 'text', text: 'Inline manifest prompt' }])
    expect(discovered.find(value => value.name === 'explicit:renamed')?.description).toBe('Manifest alias')
  }
})

test.each([{ declaration: 'array', commands: [] }, { declaration: 'mapping', commands: {} }])('an explicit empty $declaration commands declaration suppresses default discovery', async ({ commands }) => {
  const root = join(caseRoot, 'empty-plugin')
  await defaults(root)
  await file(root, '.claude-plugin/plugin.json', {
    name: 'empty', commands, agents: [], skills: [], outputStyles: [],
  })
  const { plugin, errors } = await createPluginFromPath(root, 'empty-source', true, 'fallback')
  expect(errors).toEqual([])
  for (const field of ['commandsPath', 'commandsPaths', 'commandsMetadata', 'agentsPath', 'agentsPaths', 'skillsPath', 'skillsPaths', 'outputStylesPath', 'outputStylesPaths'] as const) expect(plugin[field]).toBeUndefined()
})

test('manifest-free marketplace fallback retains default directories, replaces hooks and skips inline command metadata', async () => {
  const entryHooks = hooks('echo marketplace-hook')
  const root = await marketplace({
    name: 'fallback', strict: true, description: 'Marketplace manifest',
    commands: { remote: { source: './extra/remote.md' }, ignored: { content: 'Marketplace inline prompt' } },
    agents: './extra/agent.md', skills: './extra/skill', outputStyles: './extra/style.md', hooks: entryHooks,
  })
  await defaults(root)
  for (const path of ['extra/remote.md', 'extra/agent.md', 'extra/skill/SKILL.md', 'extra/style.md']) await file(root, path, 'Extra component')
  const loaded = await loadAllPluginsCacheOnly()
  expect(loaded.errors).toEqual([])
  const plugin = loaded.enabled.find(value => value.name === 'fallback')!
  expect(plugin.manifest.description).toBe('Marketplace manifest')
  expect(plugin).toMatchObject({
    commandsPath: join(root, 'commands'), commandsPaths: [join(root, 'extra/remote.md')],
    commandsMetadata: { remote: { source: './extra/remote.md' } },
    agentsPath: join(root, 'agents'), agentsPaths: [join(root, 'extra/agent.md')],
    skillsPath: join(root, 'skills'), skillsPaths: [join(root, 'extra/skill')],
    outputStylesPath: join(root, 'output-styles'), outputStylesPaths: [join(root, 'extra/style.md')],
    hooksConfig: entryHooks,
  })
  expect(plugin.commandsMetadata?.ignored).toBeUndefined()
})

test.each([
  { format: 'source-and-inline', loader: 'cache-only' },
  { format: 'inline-only', loader: 'cache-only' },
  { format: 'source-and-inline', loader: 'full' },
] as const)('marketplace supplements append paths and preserve metadata precedence for $format commands through $loader loading', async ({ format, loader }) => {
  const root = await marketplace({
    name: 'market-label', version: '1.0.0', strict: true,
    commands: format === 'source-and-inline'
      ? { alias: { source: './extra/remote.md', description: 'Marketplace alias' }, ignored: { content: 'Ignored inline' }, missing: { source: './absent-command.md' } }
      : { ignored: { content: 'Ignored inline' } },
    agents: ['./extra/agent.md', './absent-agent.md'], skills: './extra/skill',
    outputStyles: './extra/style.md', hooks: hooks('echo marketplace-hook'),
  })
  const localHooks = { ...hooks('echo local-hook'), PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command' as const, command: 'echo retained-hook' }] }] }
  await file(root, '.claude-plugin/plugin.json', {
    name: 'local-label', version: '1.0.0', commands: { alias: { source: './local/command.md', description: 'Local alias' }, localInline: { content: 'Local inline' } },
    agents: './local/agent.md', skills: './local/skill', outputStyles: './local/style.md', hooks: localHooks,
  })
  for (const path of ['local/command.md', 'local/agent.md', 'local/skill/SKILL.md', 'local/style.md', 'extra/remote.md', 'extra/agent.md', 'extra/skill/SKILL.md', 'extra/style.md']) await file(root, path, 'Component body')
  clearCaches()
  const loaded = await (loader === 'full' ? loadAllPlugins() : loadAllPluginsCacheOnly())
  const plugin = loaded.enabled.find(value => value.name === 'local-label')!
  expect(plugin).toBeDefined()
  const loadedRoot = plugin.path
  expect(plugin.commandsPaths).toEqual([
    join(loadedRoot, 'local/command.md'), ...(format === 'source-and-inline' ? [join(loadedRoot, 'extra/remote.md')] : []),
  ])
  expect(plugin.commandsMetadata).toEqual({
    alias: format === 'source-and-inline'
      ? { source: './extra/remote.md', description: 'Marketplace alias' }
      : { source: './local/command.md', description: 'Local alias' },
    localInline: { content: 'Local inline' },
  })
  expect(plugin.agentsPaths).toEqual([join(loadedRoot, 'local/agent.md'), join(loadedRoot, 'extra/agent.md')])
  expect(plugin.skillsPaths).toEqual([join(loadedRoot, 'local/skill'), join(loadedRoot, 'extra/skill')])
  expect(plugin.outputStylesPaths).toEqual([join(loadedRoot, 'local/style.md'), join(loadedRoot, 'extra/style.md')])
  expect(plugin.hooksConfig).toEqual({ ...localHooks, ...hooks('echo marketplace-hook') })
  expect(pathErrors(loaded.errors)).toEqual([
    ...(format === 'source-and-inline' ? [{ component: 'commands' as const, path: join(loadedRoot, 'absent-command.md'), plugin: 'market-label', source: 'market-label@component-fixtures' }] : []),
    { component: 'agents', path: join(loadedRoot, 'absent-agent.md'), plugin: 'market-label', source: 'market-label@component-fixtures' },
  ])
})

test('non-strict marketplace conflicts reject the plugin without leaking earlier component errors', async () => {
  const root = await marketplace({ name: 'conflict', strict: false, skills: './missing-marketplace-skill' })
  await file(root, '.claude-plugin/plugin.json', { name: 'local-conflict', agents: './missing-local-agent.md' })
  const result = await loadAllPluginsCacheOnly()
  expect(result.enabled).toEqual([])
  expect(result.disabled).toEqual([])
  expect(result.errors).toEqual([{
    type: 'generic-error', source: 'conflict@component-fixtures',
    error: 'Plugin conflict has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.',
  }])
})
