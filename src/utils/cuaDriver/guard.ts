import { existsSync } from 'fs'
import { join } from 'path'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { CuaDriverRun } from './run.js'

const MCP_TOOL_PREFIX = 'mcp__cua-driver__'

// Detection works on text because the tree-sitter parser behind
// parseForSecurity is compiled out of the desktop sidecar (it is not in the
// sidecar's --feature list), and the desktop is where agents drive the GUI.
//
// A command starts at the beginning, after a separator, pipe or `$(`, and may
// sit behind env assignments, wrappers (`timeout 30`, `nohup`) or shell
// keywords (`then`, `do`, `if`). The executable may be quoted or given as a
// path. Commands inside a heredoc body or a quoted `bash -c` string are data
// here and are not seen.
const COMMAND_START = String.raw`(?:^|[\n;&|(\`{]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|nohup|time|env|exec|command|then|do|else|elif|if|while|until|!|nice(?:[ \t]+-n[ \t]+-?\d+)?|timeout(?:[ \t]+-\S+)*[ \t]+\d\S*)[ \t]+)*`
const CLI_IN_COMMAND_POSITION = new RegExp(
  COMMAND_START +
    String.raw`["']?(?:[^\s"']*\/)?cua-driver["']?(?=[ \t\n;&|)\`]|$)`,
)
// `open -n -g -a CuaDriver --args serve`, the documented daemon start.
const APP_LAUNCH = new RegExp(
  COMMAND_START + String.raw`(?:\S*\/)?open[ \t][^\n;&|]*\bCuaDriver\b`,
)

// Blank heredoc bodies: their lines are input text, not commands.
function blankHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const pending: { delimiter: string; stripTabs: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = pending[0]
    if (open) {
      const line = open.stripTabs ? lines[i]!.replace(/^\t+/, '') : lines[i]!
      if (line === open.delimiter) pending.shift()
      lines[i] = ''
      continue
    }
    for (const match of lines[i]!.matchAll(
      /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g,
    )) {
      pending.push({ delimiter: match[3]!, stripTabs: match[1] === '-' })
    }
  }
  return lines.join('\n')
}

// Replace characters that could start a command with spaces when they sit
// inside quotes or are backslash-escaped, so `echo '$(cua-driver status)'`,
// `echo "a; cua-driver"` or `grep "a\|cua-driver"` does not read as a command.
// Inside double quotes `$(` and backticks still substitute, so they are kept.
function maskQuotedSeparators(command: string): string {
  let out = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== "'" && c === '\\') {
      const next = command[i + 1] ?? ''
      out += c + (/[\n;&|()`${}]/.test(next) ? ' ' : next)
      i++
      continue
    }
    if (quote === null) {
      if (c === "'" || c === '"') quote = c
      out += c
      continue
    }
    if (c === quote) {
      quote = null
      out += c
      continue
    }
    if (quote === "'") {
      out += /[\n;&|()`${}]/.test(c) ? ' ' : c
      continue
    }
    out += /[\n;&|{]/.test(c) || (c === '(' && command[i - 1] !== '$') ? ' ' : c
  }
  return out
}

export const CUA_DRIVER_OFF_MESSAGE =
  'The operator turned off computer use with the emergency stop, so cua-driver calls are refused. Do not retry or work around this with other tools. Tell the operator this step needs cua-driver and wait for them to turn it back on.'

export const CUA_DRIVER_RUN_ENDED_MESSAGE =
  'This run has already ended, so the cua-driver call was not started.'

/** The operator's emergency stop creates this file; deleting it re-enables cua-driver. */
export function getCuaDriverOffPath(): string {
  return join(getClaudeConfigHomeDir(), 'cua-driver.off')
}

export function isCuaDriverCommand(command: string): boolean {
  if (!/cua-driver|CuaDriver/.test(command)) return false
  const text = maskQuotedSeparators(blankHeredocBodies(command))
  return CLI_IN_COMMAND_POSITION.test(text) || APP_LAUNCH.test(text)
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

export type CuaDriverCallGate =
  | { kind: 'refused'; message: string }
  | { kind: 'allowed'; finish: () => void }

/**
 * Checks the input a tool is about to run with, after hooks and the permission
 * decision had their chance to replace it. Returns null for calls that are not
 * cua-driver. Otherwise refuses while the operator's off switch exists or after
 * the run ended; when allowed, the caller must call `finish` once the tool
 * call settles.
 */
export async function beginCuaDriverToolCall(
  toolName: string,
  input: unknown,
  run: CuaDriverRun | undefined,
): Promise<CuaDriverCallGate | null> {
  if (!isCuaDriverToolCall(toolName, input)) return null
  if (existsSync(getCuaDriverOffPath())) {
    return { kind: 'refused', message: CUA_DRIVER_OFF_MESSAGE }
  }
  if (!run) return { kind: 'allowed', finish: () => {} }
  if (!(await run.beginCall())) {
    return { kind: 'refused', message: CUA_DRIVER_RUN_ENDED_MESSAGE }
  }
  return { kind: 'allowed', finish: () => run.endCall() }
}
