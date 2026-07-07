import { expect, test } from 'bun:test'
import { scanForSecrets } from '../shared/secretGuard.js'
import type { SettingsSnapshotFrame } from '../shared/protocol.js'
import {
  buildSettingsSnapshot,
  createSidecarSettingsDomain,
  type SettingsSourceLayer,
} from './settingsDomain.js'

// Ascending precedence (index 0 lowest), matching getSettingsWithSources().sources.
const LAYERS: SettingsSourceLayer[] = [
  {
    source: 'userSettings',
    origin: '/home/u/.cat-code/settings.json',
    settings: { model: 'opus', theme: 'dark', displayName: 'Ada' },
  },
  {
    source: 'projectSettings',
    origin: '/repo/.cat-code/settings.json',
    settings: { model: 'sonnet', coAuthor: true },
  },
  {
    source: 'localSettings',
    origin: '/repo/.cat-code/settings.local.json',
    settings: { theme: 'light' },
  },
  {
    source: 'flagSettings',
    origin: 'command line arguments',
    settings: { model: 'haiku' },
  },
  {
    source: 'policySettings',
    origin: '/Library/Managed/managed-settings.json',
    settings: { telemetry: true },
  },
]

test('the winning source of each key is the highest-precedence layer that set it', () => {
  const snapshot = buildSettingsSnapshot(LAYERS, 'file')
  const byKey = new Map(snapshot.resolved.map(r => [r.key, r]))

  // model set at user/project/flag → flag wins (higher than local/project/user).
  expect(byKey.get('model')?.source).toBe('flagSettings')
  // theme set at user + local → local wins.
  expect(byKey.get('theme')?.source).toBe('localSettings')
  // displayName only at user.
  expect(byKey.get('displayName')?.source).toBe('userSettings')
  // coAuthor only at project.
  expect(byKey.get('coAuthor')?.source).toBe('projectSettings')
  // telemetry only at policy.
  expect(byKey.get('telemetry')?.source).toBe('policySettings')
})

test('editable/managed status follows the winning source', () => {
  const snapshot = buildSettingsSnapshot(LAYERS, 'file')
  const byKey = new Map(snapshot.resolved.map(r => [r.key, r]))

  // policy-won → managed + not editable.
  expect(byKey.get('telemetry')).toMatchObject({ managed: true, editable: false })
  // flag-won → not managed, but not editable from settings either.
  expect(byKey.get('model')).toMatchObject({ managed: false, editable: false })
  // user/project/local-won → editable, not managed.
  expect(byKey.get('theme')).toMatchObject({ managed: false, editable: true })
  expect(byKey.get('displayName')).toMatchObject({ managed: false, editable: true })
  expect(byKey.get('coAuthor')).toMatchObject({ managed: false, editable: true })
})

test('layers carry key NAMES only (never values) and keep ascending order', () => {
  const snapshot = buildSettingsSnapshot(LAYERS, 'file')
  expect(snapshot.layers.map(l => l.source)).toEqual([
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ])
  expect(snapshot.layers[0]!.keys.sort()).toEqual(['displayName', 'model', 'theme'])
  expect(snapshot.policyOrigin).toBe('file')
})

test('resolved is sorted by key for stable rendering', () => {
  const snapshot = buildSettingsSnapshot(LAYERS, null)
  const keys = snapshot.resolved.map(r => r.key)
  expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)))
})

test('empty layers → empty model, null policy origin', () => {
  const snapshot = buildSettingsSnapshot([], null)
  expect(snapshot.layers).toEqual([])
  expect(snapshot.resolved).toEqual([])
  expect(snapshot.policyOrigin).toBeNull()
})

test('the domain reads once at spawn — getSnapshot returns a stable reference', () => {
  // Captured at construction, not re-read (and not reset) per attach: the same
  // reference comes back every call (null === null if the env has no settings).
  const domain = createSidecarSettingsDomain()
  const first = domain.getSnapshot()
  const second = domain.getSnapshot()
  expect(first).toBe(second)
})

test('carries no secret material even when a source holds tokens (redaction proof)', () => {
  // A settings source whose VALUES contain credentials AND whose key names
  // collide with the secret guard's blocklist. The snapshot must expose neither.
  const withSecrets: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      settings: {
        apiKey: 'sk-live-DEADBEEF',
        env: { ANTHROPIC_API_KEY: 'sk-live-TOPSECRET' },
        apiKeyHelper: 'echo sk-live-HELPER',
        model: 'opus',
      },
    },
  ]
  const frame: SettingsSnapshotFrame = {
    kind: 'settings.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    settings: buildSettingsSnapshot(withSecrets, null),
  }

  // No secret VALUE serialized anywhere in the frame.
  const serialized = JSON.stringify(frame)
  expect(serialized).not.toContain('sk-live')
  expect(serialized).not.toContain('TOPSECRET')

  // The outbound secret guard passes: setting names ride as string values in
  // `resolved[].key`, never as object keys the guard inspects — so even a key
  // literally named `apiKey` does not block the frame.
  const scan = scanForSecrets(frame)
  expect(scan.ok).toBe(true)

  // The `apiKey` key name is still surfaced (as data), just not as a secret.
  const keys = frame.settings.resolved.map(r => r.key)
  expect(keys).toContain('apiKey')
})
