/**
 * The Settings surface's decisions, tested where they live.
 *
 * The renderer suite is SSR-only (`renderToStaticMarkup`), so nothing here can
 * click a scope tab or a project picker. That is exactly why the scope model,
 * the rail, and the row grammar are pure functions: the branch a click would
 * reach is reachable by a call.
 *
 * The assertions below are written to fail when the logic is wrong rather than
 * when a string moves — the caution from this file's own history is that
 * `expect(html).toContain('disabled')` once passed with the guard deleted.
 */

import { describe, expect, test } from 'bun:test'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import {
  EDITABLE_SETTING_KEYS,
  validateEditableSettingValue,
  validateEditableSettingWrite,
} from '../../shared/settingsEditable.js'
import {
  SETTINGS_SCOPE_KINDS,
  selectPermissionDefaultModeRow,
  selectProjectEngine,
  selectSettingsDestructiveChoice,
  selectSettingsDestructiveWarning,
  selectSettingsIntCommit,
  selectSettingsProjects,
  selectSettingsRail,
  selectSettingsRailItem,
  selectSettingsReset,
  selectSettingsRow,
  selectSettingsWriteLayer,
  settingsIntCancelDraft,
  settingsRailItem,
  settingsRowCommitsUnchanged,
  settingsRowNote,
  settingsWriteTargetNote,
} from './settingsScope.js'
import {
  SETTINGS_UNREAD_WITH_SESSION_NOTE,
  settingsUnreadNote,
} from './settingsReadState.js'

const USER_FILE = '/Users/pt/.cat-code/settings.json'
const PROJECT_FILE = '/repo/.cat-code/settings.json'
const LOCAL_FILE = '/repo/.cat-code/settings.local.json'
const POLICY_FILE = '/Library/Managed/managed-settings.json'

function snapshot(partial: Partial<SettingsSnapshot>): SettingsSnapshot {
  return {
    layers: [],
    resolved: [],
    policyOrigin: null,
    editableValues: [],
    ...partial,
  }
}

/* ── Law 3: the scope decides the write target ────────────────────────────── */

describe('Law 3 — the chosen scope decides the write target', () => {
  test('each scope writes exactly one layer, and two write no file at all', () => {
    expect(selectSettingsWriteLayer('user', 'projectSettings')).toBe(
      'userSettings',
    )
    expect(selectSettingsWriteLayer('project', 'projectSettings')).toBe(
      'projectSettings',
    )
    expect(selectSettingsWriteLayer('project', 'localSettings')).toBe(
      'localSettings',
    )
    expect(selectSettingsWriteLayer('app', 'projectSettings')).toBeNull()
    expect(selectSettingsWriteLayer('enforced', 'projectSettings')).toBeNull()
  })

  /**
   * The deleted behavior, pinned so it cannot come back: `targetSourceFor` sent
   * the write to whichever layer the key already resolved at, so editing a
   * co-author toggle that a project had overridden silently rewrote THAT
   * project's file. Here the value resolves at the project layer and the scope
   * is My defaults — the write target must be the user file regardless.
   */
  test('a value overridden by a project still writes the USER file in My defaults', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['fastMode'],
          },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: true, source: 'projectSettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    // The value resolves at the project layer…
    expect(row.annotation).toEqual({
      kind: 'overridden',
      by: 'projectSettings',
      origin: PROJECT_FILE,
    })
    // …and yet nothing about this row points a write at that file. The old
    // behavior would have produced 'projectSettings' here.
    expect(row.writeTarget).not.toBe('projectSettings')
    // The user file DOES set this key, and the snapshot carries only the
    // winner's value, so this scope's own value is stated as unknown rather
    // than borrowed from the project.
    expect(row.read).toEqual({
      kind: 'unreadable',
      by: 'projectSettings',
      origin: PROJECT_FILE,
    })
    // The row is still WRITABLE, at the user file. It used to be null here, and
    // that is the trap the transition test below drives.
    expect(row.writeTarget).toBe('userSettings')
  })

  /**
   * The step BETWEEN the two tests around this one, which nothing drove before.
   *
   * Both endpoints were asserted in isolation — "not set here, writable" above
   * and "set here but overridden" before it — while the move from the first to
   * the second is made by the operator's own edit, and that is what broke.
   * Scope = My defaults, the project sets `respectGitignore`, the user file does
   * not: the row renders enabled, the operator flips it, the write lands in the
   * user file, and the next snapshot has the user layer defining the key too.
   * With `writeTarget` blanked at that point, the control the operator had just
   * used was gone and the row could never be changed from the app again.
   *
   * SSR-only limit, stated rather than glossed: this drives the SELECTOR across
   * the two snapshots, not the DOM. It proves the model no longer strands the
   * row. It cannot prove a rendered control survives the round trip, which needs
   * a real click on a real toggle.
   */
  test('writing an overridden row leaves it writable on the next snapshot', () => {
    const projectLayer = {
      source: 'projectSettings' as const,
      origin: PROJECT_FILE,
      keys: ['respectGitignore'],
    }
    const resolved = [
      {
        key: 'respectGitignore',
        source: 'projectSettings' as const,
        editable: true,
        managed: false,
      },
    ]

    // Before the edit: the user file does not set the key.
    const before = selectSettingsRow({
      snapshot: snapshot({
        layers: [projectLayer],
        resolved,
        editableValues: [
          { key: 'respectGitignore', value: true, source: 'projectSettings' },
        ],
      }),
      key: 'respectGitignore',
      layer: 'userSettings',
    })
    expect(before.read).toEqual({ kind: 'unset' })
    expect(before.writeTarget).toBe('userSettings')

    // After the edit: the user file now sets it too, and the project still wins.
    const after = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: USER_FILE,
            keys: ['respectGitignore'],
          },
          projectLayer,
        ],
        resolved,
        editableValues: [
          { key: 'respectGitignore', value: true, source: 'projectSettings' },
        ],
      }),
      key: 'respectGitignore',
      layer: 'userSettings',
    })
    expect(after.annotation.kind).toBe('overridden')
    expect(after.writeTarget).toBe('userSettings')
  })

  /**
   * The other half of the same repair, and the contract the snapshot must meet
   * for the operator to SEE their own value again.
   *
   * The row above is writable but still reads as unknown, because the snapshot
   * carries a value only for the layer that won. Once it also carries this
   * layer's own entry, the row reads that value and renders a live control at
   * the operator's real setting instead of the word "unknown".
   */
  test("an overridden row reads its own layer's value when the snapshot carries one", () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: USER_FILE,
            keys: ['respectGitignore'],
          },
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['respectGitignore'],
          },
        ],
        resolved: [
          {
            key: 'respectGitignore',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'respectGitignore', value: true, source: 'projectSettings' },
          { key: 'respectGitignore', value: false, source: 'userSettings' },
        ],
      }),
      key: 'respectGitignore',
      layer: 'userSettings',
    })
    // The user's OWN value, never the project's.
    expect(row.read).toEqual({
      kind: 'set',
      value: false,
      source: 'userSettings',
    })
    expect(row.writeTarget).toBe('userSettings')
    // The annotation still says the project wins, so the row is not pretending
    // the user's value is in effect.
    expect(row.annotation.kind).toBe('overridden')
  })

  /**
   * The same snapshot now carries an entry PER LAYER, so every read that is not
   * scope-specific must still land on the winner. A lower layer's value must
   * never be picked up by the inherited branch just because it sorts later.
   */
  test('a key carried at several layers still resolves to the winner elsewhere', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          { source: 'projectSettings', origin: PROJECT_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        // Winner first, matching the high→low walk that builds this list.
        editableValues: [
          { key: 'fastMode', value: true, source: 'projectSettings' },
          { key: 'fastMode', value: false, source: 'userSettings' },
        ],
      }),
      key: 'fastMode',
      // Reading from a layer BELOW the winner: the value shown is the one in
      // force, not this layer's own.
      layer: 'localSettings',
    })
    expect(row.annotation.kind).toBe('inherited')
    expect(row.read).toEqual({
      kind: 'set',
      value: true,
      source: 'projectSettings',
    })
  })

  test('an overridden key the user file does NOT set stays writable, at the user file', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['fastMode'],
          },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: true, source: 'projectSettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    // Nothing of ours is hidden: our layer simply does not set it, so the row
    // shows the built-in default and an edit lands in the user file.
    expect(row.read).toEqual({ kind: 'unset' })
    expect(row.writeTarget).toBe('userSettings')
    expect(row.annotation.kind).toBe('overridden')
  })
})

/* ── the row grammar ──────────────────────────────────────────────────────── */

describe('row grammar', () => {
  test('a key set at this layer reads its value and annotates "set here"', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['effortLevel'] },
        ],
        resolved: [
          {
            key: 'effortLevel',
            source: 'userSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'effortLevel', value: 'high', source: 'userSettings' },
        ],
      }),
      key: 'effortLevel',
      layer: 'userSettings',
    })
    expect(row.read).toEqual({
      kind: 'set',
      value: 'high',
      source: 'userSettings',
    })
    expect(row.annotation).toEqual({ kind: 'set-here', origin: USER_FILE })
    expect(row.writeTarget).toBe('userSettings')
  })

  test('a project scope inherits the user value, and editing it is an override', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['effortLevel'] },
        ],
        resolved: [
          {
            key: 'effortLevel',
            source: 'userSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'effortLevel', value: 'high', source: 'userSettings' },
        ],
      }),
      key: 'effortLevel',
      layer: 'projectSettings',
    })
    // The project resolves to the user's value — so it is shown, not hidden…
    expect(row.read).toEqual({
      kind: 'set',
      value: 'high',
      source: 'userSettings',
    })
    // …labelled as inherited, and an edit writes the PROJECT file.
    expect(row.annotation).toEqual({
      kind: 'inherited',
      from: 'userSettings',
      origin: USER_FILE,
    })
    expect(row.writeTarget).toBe('projectSettings')
  })

  test('local beats project, so the shared layer sees an override it cannot read', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['effortLevel'],
          },
          {
            source: 'localSettings',
            origin: LOCAL_FILE,
            keys: ['effortLevel'],
          },
        ],
        resolved: [
          {
            key: 'effortLevel',
            source: 'localSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'effortLevel', value: 'low', source: 'localSettings' },
        ],
      }),
      key: 'effortLevel',
      layer: 'projectSettings',
    })
    expect(row.annotation).toEqual({
      kind: 'overridden',
      by: 'localSettings',
      origin: LOCAL_FILE,
    })
    expect(row.read.kind).toBe('unreadable')
    // …and the same snapshot read from the LOCAL layer is a plain "set here".
    const local = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['effortLevel'],
          },
          {
            source: 'localSettings',
            origin: LOCAL_FILE,
            keys: ['effortLevel'],
          },
        ],
        resolved: [
          {
            key: 'effortLevel',
            source: 'localSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'effortLevel', value: 'low', source: 'localSettings' },
        ],
      }),
      key: 'effortLevel',
      layer: 'localSettings',
    })
    expect(local.annotation.kind).toBe('set-here')
    expect(local.read).toEqual({
      kind: 'set',
      value: 'low',
      source: 'localSettings',
    })
    expect(local.writeTarget).toBe('localSettings')
  })

  test('policy outranks everything: the value shows, the write does not', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          { source: 'policySettings', origin: POLICY_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'policySettings',
            editable: false,
            managed: true,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: true, source: 'policySettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.annotation).toEqual({ kind: 'enforced', origin: POLICY_FILE })
    expect(row.read).toEqual({
      kind: 'set',
      value: true,
      source: 'policySettings',
    })
    expect(row.writeTarget).toBeNull()
  })

  test('a CLI flag on the open session reads as session state, not as a file', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'flagSettings', origin: '--settings', keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'flagSettings',
            editable: false,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: true, source: 'flagSettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.annotation.kind).toBe('overridden')
    expect(settingsRowNote(row)).toContain('command-line flag on the open session')
    // The user file does not set it, so the row is still editable.
    expect(row.writeTarget).toBe('userSettings')
  })

  test('unset everywhere is a real answer, and it is writable', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [{ source: 'userSettings', origin: USER_FILE, keys: ['other'] }],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.read).toEqual({ kind: 'unset' })
    expect(row.annotation).toEqual({ kind: 'unset-here', origin: USER_FILE })
    expect(row.writeTarget).toBe('userSettings')
    // The annotation still exists for anyone who needs it, but the row stays
    // SILENT: not-set-in-the-scope-you-chose is the ordinary case, and the page
    // already names that scope at its head.
    expect(settingsRowNote(row)).toBeNull()
  })

  /** `settingsReadState.ts` doctrine: no snapshot ⇒ nothing may be asserted. */
  test('with no snapshot nothing is read, nothing is claimed, nothing is writable', () => {
    const row = selectSettingsRow({
      snapshot: null,
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.read).toEqual({ kind: 'unread' })
    expect(row.writeTarget).toBeNull()
    // Not a "waiting…": with no session nothing is in flight.
    expect((settingsRowNote(row) ?? '').toLowerCase()).not.toContain('waiting')
  })

  /**
   * The honest v1 limit AND a correctness guard: the write verb is routed to the
   * focused session's sidecar, which writes ITS cwd's project file. A project
   * with no engine of its own must therefore neither display values nor accept
   * a write — even when a perfectly good snapshot for a DIFFERENT project is in
   * hand.
   */
  test('a project with no engine reads nothing and writes nothing, snapshot or not', () => {
    const full = snapshot({
      layers: [
        { source: 'projectSettings', origin: PROJECT_FILE, keys: ['fastMode'] },
      ],
      resolved: [
        {
          key: 'fastMode',
          source: 'projectSettings',
          editable: true,
          managed: false,
        },
      ],
      editableValues: [
        { key: 'fastMode', value: true, source: 'projectSettings' },
      ],
    })
    const row = selectSettingsRow({
      snapshot: full,
      key: 'fastMode',
      layer: 'projectSettings',
      engine: 'absent',
    })
    expect(row.read).toEqual({ kind: 'no-engine' })
    expect(row.writeTarget).toBeNull()
    // The same snapshot with a live engine is fully readable — so the block is
    // the engine gate, not an empty fixture.
    const live = selectSettingsRow({
      snapshot: full,
      key: 'fastMode',
      layer: 'projectSettings',
      engine: 'live',
    })
    expect(live.read).toEqual({
      kind: 'set',
      value: true,
      source: 'projectSettings',
    })
    expect(live.writeTarget).toBe('projectSettings')
  })

  test('the annotation carries the real settings-file path, per layer', () => {
    const note = (layer: 'userSettings' | 'projectSettings') =>
      settingsRowNote(
        selectSettingsRow({
          snapshot: snapshot({
            layers: [
              {
                source: 'userSettings',
                origin: USER_FILE,
                keys: ['effortLevel'],
              },
            ],
            resolved: [
              {
                key: 'effortLevel',
                source: 'userSettings',
                editable: true,
                managed: false,
              },
            ],
            editableValues: [
              { key: 'effortLevel', value: 'high', source: 'userSettings' },
            ],
          }),
          key: 'effortLevel',
          layer,
        }),
      )
    // Set-here in the chosen scope says nothing; the SAME key seen from another
    // scope is surprising, so THAT is where the path is spelled out.
    expect(note('userSettings')).toBeNull()
    expect(note('projectSettings')).toBe(
      `Inherited from your defaults: ${USER_FILE}`,
    )
  })

  test('an unreadable row says why, instead of showing a value it does not have', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          { source: 'localSettings', origin: LOCAL_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'localSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: false, source: 'localSettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(settingsRowNote(row)).toBe(
      `Overridden by your private settings for this project: ${LOCAL_FILE}. ` +
        'This app reads the resolved value only, so your own value here cannot be shown.',
    )
  })

  /**
   * The silence rule must not swallow a row that genuinely cannot show its
   * value. `set-here` is ordinary ONLY when the value was actually readable;
   * when it was not, the row owes the operator an explanation.
   */
  test('a set-here row that cannot be read still explains itself', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'userSettings',
            editable: true,
            managed: false,
          },
        ],
        // No editableValues entry: resolved names the key, but no value came
        // across the wire for it.
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.annotation.kind).toBe('set-here')
    expect(row.read.kind).toBe('unreadable')
    // `set-here` unreadable means the CHOSEN layer is the winner and does set
    // the key, so the reason is that its own value is outside what the
    // control allows, never the "resolved value only" limitation the other
    // unreadable annotations use — that copy told the operator the wrong
    // reason even though the row's state was right.
    expect(settingsRowNote(row)).toBe(
      `Set here: ${USER_FILE}. The saved value here doesn't fit what this ` +
        'setting allows, so it cannot be shown. Enter a new value to replace it.',
    )
  })
})

/**
 * The bug this session exists to close: three of the four `selectSettingsRow`
 * branches (`managed`, `set-here`, `inherited`) used to read a row's value
 * with a SOURCE-BLIND lookup (`.find(entry => entry.key === key)`), which
 * returns whichever layer's value happens to exist in `editableValues` — not
 * necessarily the winning layer's own value. When the sidecar's per-key
 * validator drops the winning layer's raw value (out of range, or an empty
 * string on a `dynamic-enum`), that lookup silently falls through to a lower
 * layer and the row shows a value it attributes to the wrong file, right next
 * to a badge naming the winner. The fourth branch (`overridden`) already used
 * the source-scoped `layerValue` helper and never had this bug; these tests
 * pin the other three to the same rule.
 */
describe('a row never shows a value borrowed from a layer other than the one its badge names', () => {
  test('set-here: the project wins but its own out-of-range value was dropped, so the row must not show the user file\'s number', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: USER_FILE,
            keys: ['cleanupPeriodDays'],
          },
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['cleanupPeriodDays'],
          },
        ],
        resolved: [
          {
            key: 'cleanupPeriodDays',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        // The project file's own 5000 is out of the control's [0, 3650] domain
        // and was dropped by the sidecar's validator, so only the user file's
        // (unrelated) 30 survives into editableValues.
        editableValues: [
          { key: 'cleanupPeriodDays', value: 30, source: 'userSettings' },
        ],
      }),
      key: 'cleanupPeriodDays',
      layer: 'projectSettings',
    })
    expect(row.annotation).toEqual({ kind: 'set-here', origin: PROJECT_FILE })
    // The project is both the winner and the chosen scope, but its own value
    // is unknown to this app — never the user file's 30 relabelled as the
    // project's.
    expect(row.read).toEqual({
      kind: 'unreadable',
      by: null,
      origin: PROJECT_FILE,
    })
  })

  test('managed: policy wins but its own empty-string value was dropped, so the row must not show the user file\'s pick as policy', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['outputStyle'] },
          {
            source: 'policySettings',
            origin: POLICY_FILE,
            keys: ['outputStyle'],
          },
        ],
        resolved: [
          {
            key: 'outputStyle',
            source: 'policySettings',
            editable: false,
            managed: true,
          },
        ],
        // Policy's own "" fails the dynamic-enum's non-empty check and was
        // dropped; only the user file's "explanatory" survives.
        editableValues: [
          { key: 'outputStyle', value: 'explanatory', source: 'userSettings' },
        ],
      }),
      key: 'outputStyle',
      layer: 'userSettings',
    })
    expect(row.annotation).toEqual({ kind: 'enforced', origin: POLICY_FILE })
    // Never "policy enforces explanatory" — policy's own value is unreadable.
    expect(row.read).toEqual({
      kind: 'unreadable',
      by: null,
      origin: POLICY_FILE,
    })
  })

  test('inherited: local scope has nothing to say about the key, project wins but its own empty-string value was dropped, so the row must not show the user file\'s model as the project\'s', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['model'] },
          {
            source: 'projectSettings',
            origin: PROJECT_FILE,
            keys: ['model'],
          },
        ],
        resolved: [
          {
            key: 'model',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        // The project's own "" fails the dynamic-enum's non-empty check and
        // was dropped; only the user file's "opus" survives. `localSettings`
        // does not set the key at all, so choosing it falls through to the
        // project, which is the winner but not the chosen layer: `inherited`.
        editableValues: [
          { key: 'model', value: 'opus', source: 'userSettings' },
        ],
      }),
      key: 'model',
      layer: 'localSettings',
    })
    expect(row.annotation).toEqual({
      kind: 'inherited',
      from: 'projectSettings',
      origin: PROJECT_FILE,
    })
    // Never "opus" attributed to the project. Project's own value is unknown.
    expect(row.read).toEqual({
      kind: 'unreadable',
      by: null,
      origin: PROJECT_FILE,
    })
  })
})

describe('write-target disclosure', () => {
  test('names the destination file, and says so before any edit', () => {
    expect(settingsWriteTargetNote('userSettings', USER_FILE)).toBe(
      `Edits here write to your own settings file: ${USER_FILE}`,
    )
    expect(settingsWriteTargetNote('localSettings', LOCAL_FILE)).toContain(
      LOCAL_FILE,
    )
    // Every layer gets a DIFFERENT sentence — the failure mode being avoided is
    // a note that is present but identical whatever the destination.
    const notes = new Set([
      settingsWriteTargetNote('userSettings', null),
      settingsWriteTargetNote('projectSettings', null),
      settingsWriteTargetNote('localSettings', null),
    ])
    expect(notes.size).toBe(3)
  })

  test('a layer with no file yet says so rather than naming nothing', () => {
    expect(settingsWriteTargetNote('projectSettings', null)).toContain(
      'the first edit creates it',
    )
  })
})

/* ── the permission default-mode row ──────────────────────────────────────── */

/**
 * `permissions.defaultMode` is nested, so it never appears in `resolved` and
 * cannot go through `selectSettingsRow`. It was therefore read straight off the
 * snapshot — which resolves it across ALL layers — and became the one row on a
 * scope-relative page that ignored the scope.
 */
describe('permission default mode, per scope', () => {
  const withMode = (
    value: string,
    source: SettingsSnapshot['layers'][number]['source'],
  ) =>
    snapshot({
      layers: [
        { source: 'userSettings', origin: USER_FILE, keys: [] },
        { source: 'projectSettings', origin: PROJECT_FILE, keys: [] },
        { source: 'policySettings', origin: POLICY_FILE, keys: [] },
      ],
      permissionDefaultMode: { value, source },
    })

  test("a project's default does not render as MY default", () => {
    const row = selectPermissionDefaultModeRow({
      snapshot: withMode('acceptEdits', 'projectSettings'),
      layer: 'userSettings',
    })
    // The user file's own default is genuinely unknown here, so the value the
    // project set is NOT shown under "Your own settings files".
    expect(row.read.kind).toBe('unreadable')
    expect(row.annotation).toEqual({
      kind: 'overridden',
      by: 'projectSettings',
      origin: PROJECT_FILE,
    })
    // …and the row must not claim the files hold nothing, which is what the
    // cross-scope read licensed.
    expect(row.annotation.kind).not.toBe('unset-here')

    // The same snapshot, read in the scope that DOES set it, shows the value.
    const inProject = selectPermissionDefaultModeRow({
      snapshot: withMode('acceptEdits', 'projectSettings'),
      layer: 'projectSettings',
    })
    expect(inProject.read).toEqual({
      kind: 'set',
      value: 'acceptEdits',
      source: 'projectSettings',
    })
    expect(inProject.annotation.kind).toBe('set-here')
  })

  test('a lower layer is inherited, and policy is enforced', () => {
    const inherited = selectPermissionDefaultModeRow({
      snapshot: withMode('plan', 'userSettings'),
      layer: 'projectSettings',
    })
    expect(inherited.read).toEqual({
      kind: 'set',
      value: 'plan',
      source: 'userSettings',
    })
    expect(inherited.annotation.kind).toBe('inherited')

    const managed = selectPermissionDefaultModeRow({
      snapshot: withMode('plan', 'policySettings'),
      layer: 'userSettings',
    })
    expect(managed.annotation.kind).toBe('enforced')
  })

  test('unset, unread and no-engine stay three different answers', () => {
    expect(
      selectPermissionDefaultModeRow({
        snapshot: snapshot({}),
        layer: 'userSettings',
      }).annotation.kind,
    ).toBe('unset-here')
    expect(
      selectPermissionDefaultModeRow({ snapshot: null, layer: 'userSettings' })
        .annotation.kind,
    ).toBe('unread')
    expect(
      selectPermissionDefaultModeRow({
        snapshot: snapshot({}),
        layer: 'projectSettings',
        engine: 'absent',
      }).annotation.kind,
    ).toBe('no-engine')
  })

  test('the row is never writable, in any scope', () => {
    for (const layer of ['userSettings', 'projectSettings', 'localSettings'] as const) {
      expect(
        selectPermissionDefaultModeRow({
          snapshot: withMode('plan', 'userSettings'),
          layer,
        }).writeTarget,
      ).toBeNull()
    }
  })
})

/* ── unread wording ───────────────────────────────────────────────────────── */

/**
 * A null snapshot is NOT proof that no session exists — the spawn-time read can
 * throw, the attach window has not delivered one, and a process reset clears the
 * one already held. So a running session was told "No session is open", denying
 * the tab the operator was looking at.
 */
describe('the unread sentence', () => {
  test('stops claiming no session is open when one is', () => {
    const attached = selectSettingsRow({
      snapshot: null,
      key: 'fastMode',
      layer: 'userSettings',
      sessionOpen: true,
    })
    expect(attached.read.kind).toBe('unread')
    expect(settingsRowNote(attached)).not.toContain('No session is open')
    expect(settingsRowNote(attached)).toBe(SETTINGS_UNREAD_WITH_SESSION_NOTE)

    // With nothing attached the original sentence is correct and survives.
    const detached = selectSettingsRow({
      snapshot: null,
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(settingsRowNote(detached)).toContain('No session is open')

    // The whole point is that the two differ.
    expect(settingsRowNote(attached)).not.toBe(settingsRowNote(detached))
  })

  test('neither sentence promises anything is on its way', () => {
    for (const open of [true, false]) {
      expect(settingsUnreadNote(open).toLowerCase()).not.toContain('waiting')
      expect(settingsUnreadNote(open).toLowerCase()).not.toContain('will')
    }
  })

  test('the follow-on directive is only appended where it is true', () => {
    expect(settingsUnreadNote(false, 'Open a session to read them.')).toContain(
      'Open a session to read them.',
    )
    // Telling someone to open a session while one IS open is the same false
    // claim one clause later.
    expect(settingsUnreadNote(true, 'Open a session to read them.')).not.toContain(
      'Open a session',
    )
  })
})

/* ── committing an unset row ──────────────────────────────────────────────── */

describe('an unset row can persist the value it is showing', () => {
  const unsetRow = () =>
    selectSettingsRow({
      snapshot: snapshot({}),
      key: 'cleanupPeriodDays',
      layer: 'userSettings',
    })

  test('an unset writable row commits even an unchanged value', () => {
    const row = unsetRow()
    expect(row.read).toEqual({ kind: 'unset' })
    // What it DISPLAYS is the built-in default, which no file holds — so
    // re-entering it is a real change and must be sent. The ordinary no-change
    // guard swallowed it silently, with no error and no state change.
    expect(settingsRowCommitsUnchanged(row)).toBe(true)
  })

  test('a row with a real value, or no write target, does not', () => {
    const set = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: USER_FILE,
            keys: ['cleanupPeriodDays'],
          },
        ],
        resolved: [
          {
            key: 'cleanupPeriodDays',
            source: 'userSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'cleanupPeriodDays', value: 30, source: 'userSettings' },
        ],
      }),
      key: 'cleanupPeriodDays',
      layer: 'userSettings',
    })
    expect(settingsRowCommitsUnchanged(set)).toBe(false)

    const noEngine = selectSettingsRow({
      snapshot: snapshot({}),
      key: 'cleanupPeriodDays',
      layer: 'projectSettings',
      engine: 'absent',
    })
    expect(settingsRowCommitsUnchanged(noEngine)).toBe(false)
  })
})

/* ── the rail ─────────────────────────────────────────────────────────────── */

describe('functional rail', () => {
  const labels = (scope: (typeof SETTINGS_SCOPE_KINDS)[number]) =>
    selectSettingsRail(scope, '').map(group => ({
      heading: group.heading,
      items: group.items.map(item => item.label),
    }))

  test('My defaults is functional, with Extensions as the one named group', () => {
    expect(labels('user')).toEqual([
      {
        heading: null,
        items: [
          'General',
          'Model & Reasoning',
          'Permissions',
          'Interface',
          'Privacy & Data',
          'Memory',
        ],
      },
      {
        heading: 'Extensions',
        items: ['Agents', 'Skills', 'Plugins', 'MCP', 'Hooks'],
      },
      { heading: null, items: ['Remote'] },
    ])
  })

  test('project scope drops Remote, which is machine-level durable config', () => {
    expect(labels('project').flatMap(group => group.items)).not.toContain(
      'Remote',
    )
    // …and keeps everything else, so this is a considered omission and not an
    // accidentally different rail.
    expect(labels('project')).toEqual(
      labels('user').slice(0, 2),
    )
  })

  test('This app and Enforced have their own small rails', () => {
    expect(labels('app')).toEqual([
      { heading: null, items: ['Appearance', 'Notifications'] },
    ])
    expect(labels('enforced')).toEqual([
      { heading: null, items: ['Enforced settings'] },
    ])
  })

  test('the resolver vocabulary never structures the rail again', () => {
    for (const scope of SETTINGS_SCOPE_KINDS) {
      const headings = selectSettingsRail(scope, '').map(group => group.heading)
      for (const banned of [
        'Resolved',
        'This project',
        'This machine',
        'Resolved per project',
      ]) {
        expect(headings).not.toContain(banned)
      }
    }
  })

  /**
   * The box is labelled "Search settings", and it could not find a setting.
   *
   * `item` is a rail CATEGORY, so matching `item.label` alone meant every real
   * setting name returned "No matches" — the operator typed the name printed on
   * the row they wanted and the rail emptied. Each query below is a word off an
   * actual control or an actual category description.
   */
  test('search finds SETTINGS, not only category names', () => {
    const found = (query: string) =>
      selectSettingsRail('user', query).flatMap(group =>
        group.items.map(item => item.label),
      )
    // Control labels, none of which is a category name.
    expect(found('gitignore')).toEqual(['General'])
    expect(found('output style')).toEqual(['Interface'])
    expect(found('retention')).toEqual(['Privacy & Data'])
    expect(found('thinking')).toContain('Model & Reasoning')
    expect(found('auto memory')).toEqual(['Memory'])
    expect(found('auto')).toEqual(['Memory'])
    // A word that lives only in a category's own description.
    expect(found('effort')).toEqual(['Model & Reasoning'])
    // Category names still work, and nonsense still finds nothing.
    expect(found('memory')).toContain('Memory')
    expect(found('zzz')).toEqual([])
  })

  test('search reaches every group, and empties none by halves', () => {
    expect(
      selectSettingsRail('user', 'remote').flatMap(group =>
        group.items.map(item => item.label),
      ),
    ).toEqual(['Remote'])
    // The last group is the one a broken filter silently stops reaching.
    expect(selectSettingsRail('user', 'remote')).toHaveLength(1)
    expect(
      selectSettingsRail('user', 'e').map(group => group.heading),
    ).toEqual([null, 'Extensions', null])
    expect(selectSettingsRail('user', 'zzz')).toEqual([])
  })

  test('switching scope keeps the same pane when it exists, and falls back when it does not', () => {
    expect(selectSettingsRailItem('project', 'general')).toBe('general')
    // Remote is not a project pane, so the project scope opens at its first.
    expect(selectSettingsRailItem('project', 'remote')).toBe('general')
    // A stale / unknown id can never leave the rail with nothing selected.
    expect(selectSettingsRailItem('app', 'general')).toBe('appearance')
    expect(selectSettingsRailItem('enforced', 'nonsense')).toBe('policy')
    // App's existing entry point still resolves.
    expect(selectSettingsRailItem('user', 'agents')).toBe('agents')
  })
})

/* ── the project picker ───────────────────────────────────────────────────── */

describe('project picker', () => {
  test('the focused project comes first and is flagged, never auto-selected', () => {
    const choices = selectSettingsProjects(
      [
        { cwd: '/Users/pt/other', name: 'other' },
        { cwd: '/Users/pt/cat-code', name: 'cat-code' },
      ],
      '/Users/pt/cat-code',
    )
    expect(choices.map(choice => choice.cwd)).toEqual([
      '/Users/pt/cat-code',
      '/Users/pt/other',
    ])
    expect(choices.map(choice => choice.current)).toEqual([true, false])
    // The roster's own label wins over a derived basename.
    expect(choices[0]?.name).toBe('cat-code')
  })

  test('with no roster the focused project is still offerable, labelled from its path', () => {
    const choices = selectSettingsProjects(undefined, '/Users/pt/cat-code/app')
    expect(choices).toEqual([
      { cwd: '/Users/pt/cat-code/app', name: 'app', current: true },
    ])
  })

  test('a trailing separator is not a second project', () => {
    const choices = selectSettingsProjects(
      [{ cwd: '/repo/', name: 'repo' }],
      '/repo',
    )
    expect(choices).toHaveLength(1)
    expect(choices[0]?.current).toBe(true)
  })

  test('with no session open nothing is current, and nothing is invented', () => {
    expect(selectSettingsProjects(undefined, null)).toEqual([])
    expect(
      selectSettingsProjects([{ cwd: '/repo', name: 'repo' }], null),
    ).toEqual([{ cwd: '/repo', name: 'repo', current: false }])
  })

  test('only the focused session’s project has an engine', () => {
    expect(selectProjectEngine('/repo', '/repo')).toBe('live')
    expect(selectProjectEngine('/repo/', '/repo')).toBe('live')
    expect(selectProjectEngine('/repo', '/other')).toBe('absent')
    expect(selectProjectEngine('/repo', null)).toBe('absent')
    expect(selectProjectEngine(null, '/repo')).toBe('absent')
  })
})

/* ── P4-41: what this layer may REMOVE ────────────────────────────────────── */

describe('definesHere — the precondition for removing a key', () => {
  test('true only when the CHOSEN layer carries the key, whatever wins', () => {
    const both = snapshot({
      layers: [
        { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
        { source: 'projectSettings', origin: PROJECT_FILE, keys: ['fastMode'] },
      ],
      resolved: [
        {
          key: 'fastMode',
          source: 'projectSettings',
          editable: true,
          managed: false,
        },
      ],
      editableValues: [
        { key: 'fastMode', value: true, source: 'projectSettings' },
      ],
    })
    // Overridden, but the user file DOES set it — so there is something here to
    // remove, even though this scope cannot display its own value.
    const user = selectSettingsRow({
      snapshot: both,
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(user.read.kind).toBe('unreadable')
    expect(user.definesHere).toBe(true)
    expect(selectSettingsReset(user, 'fastMode')).toEqual({
      source: 'userSettings',
      key: 'fastMode',
      value: null,
    })
    // The local layer sets nothing, so it has nothing to remove — even though
    // the row displays a value and is perfectly writable.
    const local = selectSettingsRow({
      snapshot: both,
      key: 'fastMode',
      layer: 'localSettings',
    })
    expect(local.writeTarget).toBe('localSettings')
    expect(local.definesHere).toBe(false)
    expect(selectSettingsReset(local, 'fastMode')).toBeNull()
  })

  test('an overridden row this layer does NOT set has nothing to remove', () => {
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'projectSettings', origin: PROJECT_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          {
            key: 'fastMode',
            source: 'projectSettings',
            editable: true,
            managed: false,
          },
        ],
        editableValues: [
          { key: 'fastMode', value: true, source: 'projectSettings' },
        ],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.annotation.kind).toBe('overridden')
    expect(row.read.kind).toBe('unset')
    expect(row.definesHere).toBe(false)
    expect(selectSettingsReset(row, 'fastMode')).toBeNull()
  })

  test('a flag override never makes the flag itself resettable', () => {
    // `flagSettings` outranks the user layer and is not an editable source, so
    // the reset can only ever remove the USER file's own key — which is exactly
    // the write this row already permits. It can never name the flag layer.
    const row = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          { source: 'flagSettings', origin: 'command line arguments', keys: ['fastMode'] },
        ],
        resolved: [
          { key: 'fastMode', source: 'flagSettings', editable: false, managed: false },
        ],
        editableValues: [{ key: 'fastMode', value: true, source: 'flagSettings' }],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(row.annotation).toMatchObject({ kind: 'overridden', by: 'flagSettings' })
    expect(selectSettingsReset(row, 'fastMode')?.source).toBe('userSettings')
  })

  test('policy, an unread snapshot, and a project with no engine can remove nothing', () => {
    const managed = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'userSettings', origin: USER_FILE, keys: ['fastMode'] },
          { source: 'policySettings', origin: POLICY_FILE, keys: ['fastMode'] },
        ],
        resolved: [
          { key: 'fastMode', source: 'policySettings', editable: false, managed: true },
        ],
        editableValues: [{ key: 'fastMode', value: true, source: 'policySettings' }],
      }),
      key: 'fastMode',
      layer: 'userSettings',
    })
    expect(managed.definesHere).toBe(false)
    expect(selectSettingsReset(managed, 'fastMode')).toBeNull()

    for (const row of [
      selectSettingsRow({ snapshot: null, key: 'fastMode', layer: 'userSettings' }),
      selectSettingsRow({
        snapshot: snapshot({}),
        key: 'fastMode',
        layer: 'projectSettings',
        engine: 'absent',
      }),
      selectSettingsRow({ snapshot: snapshot({}), key: 'fastMode', layer: 'userSettings' }),
    ]) {
      expect(row.definesHere).toBe(false)
      expect(selectSettingsReset(row, 'fastMode')).toBeNull()
    }
  })
})

/* ── destructive values (P4-47) ───────────────────────────────────────────── */

describe('a legal value that destroys data is gated, not typed away', () => {
  /**
   * The whole point of the declaration. `cleanupPeriodDays: 0` is a legitimate
   * member of the key's domain, so nothing in the write path can refuse it and
   * nothing should: `src/utils/sessionStorage.ts:1408` stops every transcript
   * write and `src/utils/cleanup.ts:24-31` moves the retention cutoff to now,
   * which is a real thing a person may want. It just must not happen because a
   * digit was typed and the field lost focus.
   */
  test('the destructive value asks instead of writing, on the ONE decision both triggers use', () => {
    const decision = selectSettingsIntCommit({
      key: 'cleanupPeriodDays',
      draft: '0',
      current: 30,
      commitUnchanged: false,
    })
    expect(decision.kind).toBe('confirm')
    if (decision.kind !== 'confirm') return
    expect(decision.value).toBe(0)
    expect(decision.choice.confirmLabel.length).toBeGreaterThan(0)
    // Blur and Enter both call this, so there is no second path to be a hole.
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: ' 0 ',
        current: 30,
        commitUnchanged: true,
      }).kind,
    ).toBe('confirm')
  })

  /**
   * `Number('')` and `Number('   ')` are both `0`, so clearing the field and
   * clicking away used to be indistinguishable from typing a zero: it landed
   * in `cleanupPeriodDays`' destructive gate, a "Delete every saved session?"
   * modal for a field the operator just left blank. That coupling ran
   * backwards, because the gate is declared per key while `IntField` is
   * generic over every int key — the next int setting would inherit "empty
   * means zero" with no gate at all. An emptied field is now its own outcome,
   * for every int key, gate or not.
   */
  test('an emptied or whitespace-only field is invalid, never a silent zero', () => {
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: '',
        current: 30,
        commitUnchanged: false,
      }),
    ).toEqual({ kind: 'invalid', error: 'Enter a number.' })
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: '   ',
        current: 30,
        commitUnchanged: false,
      }),
    ).toEqual({ kind: 'invalid', error: 'Enter a number.' })
  })

  test('every other value on the same key still commits with no gate at all', () => {
    // The rejected enum would have deleted exactly these.
    for (const days of ['7', '45', '365', '3650']) {
      const decision = selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: days,
        current: 30,
        commitUnchanged: false,
      })
      expect(decision).toEqual({ kind: 'write', value: Number(days) })
    }
  })

  test('the declaration belongs to the key, not to the number zero', () => {
    expect(selectSettingsDestructiveChoice('cleanupPeriodDays', 0)).not.toBeNull()
    expect(selectSettingsDestructiveChoice('cleanupPeriodDays', 30)).toBeNull()
    // A different key at the same value is an ordinary value.
    expect(selectSettingsDestructiveChoice('autoUpdatesChannel', 0)).toBeNull()
    expect(selectSettingsDestructiveChoice('notAKey', 0)).toBeNull()
  })

  test('validation and the no-change guard still run, and run first', () => {
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: 'nope',
        current: 30,
        commitUnchanged: false,
      }).kind,
    ).toBe('invalid')
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: '-1',
        current: 30,
        commitUnchanged: false,
      }).kind,
    ).toBe('invalid')
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: '30',
        current: 30,
        commitUnchanged: false,
      }),
    ).toEqual({ kind: 'unchanged' })
    // An unset row displays the built-in default, so re-typing it IS a write.
    expect(
      selectSettingsIntCommit({
        key: 'cleanupPeriodDays',
        draft: '30',
        current: 30,
        commitUnchanged: true,
      }),
    ).toEqual({ kind: 'write', value: 30 })
  })

  /** Leaving the typed value on screen after a cancel is its own bug: the field
   * would claim a setting nobody saved. */
  test('cancel puts back the value still in effect, never the one refused', () => {
    expect(settingsIntCancelDraft(30)).toBe('30')
    expect(settingsIntCancelDraft(7)).toBe('7')
  })

  /**
   * Anti-drift. The declaration is keyed by a value inside a domain declared in
   * another module; if that domain moves (a `min` of 1, a renamed key) the
   * warning becomes dead code that nobody would notice. This fails instead.
   */
  test('the declared destructive value is still a legal value of a real key', () => {
    const validation = validateEditableSettingValue('cleanupPeriodDays', 0)
    expect(validation.ok).toBe(true)
    expect(EDITABLE_SETTING_KEYS.has('cleanupPeriodDays')).toBe(true)
    expect(selectSettingsDestructiveChoice('cleanupPeriodDays', 0)).not.toBeNull()
  })

  /**
   * No second sentinel (the P4-41 fence). `0` stays an ordinary VALUE and `null`
   * stays the clear channel, told apart structurally at the one place that
   * decides — so a gate in front of `0` can never be mistaken for a reset, and a
   * reset can never be mistaken for "keep nothing".
   */
  test('zero writes zero and null clears, and nothing here blurs the two', () => {
    expect(validateEditableSettingWrite('cleanupPeriodDays', 0)).toEqual({
      ok: true,
      clear: false,
      value: 0,
    })
    expect(validateEditableSettingWrite('cleanupPeriodDays', null)).toEqual({
      ok: true,
      clear: true,
    })
    // The gate carries a NUMBER to `onCommit`; it never mints a token.
    const decision = selectSettingsIntCommit({
      key: 'cleanupPeriodDays',
      draft: '0',
      current: 30,
      commitUnchanged: false,
    })
    expect(decision.kind === 'confirm' && decision.value).toBe(0)
  })
})

describe('the row keeps saying so while a destructive value is in effect', () => {
  function retentionRow(partial: Partial<SettingsSnapshot>) {
    return selectSettingsRow({
      snapshot: snapshot(partial),
      key: 'cleanupPeriodDays',
      layer: 'userSettings',
    })
  }

  test('a saved zero warns, and an ordinary value does not', () => {
    const zero = retentionRow({
      layers: [{ source: 'userSettings', origin: USER_FILE, keys: ['cleanupPeriodDays'] }],
      resolved: [
        { key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false },
      ],
      editableValues: [
        { key: 'cleanupPeriodDays', value: 0, source: 'userSettings' },
      ],
    })
    expect(zero.annotation.kind).toBe('set-here')
    // `settingsRowNote` is SILENT here by design (set-here is the ordinary
    // case), which is exactly why the warning cannot live inside it.
    expect(settingsRowNote(zero)).toBeNull()
    expect(
      selectSettingsDestructiveWarning(zero, 'cleanupPeriodDays'),
    ).toContain('deleted')

    const seven = retentionRow({
      layers: [{ source: 'userSettings', origin: USER_FILE, keys: ['cleanupPeriodDays'] }],
      resolved: [
        { key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false },
      ],
      editableValues: [
        { key: 'cleanupPeriodDays', value: 7, source: 'userSettings' },
      ],
    })
    expect(
      selectSettingsDestructiveWarning(seven, 'cleanupPeriodDays'),
    ).toBeNull()
  })

  test('an unset row shows the built-in default and has nothing to warn about', () => {
    const unset = retentionRow({
      layers: [{ source: 'userSettings', origin: USER_FILE, keys: ['other'] }],
    })
    expect(unset.read.kind).toBe('unset')
    expect(
      selectSettingsDestructiveWarning(unset, 'cleanupPeriodDays'),
    ).toBeNull()
  })

  /**
   * The one `set` read whose value is NOT in effect. An overridden row carries
   * THIS layer's own value while a higher layer wins, so a zero there deletes
   * nothing and warning about it would be a false alarm on a row the operator
   * cannot even act on from here.
   */
  test('a zero that a higher layer overrides deletes nothing, and says nothing', () => {
    const overridden = retentionRow({
      layers: [
        { source: 'userSettings', origin: USER_FILE, keys: ['cleanupPeriodDays'] },
        { source: 'projectSettings', origin: PROJECT_FILE, keys: ['cleanupPeriodDays'] },
      ],
      resolved: [
        { key: 'cleanupPeriodDays', source: 'projectSettings', editable: true, managed: false },
      ],
      editableValues: [
        { key: 'cleanupPeriodDays', value: 0, source: 'userSettings' },
        { key: 'cleanupPeriodDays', value: 30, source: 'projectSettings' },
      ],
    })
    expect(overridden.annotation.kind).toBe('overridden')
    expect(
      selectSettingsDestructiveWarning(overridden, 'cleanupPeriodDays'),
    ).toBeNull()
  })

  /** Inherited IS the resolved value, so the consequence is real even though
   * this scope's own file says nothing. */
  test('a zero inherited from a lower layer is in effect, and warns', () => {
    const inherited = selectSettingsRow({
      snapshot: snapshot({
        layers: [
          { source: 'projectSettings', origin: PROJECT_FILE, keys: ['other'] },
          { source: 'userSettings', origin: USER_FILE, keys: ['cleanupPeriodDays'] },
        ],
        resolved: [
          { key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'cleanupPeriodDays', value: 0, source: 'userSettings' },
        ],
      }),
      key: 'cleanupPeriodDays',
      layer: 'projectSettings',
    })
    expect(inherited.annotation.kind).toBe('inherited')
    expect(
      selectSettingsDestructiveWarning(inherited, 'cleanupPeriodDays'),
    ).not.toBeNull()
  })
})

describe('what the destructive copy is allowed to say (CLAUDE.md §7)', () => {
  const choice = selectSettingsDestructiveChoice('cleanupPeriodDays', 0)

  test('it names the consequence and what to do, in the operator’s words', () => {
    expect(choice).not.toBeNull()
    if (!choice) return
    const all = [
      choice.title,
      choice.body,
      choice.remedy,
      choice.confirmLabel,
      choice.cancelLabel,
      choice.rowWarning,
    ]
    for (const line of all) {
      expect(line.length).toBeGreaterThan(0)
      // §7: no em dash anywhere a user can read it.
      expect(line).not.toContain('—')
      // §7: no key names, no internal vocabulary.
      expect(line).not.toContain('cleanupPeriodDays')
      expect(line.toLowerCase()).not.toContain('persistence')
      expect(line.toLowerCase()).not.toContain('transcript retention')
    }
    // The two halves of the engine behavior, both stated.
    expect(choice.body.toLowerCase()).toContain('deletes every session')
    expect(choice.body.toLowerCase()).toContain('cannot be undone')
    // What to DO, not why we built it this way.
    expect(choice.remedy.toLowerCase()).toContain('set the number back')
  })

  /**
   * The audit's proposed sentence was "Past sessions will be deleted the next
   * time the app starts". That trigger is wrong for THIS app: the sweep is
   * reached only from `startBackgroundHousekeeping`
   * (`src/utils/backgroundHousekeeping.ts:59`), called from the terminal engine
   * (`src/main.tsx:2910`, `src/screens/REPL.tsx:4474`) and never from this app's
   * engine processes. So the copy promises no trigger at all.
   */
  test('the copy does not promise a trigger this app does not own', () => {
    if (!choice) return
    for (const line of [choice.body, choice.remedy, choice.rowWarning]) {
      expect(line.toLowerCase()).not.toContain('next time the app starts')
      expect(line.toLowerCase()).not.toContain('restart')
    }
  })
})

/* ── the Remote rail describes the Remote pane (P4-47, 26d) ───────────────── */

describe('the rail promises only what a pane can deliver', () => {
  /**
   * `decisions/PAIRED-DEVICES.md` §1-§3 cut the SSH connect mode and the device
   * roster, and `RemoteSettingsSnapshot` carries only `bridge` and
   * `commandFilter`, so there is nothing for "saved SSH environments" to be. The
   * copy is aligned with the cut; the cut is not reopened.
   */
  test('the Remote rail no longer advertises saved SSH environments', () => {
    const remote = settingsRailItem('remote')
    expect(remote.desc.toLowerCase()).not.toContain('ssh')
    expect(remote.desc.toLowerCase()).not.toContain('saved')
    // What the pane actually renders (`RemoteSettingsPage.tsx`).
    expect(remote.desc).toContain('Remote Control bridge')
    expect(remote.desc.toLowerCase()).toContain('command filter')
    expect(remote.desc).not.toContain('—')
  })
})
