import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = await mkdtemp(join(tmpdir(), 'plugin-skill-execution-'))
const previousEnv = { ...process.env }
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
process.env.DISABLE_TELEMETRY = '1'
const realFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('Network forbidden in plugin skill regression') }) as unknown as typeof fetch
const state = await import('../../bootstrap/state.js')
state.setCwdState(fixture)
state.setOriginalCwd(fixture)
state.setProjectRoot(fixture)

// Only the query response is scripted; plugin discovery, invocation, worker
// construction, hook lookup and cleanup run through their production owners.
const realQuery = await import('../../query.js')
const { createAssistantMessage } = await import('../messages.js')
const { getMatchingHooks } = await import('../hooks.js')
let workers: Array<{ agentType?: string; hooks: number; root?: string }> = []
mock.module('../../query.js', () => ({
  ...realQuery,
  query: async function* ({ toolUseContext }: { toolUseContext: import('../../Tool.js').ToolUseContext }) {
    const matches = await getMatchingHooks(toolUseContext.getAppState(), toolUseContext.agentId!, 'PreToolUse', {
      hook_event_name: 'PreToolUse', session_id: 'plugin-regression', cwd: fixture,
      transcript_path: '', tool_name: 'Bash', tool_input: {}, tool_use_id: 'probe',
    })
    const hook = toolUseContext.getAppState().sessionHooks.get(toolUseContext.agentId!)?.hooks.PreToolUse?.[0]
    workers.push({ agentType: toolUseContext.agentType, hooks: matches.length, root: hook?.skillRoot })
    yield createAssistantMessage({ content: 'Isolated worker completed' })
  },
}))
const { getPluginSkills } = await import('./loadPluginCommands.js')
const { clearPluginCache } = await import('./pluginLoader.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../fileStateCache.js')
const { processSlashCommand } = await import('../processUserInput/processSlashCommand.js')
const { SkillTool } = await import('../../tools/SkillTool/SkillTool.js')
const { EXPLORE_AGENT } = await import('../../tools/AgentTool/built-in/exploreAgent.js')
const { GENERAL_PURPOSE_AGENT } = await import('../../tools/AgentTool/built-in/generalPurposeAgent.js')
const { runWithCwdOverride } = await import('../cwd.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')
const { getManagedFilePath, getManagedSettingsDropInDir } = await import('../settings/managedPath.js')

afterAll(async () => {
  state.setInlinePlugins([])
  clearPluginCache()
  getPluginSkills.cache.clear?.()
  resetSettingsCache()
  mock.restore()
  globalThis.fetch = realFetch
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  await rm(fixture, { recursive: true, force: true })
})

test('plugin skill execution controls reach both slash and Skill worker lifecycles', async () => {
  const plugins = [
    { name: 'children', path: join(fixture, 'child-plugin'), dir: 'skills/inspect' },
    { name: 'direct', path: join(fixture, 'direct-plugin'), dir: 'direct-skill' },
  ]
  for (const plugin of plugins) {
    await mkdir(join(plugin.path, '.claude-plugin'), { recursive: true })
    await mkdir(join(plugin.path, plugin.dir), { recursive: true })
    await writeFile(join(plugin.path, '.claude-plugin/plugin.json'), JSON.stringify({
      name: plugin.name, version: '1.0.0', ...(plugin.name === 'direct' ? { skills: ['./direct-skill'] } : {}),
    }))
    await writeFile(join(plugin.path, plugin.dir, 'SKILL.md'), `---
description: Inspect the requested source in an Explore worker
context: fork
agent: Explore
paths:
  - src/feature/**
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo skill-hook
---
Inspect the requested source.
`)
  }
  state.setInlinePlugins(plugins.map(plugin => plugin.path))
  clearPluginCache()
  getPluginSkills.cache.clear?.()
  const commands = await getPluginSkills()
  expect(commands).toHaveLength(2)
  let appState = getDefaultAppState()
  const setAppState = (update: (prev: typeof appState) => typeof appState) => { appState = update(appState) }
  const context = {
    getAppState: () => appState, setAppState, setAppStateForTasks: setAppState,
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10), messages: [],
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    options: { commands, mainLoopModel: 'claude-sonnet-4-5', mainLoopProvider: 'firstParty',
      tools: [], thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: true, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], allAgents: [] } },
  } as unknown as import('../../Tool.js').ToolUseContext
  workers = []
  for (const command of commands) {
    if (command.type !== 'prompt') throw new Error('Expected prompt skill')
    expect(command.paths).toEqual(['src/feature'])
    const expectedRoot = plugins.find(plugin => command.name.startsWith(plugin.name + ':'))!
    expect(command.skillRoot).toBe(join(expectedRoot.path, expectedRoot.dir))
    await runWithCwdOverride(fixture, async () => {
      const slash = await processSlashCommand('/' + command.name, [], [], [], context as never, () => {})
      expect(slash.shouldQuery).toBe(false)
      expect(JSON.stringify(slash.messages)).toContain('Isolated worker completed')
      const parentMessage = createAssistantMessage({ content: [{ type: 'tool_use', id: 'skill-call', name: 'Skill', input: { skill: command.name } }] })
      const result = await SkillTool.call({ skill: command.name }, context, async () => ({ behavior: 'deny', message: 'Unexpected nested tool', decisionReason: { type: 'other', reason: 'Unexpected nested tool' } }), parentMessage)
      expect(result.data).toMatchObject({ success: true, status: 'forked', result: 'Isolated worker completed' })
    })
    expect(workers.slice(-2)).toEqual([
      { agentType: 'Explore', hooks: 1, root: command.skillRoot },
      { agentType: 'Explore', hooks: 1, root: command.skillRoot },
    ])
    expect(appState.sessionHooks.size).toBe(0)
  }

  const loaded = commands[0]!
  if (loaded.type !== 'prompt') throw new Error('Expected prompt skill')
  const managedDir = join(fixture, 'managed')
  await mkdir(managedDir)
  await writeFile(join(managedDir, 'managed-settings.json'), JSON.stringify({ strictPluginOnlyCustomization: ['hooks'] }))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  getManagedFilePath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  resetSettingsCache()
  try {
    for (const source of ['userSettings', 'plugin'] as const) {
      for (const executionContext of [undefined, 'fork'] as const) {
        const command = { ...loaded, source, context: executionContext }
        context.options.commands = [command]
        appState.sessionHooks.clear()
        const beforeWorkers = workers.length
        const result = await runWithCwdOverride(fixture, () => processSlashCommand(
          '/' + command.name, [], [], [], context as never, () => {},
        ))
        expect(result.shouldQuery).toBe(executionContext !== 'fork')
        const expectedCount = source === 'plugin' ? 1 : 0
        if (executionContext === 'fork') {
          expect(workers[beforeWorkers]?.hooks).toBe(expectedCount)
          expect(appState.sessionHooks.size).toBe(0)
        } else {
          const matches = await getMatchingHooks(appState, state.getSessionId(), 'PreToolUse', {
            hook_event_name: 'PreToolUse', session_id: state.getSessionId(), cwd: fixture,
            transcript_path: '', tool_name: 'Bash', tool_input: {}, tool_use_id: 'policy-control',
          })
          expect(matches).toHaveLength(expectedCount)
        }
      }
    }
  } finally {
    if (previousEnv.USER_TYPE === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = previousEnv.USER_TYPE
    delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
    getManagedFilePath.cache.clear?.()
    getManagedSettingsDropInDir.cache.clear?.()
    resetSettingsCache()
  }
})
