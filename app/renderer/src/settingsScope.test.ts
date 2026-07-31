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
  SETTINGS_SCOPE_KINDS,
  selectPermissionDefaultModeRow,
  selectProjectEngine,
  selectSettingsProjects,
  selectSettingsRail,
  selectSettingsRailItem,
  selectSettingsReset,
  selectSettingsRow,
  selectSettingsWriteLayer,
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
    expect(settingsRowNote(row)).toContain('cannot be shown')
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
