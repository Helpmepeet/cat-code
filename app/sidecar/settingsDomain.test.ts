import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSourceDisplayName,
  SETTING_SOURCES,
  type EditableSettingSource,
  type SettingSource,
} from '../../src/utils/settings/constants.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import { SOURCE_LABEL } from '../renderer/src/SettingsField.js'
import { SETTING_SOURCE_PRECEDENCE } from '../renderer/src/settingsState.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  SettingsSnapshotFrame,
  SettingSourceId,
  SettingsVerbMessage,
} from '../shared/protocol.js'
import {
  buildSettingsSnapshot,
  createSidecarSettingsDomain,
  type SettingsSourceLayer,
} from './settingsDomain.js'

type AssertAssignable<T extends true> = T
type ProtocolCoversEngineSettingSources = AssertAssignable<
  Exclude<SettingSource, SettingSourceId> extends never ? true : false
>
type EngineCoversProtocolSettingSources = AssertAssignable<
  Exclude<SettingSourceId, SettingSource> extends never ? true : false
>
void (null as unknown as ProtocolCoversEngineSettingSources)
void (null as unknown as EngineCoversProtocolSettingSources)

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
  expect(snapshot.layers.map(l => l.source)).toEqual([...SETTING_SOURCES])
  expect(snapshot.layers[0]!.keys.sort()).toEqual(['displayName', 'model', 'theme'])
  expect(snapshot.policyOrigin).toBe('file')
})

test('settings source labels, display order, and editability mirror the engine taxonomy', () => {
  // Source order: src/utils/settings/constants.ts:7-22.
  expect(SETTING_SOURCES).toEqual([
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ])
  expect(SETTING_SOURCE_PRECEDENCE).toEqual([...SETTING_SOURCES].reverse())

  // Display labels: src/utils/settings/constants.ts:46-64.
  for (const source of SETTING_SOURCES) {
    expect(SOURCE_LABEL[source]).toBe(getSourceDisplayName(source))
  }

  // Editability: src/utils/settings/constants.ts:180-185.
  const editableSources: ReadonlySet<SettingSource> = new Set<EditableSettingSource>([
    'userSettings',
    'projectSettings',
    'localSettings',
  ])
  const bySource = new Map(
    buildSettingsSnapshot(
      SETTING_SOURCES.map(source => ({
        source,
        origin: source,
        settings: { [source]: true },
      })),
      null,
    ).resolved.map(resolution => [resolution.source, resolution]),
  )
  for (const source of SETTING_SOURCES) {
    expect(bySource.get(source)?.editable).toBe(editableSources.has(source))
    expect(bySource.get(source)?.managed).toBe(source === 'policySettings')
  }
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

/* ── P4-19 editableValues (bounded, non-secret) ─────────────────────────────── */

test('editableValues carries the winning value ONLY for the closed allowlist', () => {
  const layers: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      // includeCoAuthoredBy (editable) + a NON-editable key + a secret key.
      settings: {
        includeCoAuthoredBy: false,
        effortLevel: 'low',
        apiKey: 'sk-live-DEADBEEF',
        model: 'opus',
      },
    },
    {
      source: 'projectSettings',
      origin: '/repo/.cat-code/settings.json',
      // effortLevel set higher-precedence than user → project wins.
      settings: { effortLevel: 'high' },
    },
  ]
  const snapshot = buildSettingsSnapshot(layers, null)
  const byKey = new Map(snapshot.editableValues.map(e => [e.key, e]))

  // Editable keys ride with their winning value + source.
  expect(byKey.get('includeCoAuthoredBy')).toEqual({
    key: 'includeCoAuthoredBy',
    value: false,
    source: 'userSettings',
  })
  expect(byKey.get('effortLevel')).toEqual({
    key: 'effortLevel',
    value: 'high',
    source: 'projectSettings',
  })
  // NON-editable / secret keys are NEVER in editableValues (only the allowlist).
  expect(byKey.has('model')).toBe(false)
  expect(byKey.has('apiKey')).toBe(false)
  // And no secret value serializes anywhere on the frame.
  expect(JSON.stringify(snapshot)).not.toContain('sk-live')
})

test('editableValues drops a mistyped on-disk value (never emits a bad shape)', () => {
  const layers: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      // A boolean key hand-edited to a string, and an int key set out of range.
      settings: { includeCoAuthoredBy: 'yes', cleanupPeriodDays: -5 },
    },
  ]
  const snapshot = buildSettingsSnapshot(layers, null)
  expect(snapshot.editableValues).toEqual([])
})

/* ── P4-19 the write path (SettingsUpdater-under-lock) ──────────────────────── */

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let scratch: string | null = null

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  resetSettingsCache()
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = null
  }
})

/** Point userSettings at an isolated temp config home for a write test. */
function useTempConfigHome(): string {
  scratch = mkdtempSync(join(tmpdir(), 'p4-19-settings-'))
  process.env.CLAUDE_CONFIG_DIR = scratch
  resetSettingsCache()
  return join(scratch, 'settings.json')
}

const write = (
  source: EditableSettingSource,
  key: string,
  value: boolean | string | number,
): SettingsVerbMessage => ({
  type: 'settings.setValue',
  requestId: 'r-1',
  source,
  key,
  value,
})

test('runVerb persists an editable write and the re-read reflects value + provenance', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain()

  const result = domain.runVerb(write('userSettings', 'includeCoAuthoredBy', false))
  expect(result).toEqual({ ok: true, message: 'Updated includeCoAuthoredBy.', changed: true })

  // Persisted verbatim on disk.
  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  expect(onDisk.includeCoAuthoredBy).toBe(false)

  // The domain's re-read snapshot reflects the value + userSettings provenance.
  const snapshot = domain.getSnapshot()
  const value = snapshot?.editableValues.find(e => e.key === 'includeCoAuthoredBy')
  expect(value).toEqual({
    key: 'includeCoAuthoredBy',
    value: false,
    source: 'userSettings',
  })
  const resolution = snapshot?.resolved.find(r => r.key === 'includeCoAuthoredBy')
  expect(resolution).toMatchObject({ source: 'userSettings', editable: true, managed: false })
})

test('two sequential writes read-modify-write under lock — no lost update', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain()

  expect(domain.runVerb(write('userSettings', 'includeCoAuthoredBy', false)).ok).toBe(true)
  // The second write recomputes from the FRESH on-disk read (SettingsUpdater
  // form) — the first write's key must survive, not be clobbered.
  expect(domain.runVerb(write('userSettings', 'fastMode', true)).ok).toBe(true)

  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  expect(onDisk.includeCoAuthoredBy).toBe(false)
  expect(onDisk.fastMode).toBe(true)
})

test('runVerb validates enum + int values and rejects out-of-set / out-of-range', () => {
  useTempConfigHome()
  const domain = createSidecarSettingsDomain()

  expect(domain.runVerb(write('userSettings', 'effortLevel', 'high')).ok).toBe(true)
  expect(domain.runVerb(write('userSettings', 'effortLevel', 'ludicrous')).ok).toBe(false)
  expect(domain.runVerb(write('userSettings', 'cleanupPeriodDays', 30)).ok).toBe(true)
  expect(domain.runVerb(write('userSettings', 'cleanupPeriodDays', -1)).ok).toBe(false)
  expect(domain.runVerb(write('userSettings', 'cleanupPeriodDays', 1.5)).ok).toBe(false)
})

test('runVerb rejects a non-editable key, a mistyped value, and a non-editable source', () => {
  useTempConfigHome()
  const domain = createSidecarSettingsDomain()

  // Not in the allowlist.
  const unknown = domain.runVerb(write('userSettings', 'apiKey', 'sk-live-X'))
  expect(unknown.ok).toBe(false)
  expect(unknown.changed).toBe(false)

  // Boolean key, string value.
  expect(domain.runVerb(write('userSettings', 'fastMode', 'on')).ok).toBe(false)

  // Non-editable source (policy) is refused before any disk touch.
  const managed = domain.runVerb({
    type: 'settings.setValue',
    requestId: 'r',
    source: 'policySettings' as EditableSettingSource,
    key: 'fastMode',
    value: true,
  })
  expect(managed.ok).toBe(false)
  expect(managed.changed).toBe(false)
})
