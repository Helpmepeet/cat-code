import { getCwdState } from '../../src/bootstrap/state.js'
import { getBranch } from '../../src/utils/git.js'
import type { WorkspaceObservation } from '../shared/protocol.js'

export type WorkspaceObserver = {
  getSnapshot(): WorkspaceObservation
  conversationContinued(): Promise<void>
}

export async function createWorkspaceObserver(
  restored: { lastWorkingBranch?: string | null } | undefined,
  dependencies = {
    cwd: getCwdState,
    branch: getBranch,
  },
): Promise<WorkspaceObserver> {
  const normalize = (branch: string | undefined | null) => branch === 'HEAD' ? null : branch
  let lastWorkingBranch = normalize(restored ? restored.lastWorkingBranch : await dependencies.branch())
  let pending = Promise.resolve()
  return {
    getSnapshot: () => ({
      cwd: dependencies.cwd(),
      ...(lastWorkingBranch !== undefined ? { lastWorkingBranch } : {}),
    }),
    conversationContinued() {
      pending = pending.catch(() => {}).then(async () => {
        lastWorkingBranch = normalize(await dependencies.branch())
      })
      return pending
    },
  }
}
