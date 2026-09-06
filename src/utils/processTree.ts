// One implementation of "kill this process and everything it started".
//
// A signal sent to a spawned child reaches that child only. Anything it
// started of its own keeps running, reparented to init: background shell jobs
// for Bash, an MCP server per configured server for a nested engine launched
// through ClaudeCliTool. Both callers spawn detached so the child leads its own
// process group, which is what makes the group kill below able to reach the
// whole tree.

import treeKill from 'tree-kill'

/** The part of a spawned child a process-tree kill needs. */
export type KillableChildProcess = {
  readonly pid?: number | undefined
}

/**
 * Signals the process group led by `child`.
 *
 * A group is named by its leader's pid, so `-pid` resolves to a group only
 * when the child was spawned detached. For a child that shares this process's
 * group there is no group with that id and the call fails with ESRCH, which is
 * why a failure here is reported rather than thrown: it means "not a group
 * leader", not "nothing was killed".
 */
export function killProcessGroupSync(child: KillableChildProcess): boolean {
  const pid = child.pid
  if (!pid || process.platform === 'win32') {
    return false
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/**
 * Terminates a child and its descendants: the process group when the child
 * leads one, otherwise a walk of the process table (Windows has no process
 * groups to signal).
 */
export function killProcessTree(
  child: KillableChildProcess,
  signal: NodeJS.Signals,
): void {
  if (killProcessGroupSync(child)) {
    return
  }

  if (child.pid) {
    treeKill(child.pid, signal)
  }
}
