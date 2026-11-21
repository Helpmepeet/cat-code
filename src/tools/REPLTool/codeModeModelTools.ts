import type { Tools } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { REPL_TOOL_NAME } from './constants.js'

const scriptFirstTools = new Set([
  'Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'apply_patch', 'NotebookEdit', AGENT_TOOL_NAME,
])

/** Project declarations, not permissions or the pool used inside Script. */
export function codeModeModelTools(tools: Tools, enabled: boolean): Tools {
  if (!enabled || !tools.some(tool => tool.name === REPL_TOOL_NAME && !tool.isMcp && !tool.mcpInfo)) {
    return tools
  }
  return tools.filter(tool => tool.isMcp || tool.mcpInfo || !scriptFirstTools.has(tool.name))
}

export function usesScriptForCodingTools(tools: Tools): boolean {
  const builtIns = tools.filter(tool => !tool.isMcp && !tool.mcpInfo)
  return builtIns.some(tool => tool.name === REPL_TOOL_NAME) &&
    !builtIns.some(tool => tool.name !== AGENT_TOOL_NAME && !tool.shouldDefer && scriptFirstTools.has(tool.name))
}
