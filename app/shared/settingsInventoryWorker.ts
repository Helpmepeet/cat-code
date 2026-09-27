/** Private, one-shot boundary for reading Settings inventories without a chat session. */
import type {
  AgentConfigDefinition,
  AgentConfigSnapshot,
  ExtensionsSnapshot,
  HookEntry,
  McpConfigEntry,
  MemorySnapshot,
  PluginEntry,
  SettingsSnapshot,
  SkillEntry,
} from './protocol.js'
import {
  isBoolean,
  isNumber,
  isNumberOrNull,
  isRecord,
  isString,
  isStringOrNull,
  isUnknownArray,
  narrowExact,
  oneOf,
  optional,
} from './narrow.js'

export const SETTINGS_INVENTORY_WORKER_VERSION = 1
export const MAX_SETTINGS_INVENTORY_WORKER_RECORD_BYTES = 4 * 1024 * 1024

export type SettingsInventory = {
  cwd: string
  extensions: ExtensionsSnapshot
  agents: AgentConfigSnapshot
  settings: SettingsSnapshot | null
  memory: MemorySnapshot | null
}

export type SettingsInventoryWorkerResult =
  | ({ type: 'inventory'; version: 1 } & SettingsInventory)
  | { type: 'failure'; version: 1; reason: 'internal' }

const agentSource = oneOf([
  'built-in', 'plugin', 'userSettings', 'projectSettings', 'localSettings',
  'flagSettings', 'policySettings',
] as const)
const skillSource = oneOf([
  'builtin', 'bundled', 'mcp', 'plugin', 'userSettings', 'projectSettings',
  'localSettings', 'flagSettings', 'policySettings',
] as const)
const mcpScope = oneOf([
  'local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed',
] as const)
const mcpTransport = oneOf([
  'stdio', 'sse', 'sse-ide', 'ws', 'ws-ide', 'http', 'sdk', 'claudeai-proxy',
] as const)
const hookSource = oneOf([
  'pluginHook', 'sessionHook', 'builtinHook', 'userSettings', 'projectSettings',
  'localSettings', 'flagSettings', 'policySettings',
] as const)
const hookType = oneOf([
  'command', 'prompt', 'http', 'agent', 'callback', 'function',
] as const)
const settingSource = oneOf([
  'userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings',
] as const)

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function rows<T>(value: unknown, parse: (row: unknown) => T | null): T[] | null {
  if (!isUnknownArray(value)) return null
  const parsed: T[] = []
  for (const row of value) {
    const item = parse(row)
    if (item === null) return null
    parsed.push(item)
  }
  return parsed
}

function parseMcp(value: unknown): McpConfigEntry | null {
  return narrowExact(value, {
    name: isString, transport: mcpTransport, scope: mcpScope,
    url: optional(isString), command: optional(isString),
    argCount: optional(isNumber), pluginSource: optional(isString),
  })
}

function parseProvides(value: unknown): PluginEntry['provides'] | null {
  return narrowExact(value, {
    commands: isNumber, agents: isNumber, skills: isNumber,
    hooks: isNumber, mcpServers: isNumber, lsp: isNumber,
  })
}

function parsePlugin(value: unknown): PluginEntry | null {
  const row = narrowExact(value, {
    id: isString, name: isString, version: optional(isString), source: isString,
    enabled: isBoolean, builtin: isBoolean, provides: isRecord,
    error: optional(isString), pendingUpdate: optional(isRecord),
  })
  if (!row) return null
  const provides = parseProvides(row.provides)
  if (!provides) return null
  let pendingUpdate: PluginEntry['pendingUpdate']
  if (row.pendingUpdate !== undefined) {
    const parsed = narrowExact(row.pendingUpdate, {
      oldVersion: isString, newVersion: isString,
    })
    if (!parsed) return null
    pendingUpdate = parsed
  }
  const { pendingUpdate: _rawPendingUpdate, ...base } = row
  return { ...base, provides, ...(pendingUpdate ? { pendingUpdate } : {}) }
}

function parseSkill(value: unknown): SkillEntry | null {
  return narrowExact(value, {
    name: isString, source: skillSource, context: oneOf(['inline', 'fork'] as const),
    agent: optional(isString), pluginName: optional(isString),
    disableModelInvocation: isBoolean, userInvocable: isBoolean,
    description: isString, whenToUse: optional(isString),
  })
}

function parseHook(value: unknown): HookEntry | null {
  return narrowExact(value, {
    event: isString, type: hookType, matcher: optional(isString),
    source: hookSource, pluginName: optional(isString),
    async: isBoolean, displayLine: isString,
  })
}

function parseExtensions(value: unknown): ExtensionsSnapshot | null {
  const row = narrowExact(value, {
    mcp: (item: unknown): item is unknown[] | null => item === null || isUnknownArray(item),
    plugins: (item: unknown): item is unknown[] | null => item === null || isUnknownArray(item),
    skills: (item: unknown): item is unknown[] | null => item === null || isUnknownArray(item),
    hooks: (item: unknown): item is unknown[] | null => item === null || isUnknownArray(item),
  })
  if (!row) return null
  const mcp = row.mcp === null ? null : rows(row.mcp, parseMcp)
  const plugins = row.plugins === null ? null : rows(row.plugins, parsePlugin)
  const skills = row.skills === null ? null : rows(row.skills, parseSkill)
  const hooks = row.hooks === null ? null : rows(row.hooks, parseHook)
  if (row.mcp !== null && mcp === null) return null
  if (row.plugins !== null && plugins === null) return null
  if (row.skills !== null && skills === null) return null
  if (row.hooks !== null && hooks === null) return null
  return { mcp, plugins, skills, hooks }
}

function parseAgentTools(value: unknown): AgentConfigDefinition['tools'] | null {
  if (!isRecord(value)) return null
  if (value.mode === 'list') {
    return narrowExact(value, { mode: oneOf(['list'] as const), names: strings })
  }
  return narrowExact(value, { mode: oneOf(['all', 'none'] as const) })
}

function parseAgent(value: unknown): AgentConfigDefinition | null {
  const row = narrowExact(value, {
    id: isString, agentType: isString, source: agentSource,
    baseDir: optional(isString), filename: optional(isString), filePath: optional(isString),
    plugin: optional(isString), whenToUse: isString, tools: isRecord,
    disallowedTools: optional(strings), skills: optional(strings), model: optional(isString),
    provider: oneOf(['runtime'] as const),
    effort: optional((item: unknown): item is string | number => isString(item) || isNumber(item)),
    permissionMode: optional(isString), maxTurns: optional(isNumber),
    color: optional(isString), background: isBoolean, memory: optional(isString),
    isolation: optional(isString), hasInitialPrompt: isBoolean,
    hasHooks: isBoolean, hasMcpServers: isBoolean,
    mcpServerRefs: strings, inlineMcpServerNames: strings,
    requiredMcpServers: strings, missingMcpServers: strings,
    active: isBoolean, overriddenBy: optional(agentSource),
    available: isBoolean, editable: isBoolean, readOnlyReason: optional(isString),
    systemPrompt: isRecord,
  })
  if (!row) return null
  const tools = parseAgentTools(row.tools)
  const systemPrompt = narrowExact(row.systemPrompt, {
    available: isBoolean, withheldReason: oneOf(['secret-boundary'] as const),
  })
  if (!tools || !systemPrompt) return null
  return { ...row, tools, systemPrompt }
}

function parseAgents(value: unknown): AgentConfigSnapshot | null {
  const row = narrowExact(value, {
    definitions: isUnknownArray, failedFiles: isUnknownArray, availableMcpServers: strings,
  })
  if (!row) return null
  const definitions = rows(row.definitions, parseAgent)
  const failedFiles = rows(row.failedFiles, item => narrowExact(item, {
    path: isString, error: isString,
  }))
  if (!definitions || !failedFiles) return null
  return { definitions, failedFiles, availableMcpServers: row.availableMcpServers }
}

function parseSettings(value: unknown): SettingsSnapshot | null {
  const row = narrowExact(value, {
    layers: isUnknownArray, resolved: isUnknownArray, policyOrigin: oneOf([
      'remote', 'plist', 'hklm', 'file', 'hkcu', null,
    ] as const),
    editableValues: isUnknownArray, availableOptions: optional(isUnknownArray),
    permissionDefaultMode: optional(isRecord),
  })
  if (!row) return null
  const layers = rows(row.layers, item => narrowExact(item, {
    source: settingSource, origin: isString, keys: strings,
  }))
  const resolved = rows(row.resolved, item => narrowExact(item, {
    key: isString, source: settingSource, editable: isBoolean, managed: isBoolean,
  }))
  const editableValues = rows(row.editableValues, item => narrowExact(item, {
    key: isString,
    value: (candidate: unknown): candidate is boolean | string | number =>
      isBoolean(candidate) || isString(candidate) || isNumber(candidate),
    source: settingSource,
  }))
  const availableOptions = row.availableOptions === undefined
    ? undefined
    : rows(row.availableOptions, item => {
      const group = narrowExact(item, { key: isString, options: isUnknownArray })
      if (!group) return null
      const options = rows(group.options, option => narrowExact(option, {
        value: isString, label: isString, description: optional(isString),
      }))
      return options ? { key: group.key, options } : null
    })
  const permissionDefaultMode = row.permissionDefaultMode === undefined
    ? undefined
    : narrowExact(row.permissionDefaultMode, { value: isString, source: settingSource })
  if (!layers || !resolved || !editableValues) return null
  if (row.availableOptions !== undefined && !availableOptions) return null
  if (row.permissionDefaultMode !== undefined && !permissionDefaultMode) return null
  return {
    layers, resolved, policyOrigin: row.policyOrigin, editableValues,
    ...(availableOptions ? { availableOptions } : {}),
    ...(permissionDefaultMode ? { permissionDefaultMode } : {}),
  }
}

function parseMemory(value: unknown): MemorySnapshot | null {
  const row = narrowExact(value, {
    autoMemoryEnabled: isBoolean, autoMemoryDir: isString,
    autoMemoryEntrypoint: isString, instructionFiles: isUnknownArray,
    autoMemories: isUnknownArray, agentMemories: isUnknownArray, notes: strings,
  })
  if (!row) return null
  const instructionFiles = rows(row.instructionFiles, item => narrowExact(item, {
    path: isString,
    type: oneOf(['Managed', 'User', 'Project', 'Local', 'AutoMem', 'TeamMem'] as const),
    parent: optional(isString), globs: optional(strings), contentDiffersFromDisk: isBoolean,
  }))
  const autoMemories = rows(row.autoMemories, item => narrowExact(item, {
    filename: isString, filePath: isString, mtimeMs: isNumber,
    description: isStringOrNull,
    type: optional(oneOf(['user', 'feedback', 'project', 'reference'] as const)),
  }))
  const agentMemories = rows(row.agentMemories, item => narrowExact(item, {
    agentType: isString, scope: oneOf(['user', 'project', 'local'] as const),
    directory: isString, fileCount: isNumberOrNull,
  }))
  if (!instructionFiles || !autoMemories || !agentMemories) return null
  return {
    autoMemoryEnabled: row.autoMemoryEnabled,
    autoMemoryDir: row.autoMemoryDir,
    autoMemoryEntrypoint: row.autoMemoryEntrypoint,
    instructionFiles, autoMemories, agentMemories, notes: row.notes,
  }
}

/** Rejects extra keys, malformed nested rows, wrong versions and unknown result kinds. */
export function parseSettingsInventoryWorkerResult(
  value: unknown,
): SettingsInventoryWorkerResult | null {
  if (!isRecord(value) || value.version !== SETTINGS_INVENTORY_WORKER_VERSION) return null
  if (value.type === 'failure') {
    return narrowExact(value, {
      type: oneOf(['failure'] as const), version: oneOf([1] as const),
      reason: oneOf(['internal'] as const),
    })
  }
  const row = narrowExact(value, {
    type: oneOf(['inventory'] as const), version: oneOf([1] as const),
    cwd: isString, extensions: isRecord, agents: isRecord,
    settings: (item: unknown): item is Record<string, unknown> | null => item === null || isRecord(item),
    memory: (item: unknown): item is Record<string, unknown> | null => item === null || isRecord(item),
  })
  if (!row) return null
  const extensions = parseExtensions(row.extensions)
  const agents = parseAgents(row.agents)
  const settings = row.settings === null ? null : parseSettings(row.settings)
  const memory = row.memory === null ? null : parseMemory(row.memory)
  if (!extensions || !agents) return null
  if (row.settings !== null && !settings) return null
  if (row.memory !== null && !memory) return null
  return { type: 'inventory', version: 1, cwd: row.cwd, extensions, agents, settings, memory }
}
