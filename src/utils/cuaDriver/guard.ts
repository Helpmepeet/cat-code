import { existsSync } from 'fs'
import { join } from 'path'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { CuaDriverRun } from './run.js'

const MCP_TOOL_PREFIX = 'mcp__cua-driver__'

// Detection reads the command text: the tree-sitter parser behind
// parseForSecurity is compiled out of the desktop sidecar (it is not in the
// sidecar's --feature list), and the desktop is where agents drive the GUI.
//
// `cua-driver` counts when it is the command being run: at the start, after a
// separator, pipe or `$(`, optionally behind env assignments, wrappers
// (`timeout 30`, `nohup`) or shell keywords (`then`, `do`, `if`), and
// optionally quoted or given as a path. Separators inside quoted text or a
// heredoc body also match, so a quoted example can count as use; that costs
// one extra stop. A command inside a quoted `bash -c` string is not seen.
const COMMAND_START = String.raw`(?:^|[\n;&|(\`]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|nohup|time|env|exec|command|then|do|else|elif|if|while|until|!|nice(?:[ \t]+-n[ \t]+-?\d+)?|timeout(?:[ \t]+-\S+)*[ \t]+\d\S*)[ \t]+)*`
const CLI_IN_COMMAND_POSITION = new RegExp(
  COMMAND_START +
    String.raw`["']?(?:[^\s"']*\/)?cua-driver["']?(?=[ \t\n;&|)\`]|$)`,
)
// `open -n -g -a CuaDriver --args serve`, the documented daemon start.
const APP_LAUNCH = new RegExp(
  COMMAND_START + String.raw`(?:\S*\/)?open[ \t][^\n;&|]*\bCuaDriver\b`,
)

export const CUA_DRIVER_OFF_MESSAGE =
  'The operator turned off computer use with the emergency stop, so cua-driver calls are refused. Do not retry or work around this with other tools. Tell the operator this step needs cua-driver and wait for them to turn it back on.'

export const CUA_DRIVER_RUN_ENDED_MESSAGE =
  'This run has already ended, so the cua-driver call was not started.'

/** The operator's emergency stop creates this file; deleting it re-enables cua-driver. */
export function getCuaDriverOffPath(): string {
  return join(getClaudeConfigHomeDir(), 'cua-driver.off')
}

export function isCuaDriverCommand(command: string): boolean {
  return CLI_IN_COMMAND_POSITION.test(command) || APP_LAUNCH.test(command)
}

export function isCuaDriverToolCall(toolName: string, input: unknown): boolean {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return true
  if (toolName !== BASH_TOOL_NAME) return false
  const command =
    typeof input === 'object' && input !== null && 'command' in input
      ? (input as { command: unknown }).command
      : undefined
  return typeof command === 'string' && isCuaDriverCommand(command)
}

/**
 * Checks the input a tool is about to run with, after hooks and the permission
 * decision had their chance to replace it. Returns a refusal message while the
 * operator's off switch exists or after the run ended; otherwise marks the run
 * so `query()` stops the daemon when the run ends, and returns null.
 */
export function checkCuaDriverToolCall(
  toolName: string,
  input: unknown,
  run: CuaDriverRun | undefined,
): string | null {
  if (!isCuaDriverToolCall(toolName, input)) return null
  if (existsSync(getCuaDriverOffPath())) return CUA_DRIVER_OFF_MESSAGE
  if (run && !run.markUsed()) return CUA_DRIVER_RUN_ENDED_MESSAGE
  return null
}
