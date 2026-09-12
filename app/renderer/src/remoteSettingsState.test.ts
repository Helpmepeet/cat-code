import { expect, test } from 'bun:test'
import type {
  LifecycleFrame,
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  RemoteSettingsSnapshotFrame,
} from '../../shared/protocol.js'
import {
  createRemoteSettingsState,
  reduceRemoteSettingsState,
  selectRemoteSettingsSnapshot,
} from './remoteSettingsState.js'

function snapshot(over: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
  return {
    bridge: { enabled: false, error: null, transport: 'v2' },
    commandFilter: { skillSafe: ['summarize'], optIn: ['compact'], blocked: ['model'] },
    ...over,
  }
}

test('unknown session selects null', () => {
  const state = createRemoteSettingsState()
  expect(selectRemoteSettingsSnapshot(state, 's1')).toBeNull()
  expect(selectRemoteSettingsSnapshot(state, null)).toBeNull()
})

test('remoteSettings.snapshot is stored per session', () => {
  const state = createRemoteSettingsState()
  const frame: RemoteSettingsSnapshotFrame = {
    kind: 'remoteSettings.snapshot',
    protocolVersion: 2,
    sessionId: 's1',
    remoteSettings: snapshot(),
  }
  const next = reduceRemoteSettingsState(state, { type: 'frame', frame })
  expect(selectRemoteSettingsSnapshot(next, 's1')).toEqual(snapshot())
  expect(selectRemoteSettingsSnapshot(next, 's2')).toBeNull()
})

test('remoteSettings.result is stored as lastResult', () => {
  const state = createRemoteSettingsState()
  const frame: RemoteSettingsResultFrame = {
    kind: 'remoteSettings.result',
    protocolVersion: 2,
    sessionId: 's1',
    requestId: 'r1',
    verb: 'remoteSettings.bridgeToggle',
    ok: true,
    message: 'Remote Control bridge enabled.',
  }
  const next = reduceRemoteSettingsState(state, { type: 'frame', frame })
  expect(next.lastResult).toEqual(frame)
})

test('lifecycle nulls an existing session snapshot', () => {
  const withSnap = reduceRemoteSettingsState(createRemoteSettingsState(), {
    type: 'frame',
    frame: {
      kind: 'remoteSettings.snapshot',
      protocolVersion: 2,
      sessionId: 's1',
      remoteSettings: snapshot(),
    },
  })
  const frame: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 2,
    sessionId: 's1',
    status: 'disconnected',
  }
  const next = reduceRemoteSettingsState(withSnap, { type: 'frame', frame })
  expect(selectRemoteSettingsSnapshot(next, 's1')).toBeNull()
})

test('lifecycle for an unknown session is a no-op', () => {
  const state = createRemoteSettingsState()
  const frame: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 2,
    sessionId: 'unknown',
    status: 'disconnected',
  }
  const next = reduceRemoteSettingsState(state, { type: 'frame', frame })
  expect(next).toBe(state)
})

test('an unrelated frame kind is a no-op', () => {
  const state = createRemoteSettingsState()
  const next = reduceRemoteSettingsState(state, {
    type: 'frame',
    frame: { kind: 'pong', protocolVersion: 2, sessionId: 's1', nonce: 'x' },
  })
  expect(next).toBe(state)
})
