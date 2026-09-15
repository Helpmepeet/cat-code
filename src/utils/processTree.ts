// One implementation of "kill this process and everything it started".
//
// A signal sent to a spawned child reaches that child only. Anything it
// started of its own keeps running, reparented to init: background shell jobs
// for Bash, an MCP server per configured server for a nested engine launched
// through ClaudeCliTool. Both callers spawn detached so the child leads its own
// process group, which is what makes the group kill below able to reach the
// whole tree.

import treeKill from 'tree-kill'
import type { AgentId } from '../types/ids.js'

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

// Delegated (ClaudeCliTool) children, tracked by the agentId of whichever
// subagent spawned them. This is a backstop, not the primary reaper: abort,
// the run's own timeout, and the process.on('exit') listener in
// ClaudeCliTool.tsx each already tear a delegated tree down. It exists for
// the gap those miss — the streaming tool executor can discard an in-flight
// tool call without aborting it (ClaudeCliTool.tsx), which leaves nothing
// watching the child once the worker that spawned it has otherwise finished.
const delegatedChildrenByAgent = new Map<AgentId, Set<KillableChildProcess>>()

/**
 * Tracks `child` under `agentId` so a worker's run ending can reap it.
 * Returns the matching unregister, which the caller must invoke once the run
 * settles on its own (normal exit, abort, timeout, or spawn failure) so a
 * long-lived session doesn't accumulate stale entries.
 *
 * `agentId` is undefined for a main-thread call (ToolUseContext.agentId is
 * only set for a subagent). The main thread has no equivalent "run end" to
 * hook a per-run kill into — the session lives until the process itself
 * exits, which the process.on('exit') reaper already covers — so this
 * registers nothing and returns a no-op.
 */
export function registerDelegatedChild(
  agentId: AgentId | undefined,
  child: KillableChildProcess,
): () => void {
  if (!agentId) return () => {}

  let children = delegatedChildrenByAgent.get(agentId)
  if (!children) {
    children = new Set()
    delegatedChildrenByAgent.set(agentId, children)
  }
  children.add(child)

  return () => {
    const stillTracked = delegatedChildrenByAgent.get(agentId)
    if (!stillTracked) return
    stillTracked.delete(child)
    if (stillTracked.size === 0) {
      delegatedChildrenByAgent.delete(agentId)
    }
  }
}

/**
 * Kills every delegated child still registered to `agentId` and forgets them.
 * Called from runAgent.ts's finally block, beside killShellTasksForAgent, so a
 * worker's delegated Claude CLI runs die when the worker does.
 */
export function killDelegatedChildrenForAgent(agentId: AgentId): void {
  const children = delegatedChildrenByAgent.get(agentId)
  if (!children) return
  delegatedChildrenByAgent.delete(agentId)
  for (const child of children) {
    killProcessTree(child, 'SIGKILL')
  }
}
