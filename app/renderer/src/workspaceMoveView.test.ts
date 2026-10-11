import { expect, test } from 'bun:test'
import { readWorkspaceMoveDisplay } from './workspaceMoveView.js'

test('workspace move display accepts bounded continuation states and rejects unknown ones', () => {
  const move = {
    id: 'jump', phase: 'arrived', agentJump: true,
    target: { kind: 'project', name: 'destination', path: '/tmp/destination' },
  } as const
  for (const continuation of ['waiting', 'dispatched', 'finished'] as const) {
    expect(readWorkspaceMoveDisplay({ ...move, continuation })).toEqual({ ...move, continuation })
  }
  expect(readWorkspaceMoveDisplay({ ...move, continuation: 'new-state' })).toBeNull()
  expect(readWorkspaceMoveDisplay({ ...move, continuation: 3 })).toBeNull()
})
