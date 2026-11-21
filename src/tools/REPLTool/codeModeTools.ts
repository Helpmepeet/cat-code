import { findToolByName, type Tool, type ToolUseContext, type Tools } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { createHash } from 'node:crypto'
import { encode } from './runtime/protocol.js'
import { isCuaDriverToolCall } from '../../utils/cuaDriver/guard.js'
import { getBashPrompt } from '../BashTool/prompt.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const MAX_CODE_MODE_TOOL_NAME_CHARS = 512

type DescriptionEntry = {
  policy: ReturnType<ToolUseContext['getAppState']>['toolPermissionContext']
  tools: Tools
  agents: ToolUseContext['options']['agentDefinitions']['activeAgents']
  allowed: ToolUseContext['options']['agentDefinitions']['allowedAgentTypes']
  provider: ToolUseContext['options']['mainLoopProvider']
  value: Promise<string>
}
const descriptions = new WeakMap<Tool, WeakMap<object, DescriptionEntry>>()

function currentToolDescription(tool: Tool, context: ToolUseContext): Promise<string> {
  const options = context.options
  const policy = context.getAppState().toolPermissionContext
  const agents = options.agentDefinitions.activeAgents
  const allowed = options.agentDefinitions.allowedAgentTypes
  let entries = descriptions.get(tool)
  if (!entries) { entries = new WeakMap(); descriptions.set(tool, entries) }
  const cached = entries.get(options)
  if (cached && cached.policy === policy && cached.tools === options.tools &&
      cached.agents === agents && cached.allowed === allowed && cached.provider === options.mainLoopProvider) return cached.value
  const value = Promise.resolve().then(() =>
    tool.name === BASH_TOOL_NAME && !tool.isMcp && !tool.mcpInfo
      ? getBashPrompt(options.mainLoopProvider, 'script')
      : tool.prompt({
        getToolPermissionContext: async () => policy, tools: options.tools, agents,
        allowedAgentTypes: allowed, provider: options.mainLoopProvider,
      }),
  ).catch(error => { entries!.delete(options); throw error })
  entries.set(options, { policy, tools: options.tools, agents, allowed, provider: options.mainLoopProvider, value })
  return value
}

/** Compatibility, not authority: callers must still enter runToolUse. */
const directOnly = new Map<string, string>([
  ['REPL', 'Recursive interpreter execution is not supported'],
  ['ToolSearch', 'Use tools.discover({op:"search",query:"..."}) and tools.discover({op:"describe",name:"..."}) inside Code Mode'],
  ['AskUserQuestion', 'Human answers require a new model decision'],
  ['AskParentSession', 'Human or parent answers require a new model decision'],
  ['ask_parent_session', 'Human or parent answers require a new model decision'],
  ['EnterPlanMode', 'Changes the permission scope of the running script'],
  ['ExitPlanMode', 'Changes the permission scope of the running script'],
  ['EnterWorktree', 'Changes workspace and runtime ownership'],
  ['ExitWorktree', 'Changes workspace and runtime ownership'],
  ['Config', 'Changes engine authority or session configuration'],
  ['CreateGoal', 'Changes the running thread goal and budgets'],
  ['UpdateGoal', 'Changes the running thread goal and budgets'],
  ['TeamCreate', 'Changes worker ownership'],
  ['TeamDelete', 'Changes worker ownership'],
  ['JumpToProject', 'Changes workspace and runtime ownership'],
  ['BrowserNavigate', 'Browser control requires direct interaction'],
  ['BrowserRead', 'Browser control requires direct interaction'],
  ['BrowserScreenshot', 'Browser media requires direct delivery'],
  ['BrowserAct', 'Browser control requires direct interaction'],
  ['WebBrowser', 'Browser control requires direct interaction'],
  ['GenerateImage', 'Generated media requires direct delivery'],
])

export function codeModeExclusion(tool: Tool, context?: ToolUseContext): string | undefined {
  if (tool.name.length > MAX_CODE_MODE_TOOL_NAME_CHARS) return 'Tool identity exceeds the isolated bridge name limit'
  const server = tool.mcpInfo?.serverName.toLowerCase()
  if (server && ['codex-computer-use', 'claude-in-chrome', 'computer', 'cua'].includes(server)) {
    return 'Configured computer/browser integration requires direct interaction and media delivery'
  }
  if (isCuaDriverToolCall(tool.name, undefined, { tool, clients: context?.options.mcpClients ?? [] })) {
    return 'Configured computer/browser integration requires direct interaction and media delivery'
  }
  const reason = !tool.isMcp && !tool.mcpInfo ? directOnly.get(tool.name) : undefined
  if (reason) return reason
  // These concrete integrations own focus, takeover, or workspace transitions.
  if (/^(?:mcp__claude_in_chrome__|mcp__computer__|mcp__cua__)/.test(tool.name)) {
    return 'Computer and browser control require direct interaction'
  }
  if (!tool.isMcp && !tool.mcpInfo && /^(?:workspace_jump|WorkspaceJump|JumpWorkspace)$/.test(tool.name)) {
    return 'Workspace transitions require a new runtime incarnation'
  }
  return undefined
}

/** Resolve every dispatch against the current executable pool, including aliases. */
export function resolveCodeModeTool(context: ToolUseContext, name: string): Tool {
  const tool = findToolByName(context.options.tools, name)
  if (!tool) throw new Error(`Tool is not available in this execution: ${name}`)
  const reason = codeModeExclusion(tool, context)
  if (reason) throw new Error(`${tool.name} is direct-only: ${reason}`)
  return tool
}

export function codeModeToolPrincipal(tool: Tool, context?: ToolUseContext): string {
  if (!tool.mcpInfo) return JSON.stringify([tool.isMcp ? 'mcp' : 'native', tool.name])
  const config = context?.options.mcpClients?.find(client => client.name === tool.mcpInfo!.serverName)?.config
  // Configuration may contain credentials. Only an engine-private digest participates
  // in binding comparison; neither configuration nor digest enters guest/model data.
  const canonical = config && JSON.stringify(config, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value)
  return JSON.stringify(['mcp', tool.mcpInfo.serverName, tool.mcpInfo.toolName,
    canonical ? createHash('sha256').update(canonical).digest('hex') : null])
}

/** Pin names to principals, not schemas or wrapper instances. Ordinary compatible
 * rediscovery still resolves and validates against the current executable pool. */
export function captureCodeModeToolPrincipals(tools: Tools, context?: ToolUseContext): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>()
  for (const tool of tools) for (const name of [tool.name, ...(tool.aliases ?? [])]) {
    if (!bindings.has(name)) bindings.set(name, codeModeToolPrincipal(tool, context))
  }
  return bindings
}

const MAX_SCHEMA_BYTES = 128 * 1024
const MAX_DESCRIPTION_CHARS = 16_384

export async function describeCodeModeTool(context: ToolUseContext, name: string) {
  if (!name || name.length > MAX_CODE_MODE_TOOL_NAME_CHARS) return { name: name.slice(0, MAX_CODE_MODE_TOOL_NAME_CHARS), schemaComplete: false, error: 'Tool name exceeds the bridge limit' }
  const tool = findToolByName(context.options.tools, name)
  if (!tool) return { name, schemaComplete: false, error: 'Tool is not available in the current executable pool' }
  const reason = codeModeExclusion(tool, context)
  if (reason) return { name, schemaComplete: false, error: reason, directOnly: true }
  let serialized: string
  try { serialized = JSON.stringify(tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)) }
  catch { return { name: tool.name, schemaComplete: false, error: 'Input schema is unsupported by the isolated bridge; use this tool directly', directOnly: true } }
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) {
    return { name: tool.name, schemaComplete: false, error: `Full schema exceeds ${MAX_SCHEMA_BYTES} bytes; use this tool directly` }
  }
  const supportedSchema = JSON.parse(serialized)
  try { encode(supportedSchema, MAX_SCHEMA_BYTES) }
  catch {
    return { name: tool.name, schemaComplete: false, error: 'Schema cannot be represented by the isolated JSON bridge; use this tool directly', directOnly: true }
  }
  let description = ''
  let descriptionError: string | undefined
  try {
    description = await currentToolDescription(tool, context)
  } catch (error) { descriptionError = error instanceof Error ? error.message.slice(0, 512) : 'Description is unavailable' }
  return {
    name: tool.name,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    descriptionComplete: !descriptionError && description.length <= MAX_DESCRIPTION_CHARS,
    ...(descriptionError ? { descriptionError } : {}),
    inputSchema: supportedSchema,
    schemaComplete: true as const,
  }
}

export async function searchCodeModeTools(context: ToolUseContext, query: string, max = 5) {
  if (typeof query !== 'string' || query.length > 4096) throw new Error('Search query must be at most 4096 characters')
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('Search limit must be an integer from 1 to 20')
  const normalizedQuery = query.trim().toLowerCase()
  const words = [...new Set(normalizedQuery.split(/\s+/).filter(Boolean))]
  if (words.length > 32) throw new Error('Use at most 32 tool-search terms')
  const eligible = context.options.tools.filter(tool => !codeModeExclusion(tool, context))
  let indexComplete = true
  const ranked = (await Promise.all(eligible.map(async tool => {
    let keys: string[] = []
    let previewError: string | undefined
    let description = tool.searchHint ?? tool.name
    let descriptionError: string | undefined
    try { description = await currentToolDescription(tool, context) }
    catch (error) { indexComplete = false; descriptionError = error instanceof Error ? error.message.slice(0, 512) : 'Description is unavailable' }
    try { keys = Object.keys((tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)).properties ?? {}) }
    catch (error) { indexComplete = false; previewError = error instanceof Error ? error.message.slice(0, 512) : 'Input preview is unavailable' }
    const source = `${tool.name} ${description.slice(0, 4096)} ${(tool.aliases ?? []).slice(0, 16).map(alias => alias.slice(0, 512)).join(' ')} ${(tool.searchHint ?? '').slice(0, 512)} ${keys.slice(0, 64).map(key => key.slice(0, 256)).join(' ')}`
    if (source.length > 4096 || keys.length > 64 || (tool.aliases?.length ?? 0) > 16 || (tool.searchHint?.length ?? 0) > 512) indexComplete = false
    const text = source.slice(0, 4096).toLowerCase()
    const exactMatch = normalizedQuery !== '' && (
      tool.name.toLowerCase() === normalizedQuery ||
      tool.aliases?.some(alias => alias.toLowerCase() === normalizedQuery) === true
    )
    const score = words.reduce((score, word) => score + Number(text.includes(word)), 0)
    return { tool, keys, previewError, description, descriptionError, exactMatch, score }
  }))).filter(item => words.length === 0 || item.exactMatch || item.score > 0)
    .sort((a, b) => Number(b.exactMatch) - Number(a.exactMatch) || b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  const matches = ranked.slice(0, max).map(({ tool, keys, previewError, description, descriptionError }) => {
      const descriptionComplete = !descriptionError && description.length <= 512
      return {
        name: tool.name,
        about: description.slice(0, 512), descriptionComplete,
        ...(descriptionError ? { descriptionError } : {}),
        ...(previewError ? { previewError } : {}),
        // A preview is deliberately not a schema. describeTool supplies the full schema.
        inputKeys: keys.slice(0, 32).map(key => key.slice(0, 256)),
        inputKeysComplete: keys.length <= 32 && keys.every(key => key.length <= 256),
        totalInputKeys: keys.length,
        schemaComplete: false as const,
      }
    })
  const result = {
    matches,
    returned: matches.length,
    matchingTools: ranked.length,
    eligibleTools: eligible.length,
    complete: indexComplete && ranked.length <= max,
    indexComplete,
    searchFields: 'name, description, aliases, searchHint, inputKeys',
    directOnly: context.options.tools.flatMap(tool => {
      const reason = codeModeExclusion(tool, context)
      const name = tool.name.slice(0, MAX_CODE_MODE_TOOL_NAME_CHARS)
      return reason && (words.length === 0 || words.some(word => name.toLowerCase().includes(word)))
        ? [{ name, nameComplete: name.length === tool.name.length, reason }] : []
    }).slice(0, max),
    discoveryScope: 'current-executable-pool' as const,
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024 && result.matches.length) {
    result.matches.pop()
    result.complete = false
  }
  result.returned = result.matches.length
  return result
}
