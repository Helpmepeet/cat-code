/**
 * Command semantics configuration for interpreting exit codes in different contexts.
 *
 * Many commands use exit codes to convey information other than just success/failure.
 * For example, grep returns 1 when no matches are found, which is not an error condition.
 */

import type { CommandAttribution } from '../../utils/bash/exitAttribution.js'

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * Default semantic: treat only 0 as success, everything else as error
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * Command-specific semantics
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=matches found, 1=no matches, 2+=error
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep has same semantics as grep
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find: 0=success, 1=partial success (some dirs inaccessible), 2+=error
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff: 0=no differences, 1=differences found, 2+=error
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[: 0=condition true, 1=condition false, 2+=error
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ is an alias for test
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // lsof: 0=files listed, 1=a search item was not located OR a real error.
  // Both share exit 1, so only the output tells them apart: usage errors,
  // unknown users/files/services, and warnings all print an `lsof: ` line,
  // while a clean no-match prints nothing. BashTool merges stderr into stdout,
  // so the diagnostic is looked for in both.
  [
    'lsof',
    (exitCode, stdout, stderr) => {
      if (exitCode !== 1) {
        return DEFAULT_SEMANTIC(exitCode, stdout, stderr)
      }
      const hasDiagnostic = /^lsof: /m.test(`${stdout}\n${stderr}`)
      return hasDiagnostic
        ? DEFAULT_SEMANTIC(exitCode, stdout, stderr)
        : { isError: false, message: 'No matching open files' }
    },
  ],

  // wc, head, tail, cat, etc.: these typically only fail on real errors
  // so we use default semantics
])

export const SEMANTIC_COMMAND_NAMES: ReadonlySet<string> = new Set(
  COMMAND_SEMANTICS.keys(),
)

/**
 * Interpret command result based on semantic rules.
 *
 * A command-specific rule applies only when `attribution` proves that command
 * started and owns the final status; otherwise any non-zero exit is an error.
 * In `cd /missing && grep x f`, grep never ran, so its "exit 1 = no matches"
 * rule must not turn cd's failure into a success.
 */
export function interpretCommandResult(
  exitCode: number,
  stdout: string,
  stderr: string,
  attribution: CommandAttribution | null,
): {
  isError: boolean
  message?: string
} {
  if (
    exitCode === 0 ||
    attribution === null ||
    !attribution.semanticCommandStarted ||
    (attribution.pipelineHasMultipleCommands && attribution.pipefailEnabled)
  ) {
    return DEFAULT_SEMANTIC(exitCode, stdout, stderr)
  }
  const semantic =
    COMMAND_SEMANTICS.get(attribution.semanticCommand) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}
