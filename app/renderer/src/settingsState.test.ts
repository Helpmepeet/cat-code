import { expect, test } from 'bun:test'
import type {
  ServerFrame,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import {
  createSettingsState,
  reduceSettingsState,
  selectLayerOrigin,
  selectManagedFields,
  selectSettingField,
  selectSettingsSnapshot,
  SETTING_SOURCE_PRECEDENCE,
} from './settingsState.js'

const SNAPSHOT: SettingsSnapshot = {
  layers: [
    { source: 'userSettings', origin: '~/.cat-code/settings.json', keys: ['model', 'theme'] },
    { source: 'localSettings', origin: '.cat-code/settings.local.json', keys: ['theme'] },
    { source: 'policySettings', origin: 'managed-settings.json', keys: ['telemetry'] },
  ],
  resolved: [
    { key: 'model', source: 'userSettings', editable: true, managed: false },
    { key: 'telemetry', source: 'policySettings', editable: false, managed: true },
    { key: 'theme', source: 'localSettings', editable: true, managed: false },
  ],
  policyOrigin: 'file',
}

function snapshotFrame(
  sessionId: string,
  settings: SettingsSnapshot,
): ServerFrame {
  return { kind: 'settings.snapshot', protocolVersion: 1, sessionId, settings }
}

function lifecycleFrame(sessionId: string): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: 1, sessionId, status: 'exited' }
}

test('settings.snapshot frame stores the snapshot per session', () => {
  const state = reduceSettingsState(createSettingsState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  expect(selectSettingsSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectSettingsSnapshot(state, 'b')).toBeNull()
  expect(selectSettingsSnapshot(state, null)).toBeNull()
})

test('snapshots are isolated across sessions', () => {
  let state = createSettingsState()
  state = reduceSettingsState(state, { type: 'frame', frame: snapshotFrame('a', SNAPSHOT) })
  const other: SettingsSnapshot = { layers: [], resolved: [], policyOrigin: null }
  state = reduceSettingsState(state, { type: 'frame', frame: snapshotFrame('b', other) })
  expect(selectSettingsSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectSettingsSnapshot(state, 'b')).toEqual(other)
})

test('lifecycle resets a tracked snapshot but ignores an untracked session', () => {
  let state = reduceSettingsState(createSettingsState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  const before = state
  state = reduceSettingsState(state, { type: 'frame', frame: lifecycleFrame('unknown') })
  expect(state).toBe(before) // untracked → no new object
  state = reduceSettingsState(state, { type: 'frame', frame: lifecycleFrame('a') })
  expect(selectSettingsSnapshot(state, 'a')).toBeNull()
})

test('unrelated frame kinds are ignored', () => {
  const state = createSettingsState()
  const next = reduceSettingsState(state, {
    type: 'frame',
    frame: { kind: 'pong', protocolVersion: 1, sessionId: 'a', nonce: 'x' },
  })
  expect(next).toBe(state)
})

test('selectSettingField returns the winning resolution or null', () => {
  expect(selectSettingField(SNAPSHOT, 'telemetry')).toMatchObject({
    source: 'policySettings',
    managed: true,
    editable: false,
  })
  expect(selectSettingField(SNAPSHOT, 'model')).toMatchObject({
    source: 'userSettings',
    editable: true,
  })
  // Unset at every layer → default (null).
  expect(selectSettingField(SNAPSHOT, 'nonexistent')).toBeNull()
  expect(selectSettingField(null, 'model')).toBeNull()
})

test('selectManagedFields returns only policy-locked keys', () => {
  const managed = selectManagedFields(SNAPSHOT)
  expect(managed.map(f => f.key)).toEqual(['telemetry'])
  expect(selectManagedFields(null)).toEqual([])
})

test('selectLayerOrigin returns the layer path or null when absent', () => {
  expect(selectLayerOrigin(SNAPSHOT, 'userSettings')).toBe('~/.cat-code/settings.json')
  expect(selectLayerOrigin(SNAPSHOT, 'projectSettings')).toBeNull()
  expect(selectLayerOrigin(null, 'userSettings')).toBeNull()
})

test('precedence order is policy → flag → local → project → user (high→low)', () => {
  expect(SETTING_SOURCE_PRECEDENCE).toEqual([
    'policySettings',
    'flagSettings',
    'localSettings',
    'projectSettings',
    'userSettings',
  ])
})
