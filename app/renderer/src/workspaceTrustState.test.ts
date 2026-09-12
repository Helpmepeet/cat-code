import { expect, test } from 'bun:test'
import type { ServerFrame, WorkspaceTrustSnapshot } from '../../shared/protocol.js'
import {
  createWorkspaceTrustState,
  reduceWorkspaceTrustState,
  selectWorkspaceTrustError,
  selectWorkspaceTrustSnapshot,
} from './workspaceTrustState.js'

const SNAPSHOT: WorkspaceTrustSnapshot = {
  trusted: true,
  detectedRepo: 'acme/cat-code',
  trustRoot: '/repo',
}

function snapshotFrame(sessionId: string, workspaceTrust: WorkspaceTrustSnapshot): ServerFrame {
  return { kind: 'workspace-trust.snapshot', protocolVersion: 2, sessionId, workspaceTrust }
}

function lifecycleFrame(sessionId: string): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: 2, sessionId, status: 'exited' }
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
  const other: WorkspaceTrustSnapshot = {
    trusted: false,
    detectedRepo: null,
    trustRoot: '/other',
  }
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
    frame: { kind: 'pong', protocolVersion: 2, sessionId: 'a', nonce: 'x' },
  })
  expect(next).toBe(state)
})

function trustResultFrame(
  sessionId: string,
  ok: boolean,
  message: string,
): ServerFrame {
  return {
    kind: 'workspace.trust.result',
    protocolVersion: 2,
    sessionId,
    requestId: 'r',
    ok,
    message,
  }
}

test('workspace.trust.result surfaces an ok:false message for its session only', () => {
  let state = createWorkspaceTrustState()
  expect(selectWorkspaceTrustError(state, 'a')).toBeNull()

  state = reduceWorkspaceTrustState(state, {
    type: 'frame',
    frame: trustResultFrame('a', false, 'Trust write did not persist.'),
  })
  expect(selectWorkspaceTrustError(state, 'a')).toBe('Trust write did not persist.')
  // Not surfaced for a different session, or a null active session.
  expect(selectWorkspaceTrustError(state, 'b')).toBeNull()
  expect(selectWorkspaceTrustError(state, null)).toBeNull()
})

test('a successful trust result surfaces no error (the snapshot re-broadcast clears the gate)', () => {
  const state = reduceWorkspaceTrustState(createWorkspaceTrustState(), {
    type: 'frame',
    frame: trustResultFrame('a', true, 'Workspace trusted.'),
  })
  expect(selectWorkspaceTrustError(state, 'a')).toBeNull()
})
