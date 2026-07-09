import { expect, test } from 'bun:test'
import type { ServerFrame, WorkspaceTrustSnapshot } from '../../shared/protocol.js'
import {
  createWorkspaceTrustState,
  reduceWorkspaceTrustState,
  selectWorkspaceTrustSnapshot,
} from './workspaceTrustState.js'

const SNAPSHOT: WorkspaceTrustSnapshot = { trusted: true, detectedRepo: 'acme/cat-code' }

function snapshotFrame(sessionId: string, workspaceTrust: WorkspaceTrustSnapshot): ServerFrame {
  return { kind: 'workspace-trust.snapshot', protocolVersion: 1, sessionId, workspaceTrust }
}

function lifecycleFrame(sessionId: string): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: 1, sessionId, status: 'exited' }
}

test('workspace-trust.snapshot frame stores the snapshot per session', () => {
  const state = reduceWorkspaceTrustState(createWorkspaceTrustState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  expect(selectWorkspaceTrustSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectWorkspaceTrustSnapshot(state, 'b')).toBeNull()
  expect(selectWorkspaceTrustSnapshot(state, null)).toBeNull()
})

test('snapshots are isolated across sessions', () => {
  let state = createWorkspaceTrustState()
  state = reduceWorkspaceTrustState(state, { type: 'frame', frame: snapshotFrame('a', SNAPSHOT) })
  const other: WorkspaceTrustSnapshot = { trusted: false, detectedRepo: null }
  state = reduceWorkspaceTrustState(state, { type: 'frame', frame: snapshotFrame('b', other) })
  expect(selectWorkspaceTrustSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectWorkspaceTrustSnapshot(state, 'b')).toEqual(other)
})

test('lifecycle resets a tracked snapshot but ignores an untracked session', () => {
  let state = reduceWorkspaceTrustState(createWorkspaceTrustState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  const before = state
  state = reduceWorkspaceTrustState(state, { type: 'frame', frame: lifecycleFrame('unknown') })
  expect(state).toBe(before)
  state = reduceWorkspaceTrustState(state, { type: 'frame', frame: lifecycleFrame('a') })
  expect(selectWorkspaceTrustSnapshot(state, 'a')).toBeNull()
})

test('unrelated frame kinds are ignored', () => {
  const state = createWorkspaceTrustState()
  const next = reduceWorkspaceTrustState(state, {
    type: 'frame',
    frame: { kind: 'pong', protocolVersion: 1, sessionId: 'a', nonce: 'x' },
  })
  expect(next).toBe(state)
})
