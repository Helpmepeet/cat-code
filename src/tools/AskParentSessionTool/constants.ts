// Single source of truth for the tool name lives in ./prompt.ts (the value the
// tool actually registers under). Re-exported here so importers of ./constants
// resolve the same string.
export { ASK_PARENT_SESSION_TOOL_NAME } from './prompt.js'
