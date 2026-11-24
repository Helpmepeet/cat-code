import { randomUUID } from 'node:crypto'
import { getCwdState } from '../bootstrap/state.js'
import type { ToolUseContext } from '../Tool.js'

export type WorkspaceTransitionCoordinator = {
  begin(operationId: string): Promise<void>
  finish(operationId: string, cwd: string): Promise<void>
}

let coordinator: WorkspaceTransitionCoordinator | null = null
let worktreeChanging = false
let activeTools = 0

export const WORKTREE_BUSY = 'Wait for running tools and background work to finish before changing worktrees.'

export function beginWorkspaceToolUse(): (() => void) | null {
  if (worktreeChanging) return null
  activeTools++
  return () => { activeTools-- }
}

export async function withWorktreeTransition<T>(context: ToolUseContext | undefined, change: () => T | Promise<T>): Promise<T> {
  if (context?.agentId) throw new Error('Only the main agent can change worktrees.')
  const checkIdle = () => {
    if (activeTools || Object.values(context?.getAppState().tasks ?? {}).some(
      task => task.status === 'running' || task.status === 'pending',
    )) throw new Error(WORKTREE_BUSY)
    context?.abortController.signal.throwIfAborted()
  }
  if (worktreeChanging) throw new Error(WORKTREE_BUSY)
  checkIdle()
  worktreeChanging = true
  try {
    return await withWorkspaceTransition(() => {
      checkIdle()
      return change()
    })
  } finally {
    worktreeChanging = false
  }
}

export function setWorkspaceTransitionCoordinator(next: WorkspaceTransitionCoordinator | null): void {
  coordinator = next
}

/** Hold checkout switching out until both the cwd and the host's observation settle. */
export async function withWorkspaceTransition<T>(change: () => T | Promise<T>): Promise<T> {
  const owner = coordinator
  if (!owner) return change()
  const operationId = randomUUID()
  await owner.begin(operationId)
  try {
    return await change()
  } finally {
    // An uncertain finish must not expire the host's hold: the engine might
    // already be in the destination checkout. Process exit clears the hold.
    await owner.finish(operationId, getCwdState())
  }
}
