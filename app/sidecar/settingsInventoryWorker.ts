/** One read of user/project Settings inventories, independent of a chat session. */
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_SETTINGS_INVENTORY_WORKER_RECORD_BYTES,
  SETTINGS_INVENTORY_WORKER_VERSION,
  type SettingsInventoryWorkerResult,
} from '../shared/settingsInventoryWorker.js'
import {
  bootstrapWorkerEngine,
  emitWorkerRecord,
  runDisposableWorker,
} from './workerRuntime.js'

// This worker deliberately keeps the full engine config mode. SIMPLE omits
// custom agents and skills, which are the main reason to run this read.
process.env.CLAUDE_CODE_SIMPLE = ''

async function main(): Promise<void> {
  const [
    { getSkillDirCommands },
    { getBundledSkills },
    { getBuiltinPluginSkillCommands },
    { initBuiltinPlugins },
    { initBundledSkills },
    { getPluginCommands, getPluginSkills },
    { getAgentDefinitionsWithOverrides },
    { getClaudeCodeMcpConfigs },
    { getDefaultAppState },
    { loadExtensionsSnapshot },
    { buildAgentConfigSnapshot },
    { createSidecarSettingsDomain, loadAvailableSettingOptions },
    { readMemorySnapshotOnce },
  ] = await Promise.all([
    import('../../src/skills/loadSkillsDir.js'),
    import('../../src/skills/bundledSkills.js'),
    import('../../src/plugins/builtinPlugins.js'),
    import('../../src/plugins/bundled/index.js'),
    import('../../src/skills/bundled/index.js'),
    import('../../src/utils/plugins/loadPluginCommands.js'),
    import('../../src/tools/AgentTool/loadAgentsDir.js'),
    import('../../src/services/mcp/config.js'),
    import('../../src/state/AppStateStore.js'),
    import('./extensionsDomain.js'),
    import('./agentConfigDomain.js'),
    import('./settingsDomain.js'),
    import('./memoryDomain.js'),
  ])
  await bootstrapWorkerEngine()
  initBuiltinPlugins()
  initBundledSkills()

  const cwd = process.cwd()
  const [skillDirCommands, pluginCommands, pluginSkills, agentDefinitions, mcpConfig] = await Promise.all([
    getSkillDirCommands(cwd),
    getPluginCommands(),
    getPluginSkills(),
    getAgentDefinitionsWithOverrides(cwd),
    // Exactly the session lifecycle's explicit-only configured set. This read
    // does not start MCP clients or assert that any server is connected.
    getClaudeCodeMcpConfigs({}, Promise.resolve({}), {
      projectMcpApproval: 'explicit-only',
    }),
  ])
  // Inventory reads installed configuration, including skills that are not
  // currently invocable because no account is signed in. The runtime's
  // getCommands() filters by auth and throws before login; these are the same
  // underlying source loaders without that session-only availability filter.
  const commands = [
    ...getBundledSkills(),
    ...getBuiltinPluginSkillCommands(),
    ...skillDirCommands,
    ...pluginCommands,
    ...pluginSkills,
  ]
  const extensions = await loadExtensionsSnapshot({
    commands,
    agentDefinitions: agentDefinitions.allAgents,
    appState: getDefaultAppState(),
    preparedMcpConfiguration: mcpConfig.servers,
  })
  const agents = buildAgentConfigSnapshot({
    result: agentDefinitions,
    availableMcpServers: [],
  })
  // Each read can fail independently. A malformed settings file or unreadable
  // memory directory must not erase an otherwise usable skills inventory.
  let settings = null
  try {
    settings = createSidecarSettingsDomain(
      await loadAvailableSettingOptions(cwd),
      { userScope: process.argv.includes('--user-settings-scope') },
    ).getSnapshot()
  } catch (error) {
    process.stderr.write(`[settings-inventory-worker] settings read failed: ${String(error)}\n`)
  }
  const memory = await readMemorySnapshotOnce(agentDefinitions.activeAgents)
  const result: SettingsInventoryWorkerResult = {
    type: 'inventory',
    version: SETTINGS_INVENTORY_WORKER_VERSION,
    cwd,
    extensions,
    agents,
    settings,
    memory,
  }
  if (!scanForSecrets(result).ok) {
    await emit({ type: 'failure', version: SETTINGS_INVENTORY_WORKER_VERSION, reason: 'internal' })
    process.exit(0)
  }
  await emit(result)
  process.exit(0)
}

function emit(result: SettingsInventoryWorkerResult): Promise<void> {
  return emitWorkerRecord(
    result,
    MAX_SETTINGS_INVENTORY_WORKER_RECORD_BYTES,
    'settings inventory result',
  )
}

runDisposableWorker('settings-inventory-worker', main)
