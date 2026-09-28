import { existsSync } from 'fs'
import { join } from 'path'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { CuaDriverRun } from './run.js'

const MCP_TOOL_PREFIX = 'mcp__cua-driver__'

// `cua-driver` as the command being run, not as an argument (`rg cua-driver`,
// `ls ~/.claude/skills/cua-driver`): at the start of the command or after a
// separator, pipe or `$(`, optionally behind env assignments or wrappers such
// as `timeout 30`, and optionally as a path ending in `/cua-driver`. A command
// hidden inside a quoted `bash -c` string is not seen.
const CLI_IN_COMMAND_POSITION =
  /(?:^|[\n;&|(`]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|nohup|time|env|exec|command|nice(?:[ \t]+-n[ \t]+-?\d+)?|timeout(?:[ \t]+-\S+)*[ \t]+\d\S*)[ \t]+)*(?:\S*\/)?cua-driver(?=[ \t\n;&|)`]|$)/
// `open -n -g -a CuaDriver --args serve`, the documented daemon start.
const APP_LAUNCH = /(?:^|[\n;&|(`]|\$\()[ \t]*open[ \t][^\n;&|]*\bCuaDriver\b/

export const CUA_DRIVER_OFF_MESSAGE =
  'The operator turned off computer use with the emergency stop, so cua-driver calls are refused. Do not retry or work around this with other tools. Tell the operator this step needs cua-driver and wait for them to turn it back on.'

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
 * operator's off switch exists; otherwise marks the run so `query()` stops the
 * daemon when the run ends, and returns null.
 */
export function checkCuaDriverToolCall(
  toolName: string,
  input: unknown,
  run: CuaDriverRun | undefined,
): string | null {
  if (!isCuaDriverToolCall(toolName, input)) return null
  if (existsSync(getCuaDriverOffPath())) return CUA_DRIVER_OFF_MESSAGE
  run?.markUsed()
  return null
}
