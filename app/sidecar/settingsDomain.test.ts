import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSourceDisplayName,
  SETTING_SOURCES,
  type EditableSettingSource,
  type SettingSource,
} from '../../src/utils/settings/constants.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import { SOURCE_LABEL } from '../renderer/src/settingsFieldModel.js'
import { SETTING_SOURCE_PRECEDENCE } from '../renderer/src/settingsState.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { SETTINGS_ENGINE_DEFAULT } from '../shared/settingsEditable.js'
import type {
  SettingsSnapshotFrame,
  SettingSourceId,
  SettingsVerbMessage,
} from '../shared/protocol.js'
import {
  buildSettingsSnapshot,
  createSidecarSettingsDomain,
  loadAvailableSettingOptions,
  type AvailableSettingOptions,
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

test('editableValues carries EVERY layer that sets an allowlisted key, winner first', () => {
  const layers: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      // includeCoAuthoredBy (editable) + a NON-editable key + a secret key +
      // effortLevel, which is a real schema key deliberately OUTSIDE the
      // allowlist (it is model-dependent; see settingsEditable.ts).
      settings: {
        includeCoAuthoredBy: false,
        reasoningDisplay: 'off',
        effortLevel: 'low',
        apiKey: 'sk-live-DEADBEEF',
        model: 'opus',
      },
    },
    {
      source: 'projectSettings',
      origin: '/repo/.cat-code/settings.json',
      // reasoningDisplay set higher-precedence than user → project wins.
      settings: { reasoningDisplay: 'raw' },
    },
  ]
  const snapshot = buildSettingsSnapshot(layers, null)
  const entriesFor = (key: string) =>
    snapshot.editableValues.filter(entry => entry.key === key)

  // A key only one layer sets rides once, with that layer's value + source.
  expect(entriesFor('includeCoAuthoredBy')).toEqual([
    { key: 'includeCoAuthoredBy', value: false, source: 'userSettings' },
  ])
  // The settings UI is scope-relative: a key set at TWO layers must carry both,
  // or the losing layer's row has no value to show at its own scope and loses
  // its editor. The winner stays FIRST, so the renderer's key-only lookup keeps
  // resolving to the resolved value.
  expect(entriesFor('reasoningDisplay')).toEqual([
    { key: 'reasoningDisplay', value: 'raw', source: 'projectSettings' },
    { key: 'reasoningDisplay', value: 'off', source: 'userSettings' },
  ])
  // `resolved` is unaffected: it still answers "which layer WINS this key", once.
  expect(
    snapshot.resolved.filter(entry => entry.key === 'reasoningDisplay'),
  ).toEqual([
    {
      key: 'reasoningDisplay',
      source: 'projectSettings',
      managed: false,
      editable: true,
    },
  ])
  // NON-editable / secret keys are NEVER in editableValues (only the allowlist).
  const byKey = new Map(snapshot.editableValues.map(e => [e.key, e]))
  expect(byKey.has('apiKey')).toBe(false)
  // `model` joined the allowlist with the default-model select (P4-34), so it
  // rides with its layer's real value — it is a preference, not a credential.
  expect(byKey.get('model')).toEqual({
    key: 'model',
    value: 'opus',
    source: 'userSettings',
  })
  // A key dropped FROM the allowlist stops crossing the wire entirely, even
  // though the layer above still sets it.
  expect(byKey.has('effortLevel')).toBe(false)
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

  expect(domain.runVerb(write('userSettings', 'reasoningDisplay', 'raw')).ok).toBe(true)
  expect(domain.runVerb(write('userSettings', 'reasoningDisplay', 'ludicrous')).ok).toBe(false)
  // Off the allowlist: rejected on the key, before any value check.
  expect(domain.runVerb(write('userSettings', 'effortLevel', 'high')).ok).toBe(false)
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

/* ── P4-19 dynamic-enum (output style) — availableOptions read-seam ──────────── */

const OUTPUT_STYLE_OPTIONS: AvailableSettingOptions = [
  {
    key: 'outputStyle',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'Explanatory', label: 'Explanatory', description: 'Explains choices' },
    ],
  },
]

test('buildSettingsSnapshot carries availableOptions through (default [])', () => {
  expect(buildSettingsSnapshot([], null).availableOptions).toEqual([])
  const snapshot = buildSettingsSnapshot([], null, OUTPUT_STYLE_OPTIONS)
  expect(snapshot.availableOptions).toEqual(OUTPUT_STYLE_OPTIONS)
})

test('a dynamic-enum write is membership-checked against the captured options', () => {
  useTempConfigHome()
  const domain = createSidecarSettingsDomain(OUTPUT_STYLE_OPTIONS)

  // In the captured live set → accepted.
  expect(domain.runVerb(write('userSettings', 'outputStyle', 'Explanatory')).ok).toBe(
    true,
  )
  // Not in the set → rejected at the closed gate, never written.
  const bad = domain.runVerb(write('userSettings', 'outputStyle', 'Nope'))
  expect(bad.ok).toBe(false)
  expect(bad.changed).toBe(false)
})

test('a dynamic-enum write fails closed when no options were captured', () => {
  useTempConfigHome()
  // Domain built WITHOUT options (e.g. the registry read failed at spawn).
  const domain = createSidecarSettingsDomain()
  const result = domain.runVerb(write('userSettings', 'outputStyle', 'default'))
  expect(result.ok).toBe(false)
  expect(result.changed).toBe(false)
})

test('runVerb persists an output-style write and the re-read reflects value + provenance', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain(OUTPUT_STYLE_OPTIONS)

  expect(domain.runVerb(write('userSettings', 'outputStyle', 'Explanatory')).ok).toBe(
    true,
  )
  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  expect(onDisk.outputStyle).toBe('Explanatory')

  const snapshot = domain.getSnapshot()
  const value = snapshot?.editableValues.find(e => e.key === 'outputStyle')
  expect(value).toEqual({
    key: 'outputStyle',
    value: 'Explanatory',
    source: 'userSettings',
  })
})

/* ── default-model select + the engine-default token (P4-34) ──────────────── */

const MODEL_OPTIONS: AvailableSettingOptions = [
  {
    key: 'model',
    options: [
      { value: SETTINGS_ENGINE_DEFAULT, label: 'Default (recommended)' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
  },
]

test('a model write persists the chosen model id', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain(MODEL_OPTIONS)

  expect(domain.runVerb(write('userSettings', 'model', 'opus')).ok).toBe(true)
  expect(JSON.parse(readFileSync(settingsFile, 'utf8')).model).toBe('opus')
})

test('choosing the engine default REMOVES the key rather than writing the token', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain(MODEL_OPTIONS)

  expect(domain.runVerb(write('userSettings', 'model', 'opus')).ok).toBe(true)
  const result = domain.runVerb(
    write('userSettings', 'model', SETTINGS_ENGINE_DEFAULT),
  )
  expect(result).toEqual({
    ok: true,
    message: 'Cleared model.',
    changed: true,
  })

  // The override is GONE — not the token, not an empty string. A settings file
  // holding the token would be a model id no engine knows.
  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  expect('model' in onDisk).toBe(false)
  expect(readFileSync(settingsFile, 'utf8')).not.toContain(
    SETTINGS_ENGINE_DEFAULT,
  )
  expect(
    domain.getSnapshot()?.editableValues.some(e => e.key === 'model'),
  ).toBe(false)
})

test('clearing one key leaves the other keys in the same file alone', () => {
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain(MODEL_OPTIONS)

  expect(domain.runVerb(write('userSettings', 'model', 'sonnet')).ok).toBe(true)
  expect(
    domain.runVerb(write('userSettings', 'includeCoAuthoredBy', false)).ok,
  ).toBe(true)
  expect(
    domain.runVerb(write('userSettings', 'model', SETTINGS_ENGINE_DEFAULT)).ok,
  ).toBe(true)

  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  expect('model' in onDisk).toBe(false)
  expect(onDisk.includeCoAuthoredBy).toBe(false)
})

test('the engine-default token is still membership-gated, like any other option', () => {
  useTempConfigHome()
  // A domain whose captured model options do NOT offer the token (e.g. a
  // registry that reported only concrete ids) must refuse to clear.
  const domain = createSidecarSettingsDomain([
    { key: 'model', options: [{ value: 'opus', label: 'Opus' }] },
  ])
  const result = domain.runVerb(
    write('userSettings', 'model', SETTINGS_ENGINE_DEFAULT),
  )
  expect(result.ok).toBe(false)
  expect(result.changed).toBe(false)
  // The message reaches a toast, so it must not echo the reserved token back at
  // the user as if it were a model name (CLAUDE.md §7).
  expect(result.message).not.toContain(SETTINGS_ENGINE_DEFAULT)
})

test('availableOptions carries no secret material (secretGuard-clean)', () => {
  const frame: SettingsSnapshotFrame = {
    kind: 'settings.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    settings: buildSettingsSnapshot([], null, OUTPUT_STYLE_OPTIONS),
  }
  // The new field passes the same outbound guard as every other snapshot field:
  // it carries only option names + short descriptions, never a credential.
  const scan = scanForSecrets(frame)
  expect(scan.ok).toBe(true)
  // Option values ride as data on the frame.
  expect(JSON.stringify(frame)).toContain('Explanatory')
})

test('loadAvailableSettingOptions reads the REAL output-style registry (live path)', async () => {
  // Live path — not a fixture: this exercises the engine's own
  // `getAllOutputStyles`, the SAME registry the running engine resolves
  // `settings.outputStyle` from (outputStyles.ts:183-213).
  const available = await loadAvailableSettingOptions(process.cwd())
  const bucket = available.find(entry => entry.key === 'outputStyle')
  expect(bucket).toBeDefined()
  const values = new Set(bucket!.options.map(option => option.value))
  // The three engine built-ins are always present (outputStyles.ts:43-137).
  expect(values.has('default')).toBe(true)
  expect(values.has('Explanatory')).toBe(true)
  expect(values.has('Learning')).toBe(true)
  // 'default' is labeled "Default" (Settings.jsx:364 parity).
  expect(bucket!.options.find(option => option.value === 'default')?.label).toBe(
    'Default',
  )
})

/* ── CC-13 `permissions.defaultMode` — the settings-backed default mode ────── */

test('CC-13: permissionDefaultMode resolves to the highest-precedence layer that sets it', () => {
  const layers: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      settings: { permissions: { defaultMode: 'plan' } },
    },
    {
      source: 'localSettings',
      origin: '/repo/.cat-code/settings.local.json',
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    },
  ]
  expect(buildSettingsSnapshot(layers, null).permissionDefaultMode).toEqual({
    value: 'acceptEdits',
    source: 'localSettings',
  })
})

test('CC-13: a higher layer touching `permissions` does NOT hide a lower defaultMode', () => {
  // The engine deep-merges settings (mergeWith + settingsMergeCustomizer,
  // settings.ts:848), so a nested scalar is overridden per-key. A layer that
  // sets only `permissions.allow` must not shadow a lower layer's defaultMode —
  // which is exactly what resolving this on the top-level `seen` set would do.
  const layers: SettingsSourceLayer[] = [
    {
      source: 'userSettings',
      origin: '/home/u/.cat-code/settings.json',
      settings: { permissions: { defaultMode: 'plan' } },
    },
    {
      source: 'policySettings',
      origin: '/Library/Managed/managed-settings.json',
      settings: { permissions: { allow: ['Bash(ls)'] } },
    },
  ]
  const snapshot = buildSettingsSnapshot(layers, 'file')
  expect(snapshot.permissionDefaultMode).toEqual({
    value: 'plan',
    source: 'userSettings',
  })
  // The top-level `permissions` key still resolves to the policy layer — the two
  // axes are independent, and that is the point.
  expect(
    snapshot.resolved.find(entry => entry.key === 'permissions')?.source,
  ).toBe('policySettings')
})

test('CC-13: permissionDefaultMode is ABSENT when unset, or shaped wrong on disk', () => {
  // Unset everywhere → the field is omitted (renderer shows "not set").
  expect(buildSettingsSnapshot(LAYERS, 'file').permissionDefaultMode).toBeUndefined()
  // `permissions` present but without defaultMode.
  expect(
    buildSettingsSnapshot(
      [
        {
          source: 'userSettings',
          origin: '/home/u/.cat-code/settings.json',
          settings: { permissions: { allow: ['Read'] } },
        },
      ],
      null,
    ).permissionDefaultMode,
  ).toBeUndefined()
  // Hand-edited to a non-string / empty string → never emitted as a bad shape.
  for (const bad of [42, null, '', { nested: true }]) {
    expect(
      buildSettingsSnapshot(
        [
          {
            source: 'userSettings',
            origin: '/home/u/.cat-code/settings.json',
            settings: { permissions: { defaultMode: bad } },
          },
        ],
        null,
      ).permissionDefaultMode,
    ).toBeUndefined()
  }
})

test('CC-13: permissionDefaultMode is read-only — it is NOT in the write allowlist', () => {
  // T6b / PERMISSION-BOUNDARY.md §3: the renderer must not be able to author a
  // permission mode. Surfacing the default for DISPLAY must not open a write.
  const settingsFile = useTempConfigHome()
  const domain = createSidecarSettingsDomain()
  const result = domain.runVerb(
    write('userSettings' as EditableSettingSource, 'permissions.defaultMode', 'bypassPermissions'),
  )
  expect(result.ok).toBe(false)
  expect(result.changed).toBe(false)
  expect(result.message).toContain('not an editable setting')
  expect(() => readFileSync(settingsFile, 'utf8')).toThrow()
})

test('CC-13: the LIVE path reads permissions.defaultMode through the engine reader', () => {
  // Not a fixture: a real settings.json read by the engine's own
  // `getSettingsForSource` inside `createSidecarSettingsDomain`.
  const settingsFile = useTempConfigHome()
  writeFileSync(
    settingsFile,
    JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
  )
  resetSettingsCache()

  const snapshot = createSidecarSettingsDomain().getSnapshot()
  expect(snapshot?.permissionDefaultMode).toEqual({
    value: 'acceptEdits',
    source: 'userSettings',
  })
  // Still carries no secret material.
  expect(scanForSecrets(snapshot).ok).toBe(true)
})
