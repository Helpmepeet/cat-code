import { randomUUID } from 'node:crypto'
import { getCwdState } from '../bootstrap/state.js'

export type WorkspaceTransitionCoordinator = {
  begin(operationId: string): Promise<void>
  finish(operationId: string, cwd: string): Promise<void>
}

let coordinator: WorkspaceTransitionCoordinator | null = null

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
