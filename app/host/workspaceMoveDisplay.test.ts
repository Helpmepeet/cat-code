import { expect, test } from 'bun:test'
import { moveDisplayTarget, workspaceJumpDisplay } from './workspaceMoveDisplay.js'
import type { WorkspaceJumpState } from '../../src/utils/workspaceJumpState.js'
import type { SessionLocationTransition } from '../../src/utils/sessionRelocationState.js'

const state: WorkspaceJumpState = {
  version: 1, appSessionId: 'app', engineSessionId: 'engine', operationId: 'operation', sourceGeneration: 'generation',
  source: { cwd: '/chat', binding: { kind: 'managed', storageRootId: 'root', storageId: 'chat' } },
  target: { cwd: '/projects/cat-code', binding: { kind: 'project' } }, acceptedAt: 10,
  phase: 'accepted', location: 'source', consumed: false, cancelled: false,
  requiresUserReconciliation: false, sourceOutcomePersisted: false,
  continuation: { id: 'continuation', state: 'not_admitted' },
}
const seam: SessionLocationTransition = {
  id: 'seam', afterFrameId: 'last-frame', source: state.source, target: state.target, movedAt: 11,
}

test('accepted targets and durable location drive display, independently of continuation outcome', () => {
  expect(workspaceJumpDisplay(state, [])?.target).toMatchObject({ name: 'cat-code', path: '/projects/cat-code', kind: 'project' })
  expect(workspaceJumpDisplay(state, [])?.phase).toBe('moving')
  for (const [location, outcome, expected] of [
    ['source', 'failed', 'failed'], ['source', 'cancelled', 'stopped'],
    ['destination', 'completed', 'arrived'], ['destination', 'uncertain', 'arrived'],
    ['destination', 'cancelled', 'arrived'],
  ] as const) {
    const display = workspaceJumpDisplay({ ...state, phase: 'settled', location, outcome }, location === 'destination' ? [seam] : [])
    expect(display?.phase).toBe(expected)
    if (expected === 'arrived') {
      expect(display?.transitionId).toBe('seam')
      expect(display?.replacedNotice).toBeUndefined()
    }
  }
  expect(workspaceJumpDisplay({ ...state, phase: 'settled', location: 'destination' }, [
    seam, { ...seam, id: 'return', target: state.source, movedAt: 12 },
  ])).toBeNull()
  expect(moveDisplayTarget(state.source)).toEqual({ kind: 'chat', name: 'Chat', path: null })
  const oversized = moveDisplayTarget({ cwd: '/projects/' + 'x'.repeat(5000), binding: { kind: 'project' } })
  expect(oversized.name.length).toBe(256)
  expect(oversized.path?.length).toBe(4096)
})
