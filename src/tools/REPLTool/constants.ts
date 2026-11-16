import { feature } from 'bun:bundle'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export const REPL_TOOL_NAME = 'REPL'

/**
 * Explicit build capability shared by both providers. Direct coding tools remain
 * available; this switch never changes the executable pool granted to a worker.
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  return feature('CODE_MODE') ? true : false
}
