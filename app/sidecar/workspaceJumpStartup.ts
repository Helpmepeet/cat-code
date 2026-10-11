import { realpathSync } from 'node:fs'
import { readWorkspaceJump, upgradeWorkspaceJumpState, workspaceJumpRequiresRetention } from '../../src/utils/workspaceJumpState.js'
import { bootstrapWorkerEngine } from './workerRuntime.js'
import type { SessionBinding } from '../shared/sessionBinding.js'
import { readSessionRelocation, type SessionLocation } from '../../src/utils/sessionRelocationState.js'

function sameBinding(left: SessionBinding, right: SessionBinding): boolean {
  return left.kind === right.kind && (left.kind === 'project' || right.kind === 'managed' &&
    left.storageId === right.storageId && left.storageRootId === right.storageRootId)
}

/** Runs before runtime init, instruction discovery, or resume hooks. The
 * replacement's own canonical identity and saved engine trust are authoritative. */
export async function validateWorkspaceJumpStartup(appSessionId: string, cwd: string, engineSessionId: string | undefined, binding: SessionBinding): Promise<void> {
  const saved = readWorkspaceJump(appSessionId)
  const state = saved ? upgradeWorkspaceJumpState(saved) : null
  let location: SessionLocation
  if (state) {
    if (state.engineSessionId !== engineSessionId) throw new Error('Workspace change belongs to another conversation')
    location = cwd === state.source.cwd ? state.source : state.target
    const settled = !workspaceJumpRequiresRetention(state)
    if (settled) {
      const relocation = readSessionRelocation(state.engineSessionId)
      if (relocation) {
        if (relocation.phase !== 'complete' || relocation.appSessionId !== appSessionId ||
          relocation.engineSessionId !== engineSessionId || relocation.original.cwd !== state.source.cwd ||
          !sameBinding(relocation.original.binding, state.source.binding)) throw new Error('Workspace change location cannot be verified')
        location = relocation.target
      } else if (state.consumed) throw new Error('Workspace change location cannot be verified')
    }
  } else {
    // Manual moves have a relocation record but no conversational jump ledger.
    const relocation = engineSessionId ? readSessionRelocation(engineSessionId) : null
    if (!relocation) return
    if (relocation.phase !== 'complete' || relocation.appSessionId !== appSessionId ||
      relocation.engineSessionId !== engineSessionId) throw new Error('Workspace change location cannot be verified')
    location = relocation.target
  }
  if (cwd !== location.cwd || !sameBinding(binding, location.binding)) throw new Error('Workspace change location cannot be verified')
  if (realpathSync(cwd) !== location.cwd) throw new Error('Workspace change destination identity changed')
  if (binding.kind === 'managed') return
  await bootstrapWorkerEngine()
  const { isPathTrusted } = await import('../../src/utils/config.js')
  if (!isPathTrusted(cwd)) throw new Error('Workspace change destination is no longer trusted')
}
