import { homedir } from 'node:os'
import { basename } from 'node:path'
import { handoffOutcomeText } from '../../src/app-runtime/handoff.js'
import type { WorkspaceJumpState } from '../../src/utils/workspaceJumpState.js'
import type { SessionLocation, SessionLocationTransition } from '../../src/utils/sessionRelocationState.js'
import type { WorkspaceMoveDisplay } from '../shared/hostApi.js'

/** Presentation has no authority over relocation or continuation admission. */
export function moveDisplayTarget(target: SessionLocation): WorkspaceMoveDisplay['target'] {
  return {
    kind: target.binding.kind === 'project' ? 'project' : 'chat',
    name: target.binding.kind === 'project' ? (basename(target.cwd) || target.cwd).slice(0, 256) : 'Chat',
    path: target.binding.kind === 'project' ? target.cwd.slice(0, 4096) : null,
    ...(target.binding.kind === 'project' ? { displayPath: (target.cwd.startsWith(homedir() + '/')
      ? '~' + target.cwd.slice(homedir().length) : target.cwd).slice(0, 4096) } : {}),
  }
}

export function workspaceJumpDisplay(
  state: WorkspaceJumpState,
  transitions: readonly SessionLocationTransition[],
): WorkspaceMoveDisplay | null {
  const latest = transitions.at(-1)
  // A later manual move owns the current seam, even after reopening the app.
  if (latest && latest.movedAt > state.acceptedAt && latest.target.cwd !== state.target.cwd) return null
  const arrival = latest && latest.movedAt >= state.acceptedAt && latest.target.cwd === state.target.cwd
    ? latest : undefined
  const phase = state.phase !== 'settled' ? 'moving'
    : state.location === 'destination' ? 'arrived'
    : state.outcome === 'cancelled' ? 'stopped' : 'failed'
  return {
    id: state.operationId.slice(0, 128),
    target: moveDisplayTarget(state.target),
    phase,
    agentJump: true,
    ...(phase === 'failed' || phase === 'stopped'
      ? { replacedNotice: handoffOutcomeText(phase === 'stopped' ? 'cancelled' : 'failed').slice(0, 512) } : {}),
    ...(arrival ? { transitionId: arrival.id, afterFrameId: arrival.afterFrameId } : {}),
    ...(state.boundary ? { toolUseId: state.boundary.toolUseId.slice(0, 256) } : {}),
  }
}
