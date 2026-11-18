import type { Tools } from '../../Tool.js'
import { REPL_TOOL_NAME } from './constants.js'

const scriptFirstTools = new Set([
  'Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'apply_patch', 'NotebookEdit',
])

/** Project declarations, not permissions or the pool used inside Script. */
export function codeModeModelTools(tools: Tools, enabled: boolean): Tools {
  if (!enabled || !tools.some(tool => tool.name === REPL_TOOL_NAME && !tool.isMcp && !tool.mcpInfo)) {
    return tools
  }
  return tools.filter(tool => tool.isMcp || tool.mcpInfo || !scriptFirstTools.has(tool.name))
}
