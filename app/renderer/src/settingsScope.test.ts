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
  selectProjectEngine,
  selectSettingsProjects,
  selectSettingsRail,
  selectSettingsRailItem,
  selectSettingsRow,
  selectSettingsWriteLayer,
  settingsRowNote,
  settingsWriteTargetNote,
} from './settingsScope.js'

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
    // The user file DOES set this key, so its own value is hidden underneath —
    // which blocks the write rather than guessing a value to send.
    expect(row.read).toEqual({
      kind: 'unreadable',
      by: 'projectSettings',
      origin: PROJECT_FILE,
    })
    expect(row.writeTarget).toBeNull()
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
