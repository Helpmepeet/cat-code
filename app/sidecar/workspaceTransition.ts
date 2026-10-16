import type { WorkspaceTransitionCoordinator } from '../../src/utils/workspaceTransition.js'
import { requestPeerHost, type PeerHostRequester } from './peerHostRequester.js'

/** Internal coordination on HOST-REQUEST-PLANE, not a model-facing host tool. */
export function createWorkspaceTransitionCoordinator(request: PeerHostRequester = requestPeerHost): WorkspaceTransitionCoordinator {
  return {
    async begin(operationId) {
      const result = await request('workspace.transition.begin', { operationId })
      if (!result.ok || result.value.operationId !== operationId) {
        throw new Error(`Could not change the working folder. Wait for branch switching to finish and try again. (${result.ok ? 'mismatched operation' : result.error.code})`)
      }
    },
    async finish(operationId, cwd) {
      const result = await request('workspace.transition.finish', { operationId, cwd })
      if (!result.ok || result.value.operationId !== operationId) {
        throw new Error(`The app could not confirm the working folder. Reopen this chat before switching branches. (${result.ok ? 'mismatched operation' : result.error.code})`)
      }
    },
  }
}
