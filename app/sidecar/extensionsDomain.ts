/**
 * Settings extensions domain capability — the sidecar-side read-seam over the
 * engine's real MCP / Plugins / Skills / Hooks config (P4-12; the read-only W4
 * domain-recipe shape, like `settingsDomain.ts` / `agentConfigDomain.ts`).
 *
 * Like settings, all four slices are spawn-time reads that freeze at
 * construction (no live subscription): MCP + plugins are async disk reads,
 * skills mirror the ALREADY-LOADED command catalog the session runs (the
 * anti-stub-context rule §8.1 — same source as `createNormalSidecarQueryEngineConfig`,
 * NOT a re-load), and hooks read the settings-resolved hook config off the same
 * app-state the runtime uses. Each slice degrades to `null` independently on a
 * read failure (with a UI-visible note) so one bad domain never blanks the rest.
 *
 * Secret posture (proven in `extensionsDomain.test.ts`): the snapshot carries
 * config METADATA only — no MCP `env`/`headers` or URL credentials, no hook
 * command/prompt bodies, no skill prompt bodies, no plugin option
 * VALUES. `secretGuard` on the outbound frame is satisfied by construction.
 *
 * Deferred (see the `protocol.ts` P4-12 header for the full §0 flag list): MCP
 * LIVE runtime state (connections/counts/actions — the empty-mcpClients stub in
 * `sessionController.ts`, an app-runtime extract not a sidecar hand-wire), all
 * WRITES, marketplace browsing, and the (unpersisted) hook last-run outcome.
 */

import { getClaudeCodeMcpConfigs } from '../../src/services/mcp/config.js'
import type { ScopedMcpServerConfig } from '../../src/services/mcp/types.js'
import { loadAllPlugins } from '../../src/utils/plugins/pluginLoader.js'
import { getPendingUpdatesDetails } from '../../src/utils/plugins/installedPluginsManager.js'
import { getPluginErrorMessage } from '../../src/types/plugin.js'
import type { LoadedPlugin, PluginError } from '../../src/types/plugin.js'
import type { Command } from '../../src/commands.js'
import type { AgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { getAllHooks } from '../../src/utils/hooks/hooksSettings.js'
import { HOOK_EVENTS } from '../../src/entrypoints/sdk/coreTypes.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type {
  ExtensionsSnapshot,
  HookConfigType,
  HookEntry,
  McpConfigEntry,
  McpConfigScope,
  McpConfigTransport,
  PluginEntry,
  PluginProvides,
  SkillConfigSource,
  SkillEntry,
} from '../shared/protocol.js'

/** A staged auto-update awaiting restart (`getPendingUpdatesDetails`). */
type PendingUpdate = {
  pluginId: string
  scope: string
  oldVersion: string
  newVersion: string
}

export type SidecarExtensionsDomain = {
  /** The spawn-time extensions snapshot (null only if EVERY slice failed). */
  getSnapshot(): ExtensionsSnapshot | null
}

export function createSidecarExtensionsDomain(
  snapshot: ExtensionsSnapshot | null,
): SidecarExtensionsDomain {
  return {
    getSnapshot() {
      return snapshot
    },
  }
}

/**
 * Async spawn-time read: MCP config + installed plugins from disk, skills from
 * the passed-in loaded catalog, hooks from the passed-in app-state. Never throws
 * — each slice is guarded so a failure logs and degrades to `null`.
 */
export async function loadExtensionsSnapshot({
  commands,
  agentDefinitions,
  appState,
}: {
  /** The session's ALREADY-LOADED command catalog (skills are a subset). */
  commands: readonly Command[]
  /** The session's ALREADY-LOADED agent definitions (for plugin provides counts). */
  agentDefinitions: readonly AgentDefinition[]
  /** The runtime's app-state (hooks resolve off the same settings the engine reads). */
  appState: AppState
}): Promise<ExtensionsSnapshot> {
  const mcp = await readMcpSlice()
  const skills = readSkillsSlice(commands)
  const plugins = await readPluginsSlice(commands, agentDefinitions)
  const hooks = readHooksSlice(appState)

  return { mcp, plugins, skills, hooks }
}

/* ----------------------------- MCP ----------------------------- */

async function readMcpSlice(): Promise<McpConfigEntry[] | null> {
  try {
    const { servers } = await getClaudeCodeMcpConfigs()
    return Object.entries(servers)
      .map(([name, config]) => buildMcpEntry(name, config))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    logSkip('mcp', error)
    return null
  }
}

export function buildMcpEntry(
  name: string,
  config: ScopedMcpServerConfig,
): McpConfigEntry {
  // `type` is optional on stdio configs (back-compat default), a literal on the
  // rest — narrow to the wire union, defaulting to stdio.
  const transport = (config.type ?? 'stdio') as McpConfigTransport
  const scope = config.scope as McpConfigScope
  const entry: McpConfigEntry = { name, transport, scope }
  if ('url' in config && typeof config.url === 'string') {
    entry.url = redactRemoteUrl(config.url)
  }
  if ('command' in config && typeof config.command === 'string') {
    entry.command = config.command
    entry.argCount = Array.isArray(config.args) ? config.args.length : 0
  }
  if (config.pluginSource) {
    entry.pluginSource = config.pluginSource
  }
  return entry
}

/**
 * A remote server's host and path are useful display metadata. Query strings,
 * fragments, and user-info commonly carry credentials, so they never leave the
 * sidecar even when their key names would evade the outbound secret guard.
 */
function redactRemoteUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    // Never fall back to the raw string: a malformed URL may still embed a
    // token, and the renderer only needs to know that this server is remote.
    return 'remote endpoint'
  }
}

/* ---------------------------- Skills --------------------------- */

/** `loadedFrom` values that identify a skill in the loaded command catalog. */
const SKILL_LOADED_FROM = new Set([
  'skills',
  'commands_DEPRECATED',
  'plugin',
  'mcp',
])

function readSkillsSlice(commands: readonly Command[]): SkillEntry[] | null {
  try {
    return buildSkillEntries(commands)
  } catch (error) {
    logSkip('skills', error)
    return null
  }
}

export function buildSkillEntries(commands: readonly Command[]): SkillEntry[] {
  const skills: SkillEntry[] = []
  for (const command of commands) {
    // A skill is a prompt-command loaded from a skills / plugin / mcp source
    // (`SkillsMenu.tsx` filter). Non-prompt or built-in commands are not skills.
    if (command.type !== 'prompt') continue
    if (!command.loadedFrom || !SKILL_LOADED_FROM.has(command.loadedFrom)) {
      continue
    }
    const pluginName = command.pluginInfo?.pluginManifest.name
    const entry: SkillEntry = {
      name: command.name,
      source: command.source as SkillConfigSource,
      context: command.context === 'fork' ? 'fork' : 'inline',
      disableModelInvocation: command.disableModelInvocation === true,
      userInvocable: command.userInvocable !== false,
      description: command.description,
    }
    if (command.context === 'fork' && command.agent) {
      entry.agent = command.agent
    }
    if (pluginName) {
      entry.pluginName = pluginName
    }
    if (command.whenToUse) {
      entry.whenToUse = command.whenToUse
    }
    skills.push(entry)
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/* ---------------------------- Plugins -------------------------- */

async function readPluginsSlice(
  commands: readonly Command[],
  agentDefinitions: readonly AgentDefinition[],
): Promise<PluginEntry[] | null> {
  try {
    const { enabled, disabled, errors } = await loadAllPlugins()
    let pending: PendingUpdate[] = []
    try {
      pending = getPendingUpdatesDetails()
    } catch {
      pending = []
    }
    return buildPluginEntries({
      loaded: [
        ...enabled.map(plugin => ({ plugin, enabled: true })),
        ...disabled.map(plugin => ({ plugin, enabled: false })),
      ],
      errors,
      pending,
      commands,
      agentDefinitions,
    })
  } catch (error) {
    logSkip('plugins', error)
    return null
  }
}

export function buildPluginEntries({
  loaded,
  errors,
  pending,
  commands,
  agentDefinitions,
}: {
  loaded: ReadonlyArray<{ plugin: LoadedPlugin; enabled: boolean }>
  errors: readonly PluginError[]
  pending: readonly PendingUpdate[]
  commands: readonly Command[]
  agentDefinitions: readonly AgentDefinition[]
}): PluginEntry[] {
  const entries = loaded.map(({ plugin, enabled }) => {
    const displayName = plugin.manifest.name || plugin.name
    const provides = derivePluginProvides(plugin, commands, agentDefinitions, displayName)
    const error = correlatePluginError(plugin, errors)
    const update = pending.find(
      detail => detail.pluginId === plugin.source || detail.pluginId === plugin.name,
    )
    const entry: PluginEntry = {
      id: plugin.source || plugin.name,
      name: displayName,
      source: plugin.source,
      enabled,
      builtin: plugin.isBuiltin === true,
      provides,
    }
    if (typeof plugin.manifest.version === 'string') {
      entry.version = plugin.manifest.version
    }
    if (error) {
      entry.error = error
    }
    if (update) {
      entry.pendingUpdate = {
        oldVersion: update.oldVersion,
        newVersion: update.newVersion,
      }
    }
    return entry
  })
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function derivePluginProvides(
  plugin: LoadedPlugin,
  commands: readonly Command[],
  agentDefinitions: readonly AgentDefinition[],
  displayName: string,
): PluginProvides {
  // commands/skills/agents are counted from the loaded catalogs by plugin
  // identity (real, not a directory-path guess); hooks/mcp/lsp come straight off
  // the plugin record. A plugin's loaded commands split into skills (loadedFrom
  // skill-ish) and other commands.
  const owned = commands.filter(
    command =>
      command.type === 'prompt' &&
      command.pluginInfo?.pluginManifest.name === displayName,
  )
  const skills = owned.filter(
    command =>
      command.loadedFrom !== undefined && SKILL_LOADED_FROM.has(command.loadedFrom),
  ).length
  const commandCount = owned.length - skills
  const agents = agentDefinitions.filter(
    agent => agent.source === 'plugin' && matchesPlugin(agent, plugin),
  ).length
  return {
    commands: commandCount,
    agents,
    skills,
    hooks: countHookConfigs(plugin),
    mcpServers: plugin.mcpServers ? Object.keys(plugin.mcpServers).length : 0,
    lsp: plugin.lspServers ? Object.keys(plugin.lspServers).length : 0,
  }
}

function matchesPlugin(agent: AgentDefinition, plugin: LoadedPlugin): boolean {
  const pluginId =
    'plugin' in agent && typeof agent.plugin === 'string' ? agent.plugin : null
  return pluginId === plugin.source || pluginId === plugin.name
}

function countHookConfigs(plugin: LoadedPlugin): number {
  if (!plugin.hooksConfig) return 0
  let total = 0
  for (const matchers of Object.values(plugin.hooksConfig)) {
    if (!Array.isArray(matchers)) continue
    for (const matcher of matchers) {
      total += Array.isArray(matcher.hooks) ? matcher.hooks.length : 0
    }
  }
  return total
}

function correlatePluginError(
  plugin: LoadedPlugin,
  errors: readonly PluginError[],
): string | undefined {
  const match = errors.find(error => {
    const source = 'source' in error ? error.source : undefined
    const name = 'plugin' in error ? error.plugin : undefined
    return source === plugin.source || name === plugin.name
  })
  return match ? getPluginErrorMessage(match) : undefined
}

/* ----------------------------- Hooks --------------------------- */

function readHooksSlice(appState: AppState): HookEntry[] | null {
  try {
    return buildHookEntries(getAllHooks(appState))
  } catch (error) {
    logSkip('hooks', error)
    return null
  }
}

/** Canonical event index for ordering (`HOOK_EVENTS`, `coreTypes.ts:25`). */
const HOOK_EVENT_ORDER = new Map<string, number>(
  HOOK_EVENTS.map((event, index) => [event, index]),
)

type IndividualHookLike = ReturnType<typeof getAllHooks>[number]

export function buildHookEntries(
  hooks: readonly IndividualHookLike[],
): HookEntry[] {
  const entries = hooks.map(hook => {
    const config = hook.config
    const entry: HookEntry = {
      event: hook.event,
      type: config.type as HookConfigType,
      source: hook.source,
      async: config.type === 'command' ? config.async === true : false,
      // Hook bodies are arbitrary command lines, prompts, or webhook URLs.
      // They can contain credentials under values that a key-name-only guard
      // cannot identify, so project only the hook kind to the renderer.
      displayLine: `${config.type} hook`,
    }
    if (hook.matcher) {
      entry.matcher = hook.matcher
    }
    if (hook.pluginName) {
      entry.pluginName = hook.pluginName
    }
    return entry
  })
  // Group ordering: canonical event order, then stable within an event.
  return entries.sort((a, b) => {
    const byEvent =
      (HOOK_EVENT_ORDER.get(a.event) ?? Number.MAX_SAFE_INTEGER) -
      (HOOK_EVENT_ORDER.get(b.event) ?? Number.MAX_SAFE_INTEGER)
    if (byEvent !== 0) return byEvent
    return a.displayLine.localeCompare(b.displayLine)
  })
}

/* ----------------------------- util ---------------------------- */

function logSkip(slice: string, error: unknown): void {
  process.stderr.write(
    `[sidecar] extensions.${slice} read failed (that panel shows unavailable): ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
}
