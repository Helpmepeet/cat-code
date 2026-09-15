// Ownership gate for process-terminating bash commands issued by a subagent.
//
// A worker used to be able to discover process ids with `ps` in one call and
// terminate them with a plain `kill 1 2 3` in the next. Nothing in the bash
// permission path connected the two, so the numbers were just numbers. The
// runtime does know which shells it started for which agent: BashTool stamps
// ToolUseContext.agentId onto every shell task it spawns, LocalShellTaskState
// carries it, and killShellTasksForAgent already terminates by agent. The link
// that was missing is the process id behind each task, which ShellCommand.pid
// supplies. With that, a worker's kill target can be matched against the shells
// that worker actually started, and everything else is refused.
//
// The main thread is not gated: no agentId, no check.

import type { AppState } from '../../state/AppState.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { PermissionResult } from '../../types/permissions.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { BASH_TOOL_NAME } from './toolName.js'

/** Terminates by process id, so a target can be checked against owned shells. */
const PID_KILL_PROGRAMS = new Set(['kill'])

/**
 * Terminates by name or pattern. The set of processes these hit is decided by
 * the process table at run time, so no static check can bound it.
 */
const PATTERN_KILL_PROGRAMS = new Set(['pkill', 'killall'])

/**
 * Tokens that stand in front of the real program without changing it. `xargs`
 * is included so `… | xargs kill` is recognised, but it feeds targets from
 * stdin, which is why isTargetFedFromStdin exists below.
 */
const COMMAND_PREFIXES = new Set([
  'sudo',
  'doas',
  'command',
  'builtin',
  'exec',
  'env',
  'nohup',
  'setsid',
  'nice',
  'stdbuf',
  'time',
  'timeout',
  'gtimeout',
  'xargs',
])

/** VAR=value in command position. */
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/

/**
 * Highest number treated as a signal rather than a process group when it
 * follows a dash. Real signal numbers stop well below this on every platform
 * we run on; anything larger is a pid.
 */
const MAX_SIGNAL_NUMBER = 64

export type KillTargets =
  /** Every target resolved to a literal number. Group ids are stored positive. */
  | { kind: 'pids'; program: string; pids: number[] }
  /** At least one target cannot be resolved without running the command. */
  | { kind: 'unresolvable'; program: string }

/** Drops one layer of matching quotes so `kill '123'` reads as `kill 123`. */
function unquote(token: string): string {
  if (token.length < 2) {
    return token
  }
  const first = token[0]
  if (
    (first === '"' || first === "'") &&
    token[token.length - 1] === first &&
    !token.slice(1, -1).includes(first)
  ) {
    return token.slice(1, -1)
  }
  return token
}

function programName(token: string): string {
  const slash = token.lastIndexOf('/')
  return slash === -1 ? token : token.slice(slash + 1)
}

/**
 * Reads the arguments of a `kill` invocation. Returns null as soon as one
 * argument is something other than a literal number or a signal flag, because
 * a target we cannot name is a target we cannot prove is ours.
 */
function parseKillArguments(args: string[]): number[] | null {
  const pids: number[] = []
  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const arg = unquote(args[i]!)
    if (arg === '') {
      continue
    }
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg === '-s') {
      i++
      continue
    }
    if (!optionsEnded && arg === '-n') {
      i++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1)
      if (/^\d+$/.test(body)) {
        const value = Number(body)
        // A leading dash on a number means a signal while no target has been
        // named yet and the value is small enough to be one. Otherwise it is
        // a process group, which we record as its positive group id.
        if (!optionsEnded && pids.length === 0 && value <= MAX_SIGNAL_NUMBER) {
          continue
        }
        pids.push(value)
        continue
      }
      if (!optionsEnded && /^[A-Za-z][A-Za-z0-9]*$/.test(body)) {
        continue
      }
      return null
    }
    if (/^\d+$/.test(arg)) {
      pids.push(Number(arg))
      continue
    }
    return null
  }
  return pids
}

/**
 * `xargs kill` takes its targets from the previous stage of the pipeline, so
 * the arguments written on the line are not the full target list.
 */
function isTargetFedFromStdin(tokens: string[], programIndex: number): boolean {
  for (let i = 0; i < programIndex; i++) {
    if (programName(unquote(tokens[i]!)) === 'xargs') {
      return true
    }
  }
  return false
}

/**
 * Finds every process-terminating invocation in a command. Only the command
 * position of each pipeline stage counts, so `rg kill src/` and `echo kill`
 * are not invocations.
 */
export function findKillInvocations(command: string): KillTargets[] {
  const found: KillTargets[] = []
  for (const part of splitCommand_DEPRECATED(command)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (
      i < tokens.length &&
      (ENV_ASSIGNMENT.test(tokens[i]!) ||
        COMMAND_PREFIXES.has(programName(unquote(tokens[i]!))) ||
        tokens[i]!.startsWith('-') ||
        /^\d+[smhd]?$/.test(tokens[i]!))
    ) {
      i++
    }
    if (i >= tokens.length) {
      continue
    }
    const program = programName(unquote(tokens[i]!))
    if (PATTERN_KILL_PROGRAMS.has(program)) {
      found.push({ kind: 'unresolvable', program })
      continue
    }
    if (!PID_KILL_PROGRAMS.has(program)) {
      continue
    }
    if (isTargetFedFromStdin(tokens, i)) {
      found.push({ kind: 'unresolvable', program })
      continue
    }
    const pids = parseKillArguments(tokens.slice(i + 1))
    found.push(
      pids === null
        ? { kind: 'unresolvable', program }
        : { kind: 'pids', program, pids },
    )
  }
  return found
}

/**
 * Process ids of the shells this agent has running. The shell is its own
 * process group leader, so the same number covers `kill -pid` too.
 */
export function ownedShellPids(
  agentId: AgentId,
  appState: AppState,
): Set<number> {
  const pids = new Set<number>()
  for (const task of Object.values(appState.tasks ?? {})) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      const pid = task.shellCommand?.pid
      if (pid !== undefined) {
        pids.add(pid)
      }
    }
  }
  return pids
}

const DENY_GUIDANCE =
  'Stop only a command you started yourself, using the process id that command reported. ' +
  'Commands you start in the background are stopped for you when your work finishes, so ' +
  'waiting for one or reading its output so far is usually the better move. ' +
  'If a process really has to go, say so in your result and let the person running you do it.'

/**
 * Deny a subagent's attempt to terminate a process it did not start.
 * Returns null for the main thread, for commands that terminate nothing, and
 * for targets that are all this agent's own shells.
 */
export function checkKillOwnership(
  command: string,
  context: ToolUseContext,
): PermissionResult | null {
  const agentId = context.agentId
  if (!agentId) {
    return null
  }
  // Cheap reject for the overwhelming majority of commands, before parsing.
  if (!/(^|[^\w-])(kill|pkill|killall)([^\w-]|$)/.test(command)) {
    return null
  }
  const invocations = findKillInvocations(command)
  if (invocations.length === 0) {
    return null
  }
  const owned = ownedShellPids(agentId, context.getAppState())
  for (const invocation of invocations) {
    if (invocation.kind === 'unresolvable') {
      return {
        behavior: 'deny',
        message:
          `Permission to use ${BASH_TOOL_NAME} with command ${command} has been denied. ` +
          `This command does not name the processes ${invocation.program} would stop, ` +
          `so there is no way to tell whether they belong to you. ` +
          DENY_GUIDANCE,
        decisionReason: {
          type: 'asyncAgent',
          reason: `${invocation.program} targets cannot be resolved to a process this agent started`,
        },
      }
    }
    const foreign = invocation.pids.filter(pid => !owned.has(pid))
    if (foreign.length > 0) {
      return {
        behavior: 'deny',
        message:
          `Permission to use ${BASH_TOOL_NAME} with command ${command} has been denied. ` +
          `You did not start ${foreign.length === 1 ? 'process' : 'processes'} ` +
          `${foreign.join(', ')}, and other work on this machine may depend on ${foreign.length === 1 ? 'it' : 'them'}. ` +
          DENY_GUIDANCE,
        decisionReason: {
          type: 'asyncAgent',
          reason: `kill targets ${foreign.join(', ')} were not started by this agent`,
        },
      }
    }
  }
  return null
}
