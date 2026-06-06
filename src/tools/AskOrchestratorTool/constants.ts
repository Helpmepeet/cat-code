// Single source of truth for the tool name lives in ./prompt.ts (the value the
// tool actually registers under). Re-exported here so existing importers of
// ./constants resolve the same string. Previously this file declared a
// divergent 'AskOrchestrator' value, which did not match the registered tool
// name 'ask_orchestrator' and caused role `tools` lookups to miss.
export { ASK_ORCHESTRATOR_TOOL_NAME } from './prompt.js'
