import { describe, expect, test } from 'bun:test'
import type {
  DiagnosticsSnapshot,
  PermissionContextSnapshot,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import {
  buildSessionInspectorState,
  DIRECTORY_SOURCE_AMBIGUITY_NOTE,
  INSPECTOR_SEAM_UNREAD_NOTE,
  selectEffectiveSettingRows,
  selectFlagLayer,
  selectRunControls,
  selectSeamState,
  selectSessionDirectories,
  selectSettingsLayerViews,
  selectValuedSettingCount,
} from './sessionInspectorState.js'

const settings: SettingsSnapshot = {
  // Deliberately in the snapshot's ASCENDING order — the selector must reverse it.
  layers: [
    { source: 'userSettings', origin: '/home/me/.cat-code/settings.json', keys: ['model', 'theme'] },
    { source: 'projectSettings', origin: '/repo/.cat-code/settings.json', keys: ['theme'] },
    { source: 'flagSettings', origin: '/tmp/flag-settings.json', keys: ['verbose'] },
    { source: 'policySettings', origin: '/Library/managed.json', keys: ['autoUpdates'] },
  ],
  resolved: [
    { key: 'theme', source: 'projectSettings', editable: true, managed: false },
    { key: 'autoUpdates', source: 'policySettings', editable: false, managed: true },
    { key: 'model', source: 'userSettings', editable: true, managed: false },
    { key: 'verbose', source: 'flagSettings', editable: false, managed: false },
  ],
  policyOrigin: 'plist',
  editableValues: [
    { key: 'theme', value: 'dark', source: 'projectSettings' },
    { key: 'model', value: 'gpt-5.6-luna', source: 'userSettings' },
  ],
}

const permissionContext: PermissionContextSnapshot = {
  mode: 'acceptEdits',
  alwaysAllowRules: { userSettings: ['Bash(ls:*)'] },
  alwaysDenyRules: {},
  alwaysAskRules: {},
  ruleMetadata: [
    { behavior: 'allow', source: 'userSettings', rule: 'Bash(ls:*)', matchType: 'prefix' },
  ],
  managedRulesOnly: false,
  permissionClassifierEnabled: true,
  additionalWorkingDirectories: [
    { path: '/repo/docs', source: 'cliArg' },
    { path: '/repo/vendor', source: 'cliArg' },
    { path: '/scratch', source: 'session' },
  ],
  isBypassPermissionsModeAvailable: false,
}

const diagnostics: DiagnosticsSnapshot = {
  version: '1.2.3',
  mainLoopModel: 'gpt-5.6-luna',
  mainLoopModelForSession: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  fastMode: false,
  sandboxEnabled: true,
  installationWarnings: [],
  healthWarnings: ['auto-update is disabled'],
  memoryWarnings: [],
}

describe('selectSeamState', () => {
  test('separates an unwired drawer from a wired one with nothing to show', () => {
    expect(selectSeamState(undefined, state => state.settings)).toBe('unwired')

    const wired = buildSessionInspectorState({
      cwd: '/repo',
      settings: null,
      permissionContext: null,
      workspaceTrust: null,
      diagnostics: null,
    })
    expect(selectSeamState(wired, state => state.settings)).toBe('unread')
    expect(selectSeamState(wired, state => state.diagnostics)).toBe('unread')
  })

  test('a present snapshot reads, per seam independently', () => {
    const bundle = buildSessionInspectorState({
      cwd: null,
      settings,
      permissionContext: null,
      workspaceTrust: null,
      diagnostics,
    })
    expect(selectSeamState(bundle, state => state.settings)).toBe('read')
    expect(selectSeamState(bundle, state => state.diagnostics)).toBe('read')
    // A null sibling must NOT be dragged to `read` by its neighbours.
    expect(selectSeamState(bundle, state => state.permissionContext)).toBe('unread')
  })

  test('a null cwd is a read answer, not an unwired one', () => {
    const bundle = buildSessionInspectorState({
      cwd: null,
      settings: null,
      permissionContext: null,
      workspaceTrust: null,
      diagnostics: null,
    })
    // The bundle exists, so the drawer HAS been told about the cwd — the answer
    // is simply "the roster records none". Only `undefined` is unwired.
    expect(selectSeamState(bundle, state => state.cwd)).toBe('unread')
    expect(selectSeamState(undefined, state => state.cwd)).toBe('unwired')
  })

  test('every unread note names a different seam', () => {
    const notes = Object.values(INSPECTOR_SEAM_UNREAD_NOTE)
    expect(new Set(notes).size).toBe(notes.length)
    // None may promise something is coming — these snapshots arrive once, at
    // attach, so a dead session will never produce one.
    for (const note of notes) expect(note).not.toContain('Waiting')
  })
})

describe('selectSettingsLayerViews', () => {
  test('orders layers highest-precedence first and carries each origin + key count', () => {
    expect(selectSettingsLayerViews(settings)).toEqual([
      { source: 'policySettings', origin: '/Library/managed.json', keyCount: 1 },
      { source: 'flagSettings', origin: '/tmp/flag-settings.json', keyCount: 1 },
      { source: 'projectSettings', origin: '/repo/.cat-code/settings.json', keyCount: 1 },
      { source: 'userSettings', origin: '/home/me/.cat-code/settings.json', keyCount: 2 },
    ])
  })

  test('an unread snapshot yields no layers to render', () => {
    expect(selectSettingsLayerViews(null)).toEqual([])
  })
})

describe('selectEffectiveSettingRows', () => {
  test('sorts by key and attaches a value only where the seam carries one', () => {
    const rows = selectEffectiveSettingRows(settings)
    expect(rows.map(row => row.key)).toEqual([
      'autoUpdates',
      'model',
      'theme',
      'verbose',
    ])
    expect(rows.map(row => row.value)).toEqual([null, 'gpt-5.6-luna', 'dark', null])
    // The winning layer rides through untouched — the renderer badges it.
    expect(rows.map(row => row.source)).toEqual([
      'policySettings',
      'userSettings',
      'projectSettings',
      'flagSettings',
    ])
    expect(rows.find(row => row.key === 'autoUpdates')?.managed).toBe(true)
    expect(rows.find(row => row.key === 'verbose')?.editable).toBe(false)
  })

  test('counts only the keys whose value is really known', () => {
    expect(selectValuedSettingCount(selectEffectiveSettingRows(settings))).toBe(2)
    expect(selectValuedSettingCount([])).toBe(0)
  })

  test('tolerates a snapshot that predates editableValues', () => {
    const older: SettingsSnapshot = {
      ...settings,
      editableValues: [],
    }
    expect(selectEffectiveSettingRows(older).every(row => row.value === null)).toBe(
      true,
    )
  })
})

describe('selectFlagLayer', () => {
  test('reports the flag file, its keys, and only the keys it actually wins', () => {
    const flags = selectFlagLayer(settings)
    expect(flags).not.toBeNull()
    expect(flags?.origin).toBe('/tmp/flag-settings.json')
    expect(flags?.keys).toEqual(['verbose'])
    expect(flags?.winningKeys).toEqual(['verbose'])
  })

  test('a key the flag layer sets but loses is not reported as won', () => {
    const outranked: SettingsSnapshot = {
      ...settings,
      layers: settings.layers.map(layer =>
        layer.source === 'flagSettings'
          ? { ...layer, keys: ['verbose', 'autoUpdates'] }
          : layer,
      ),
    }
    const flags = selectFlagLayer(outranked)
    expect(flags?.keys).toEqual(['verbose', 'autoUpdates'])
    // `autoUpdates` resolves at the policy layer, so the flag layer loses it.
    expect(flags?.winningKeys).toEqual(['verbose'])
  })

  test('no flag layer is null, not an empty layer', () => {
    const noFlags: SettingsSnapshot = {
      ...settings,
      layers: settings.layers.filter(layer => layer.source !== 'flagSettings'),
    }
    expect(selectFlagLayer(noFlags)).toBeNull()
    expect(selectFlagLayer(null)).toBeNull()
  })
})

describe('selectRunControls', () => {
  test('carries the override and the resolved model as separate facts', () => {
    expect(selectRunControls(diagnostics)).toEqual({
      modelOverride: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-luna',
      effort: 'low',
      fastMode: false,
    })
  })

  test('an absent override stays null rather than borrowing the resolved model', () => {
    const noOverride = selectRunControls({
      ...diagnostics,
      mainLoopModel: null,
      mainLoopModelForSession: 'claude-opus-5',
      reasoningEffort: null,
    })
    expect(noOverride?.modelOverride).toBeNull()
    expect(noOverride?.resolvedModel).toBe('claude-opus-5')
    expect(noOverride?.effort).toBeNull()
  })

  test('no diagnostics snapshot yields nothing to state', () => {
    expect(selectRunControls(null)).toBeNull()
  })
})

describe('selectSessionDirectories', () => {
  test('counts per engine source tag and flags the cliArg ambiguity', () => {
    const view = selectSessionDirectories(permissionContext)
    expect(view.total).toBe(3)
    expect(view.groups).toEqual([
      { source: 'cliArg', count: 2 },
      { source: 'session', count: 1 },
    ])
    expect(view.cliArgAmbiguous).toBe(true)
  })

  test('no cliArg entry means no ambiguity claim is made', () => {
    const view = selectSessionDirectories({
      ...permissionContext,
      additionalWorkingDirectories: [{ path: '/scratch', source: 'session' }],
    })
    expect(view.cliArgAmbiguous).toBe(false)
    expect(view.groups).toEqual([{ source: 'session', count: 1 }])
  })

  test('an unread context is empty and claims no ambiguity', () => {
    const view = selectSessionDirectories(null)
    expect(view.total).toBe(0)
    expect(view.groups).toEqual([])
    expect(view.cliArgAmbiguous).toBe(false)
  })

  test('the ambiguity note cites the engine line that causes it', () => {
    expect(DIRECTORY_SOURCE_AMBIGUITY_NOTE).toContain(
      'src/utils/permissions/permissionSetup.ts:1015-1035',
    )
  })
})
