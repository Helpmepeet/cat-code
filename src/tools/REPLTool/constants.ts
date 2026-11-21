import { feature } from 'bun:bundle'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export const REPL_TOOL_NAME = 'REPL'

export const CODE_MODE_DEFAULT_FOR_NEW_SESSIONS = true

const MAX_SCRIPT_TOOL_CONCURRENCY = 10

export function getScriptToolConcurrency(): number {
  const configured = Number(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY)
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_SCRIPT_TOOL_CONCURRENCY)
    : MAX_SCRIPT_TOOL_CONCURRENCY
}

/**
 * Explicit build capability shared by both providers. Direct coding tools remain
 * available; this switch never changes the executable pool granted to a worker.
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  return feature('CODE_MODE') ? true : false
}
