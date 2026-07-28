/**
 * Value-editor render tests. This package has NO DOM harness (bun test exposes
 * no document/window; adding happy-dom needs sign-off), so — like every sibling
 * renderer test — these use `renderToStaticMarkup` for render/state/degrade
 * assertions. The click→write path is proven end-to-end at the sidecar boundary
 * (`sidecarServer.test.ts`) + the domain round-trip (`settingsDomain.test.ts`);
 * the scope→target decision is proven in `settingsScope.test.ts`. Here we prove
 * the controls REFLECT real snapshot state, DISABLE what cannot be written, and
 * render NOTHING for a value this scope has not read.
 */

import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import { SettingsPane } from './SettingsEditors.js'
import { settingsPaneSpecs } from './settingsEditorModel.js'

function snapshot(partial: Partial<SettingsSnapshot>): SettingsSnapshot {
  return {
    layers: [],
    resolved: [],
    policyOrigin: null,
    editableValues: [],
    ...partial,
  }
}

const noop = () => {}

/** React escapes apostrophes; compare against prose after decoding. */
function decode(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
}

/** How many live controls a pane actually rendered. */
function controlCount(html: string): number {
  return (
    (html.match(/role="switch"/g) ?? []).length +
    (html.match(/<select/g) ?? []).length +
    (html.match(/inputMode="numeric"/g) ?? []).length
  )
}

test('a boolean editor reflects the current editableValue (aria-checked)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: '/u/settings.json',
            keys: ['respectGitignore'],
          },
        ],
        resolved: [
          { key: 'respectGitignore', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'respectGitignore', value: false, source: 'userSettings' },
        ],
      })}
    />,
  )
  expect(html).toContain('role="switch"')
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('Respect .gitignore')
})

test('an unset boolean editor falls back to the spec default, and says nothing about it', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="general"
      snapshot={snapshot({})}
    />,
  )
  // respectGitignore defaults to true when unset at every layer.
  expect(html).toContain('aria-checked="true"')
  // Unset in the scope you chose is the ordinary case, so the row spends no
  // prose on it. The page head already names the scope and its file.
  expect(html).not.toContain('Not set here')
})

test('a managed key renders disabled with the Managed badge and the enforced note', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        layers: [
          { source: 'policySettings', origin: '/policy.json', keys: ['fastMode'] },
        ],
        resolved: [
          { key: 'fastMode', source: 'policySettings', editable: false, managed: true },
        ],
        editableValues: [{ key: 'fastMode', value: true, source: 'policySettings' }],
      })}
    />,
  )
  const row = html.slice(html.indexOf('>Fast mode<'))
  expect(row).toContain('Managed')
  expect(row).toContain('Enforced by organization policy')
  // The control exists (the enforced value is real) but cannot be operated.
  expect(row).toContain('role="switch"')
  expect(row).toContain('disabled=""')
})

test('a flag-sourced key annotates the session flag, without a Managed badge', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        layers: [
          { source: 'flagSettings', origin: '--settings', keys: ['reasoningDisplay'] },
        ],
        resolved: [
          { key: 'reasoningDisplay', source: 'flagSettings', editable: false, managed: false },
        ],
        editableValues: [{ key: 'reasoningDisplay', value: 'raw', source: 'flagSettings' }],
      })}
    />,
  )
  // The user file does not set this key, so the row shows OUR layer's own
  // contribution (the built-in default) and carries no provenance badge — a
  // badge would attribute the displayed value to the flag, which did not
  // produce it. The override is stated in prose instead.
  expect(html).toContain('command-line flag on the open session')
  expect(html).not.toContain('Managed') // never the policy badge
  const noBadgeRow = html.slice(html.indexOf('>Reasoning display<'))
  expect(noBadgeRow).not.toContain('>Flag<')

  // When the user file DOES set the key, the value on screen belongs to the
  // flag layer — so that layer is badged, and the row stops claiming a value.
  const shadowed = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        layers: [
          { source: 'userSettings', origin: '/u.json', keys: ['reasoningDisplay'] },
          { source: 'flagSettings', origin: '--settings', keys: ['reasoningDisplay'] },
        ],
        resolved: [
          { key: 'reasoningDisplay', source: 'flagSettings', editable: false, managed: false },
        ],
        editableValues: [{ key: 'reasoningDisplay', value: 'raw', source: 'flagSettings' }],
      })}
    />,
  )
  const shadowedRow = shadowed.slice(shadowed.indexOf('>Reasoning display<'))
  expect(shadowedRow).toContain('>Flag<')
  expect(shadowedRow).toContain('unknown')
})

test('an enum editor renders its options with labels and selects the current value', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        layers: [
          { source: 'userSettings', origin: '/u.json', keys: ['autoUpdatesChannel'] },
        ],
        resolved: [
          { key: 'autoUpdatesChannel', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'autoUpdatesChannel', value: 'stable', source: 'userSettings' },
        ],
      })}
    />,
  )
  expect(html).toContain('Latest')
  expect(html).toContain('Stable')
})

test('the int (retention) editor renders the current value', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
        layers: [
          { source: 'userSettings', origin: '/u.json', keys: ['cleanupPeriodDays'] },
        ],
        resolved: [
          { key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [{ key: 'cleanupPeriodDays', value: 7, source: 'userSettings' }],
      })}
    />,
  )
  expect(html).toContain('value="7"')
})

test('a dynamic-enum (output style) renders the live options and selects the current value', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
        layers: [{ source: 'userSettings', origin: '/u.json', keys: ['outputStyle'] }],
        resolved: [
          { key: 'outputStyle', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'outputStyle', value: 'Explanatory', source: 'userSettings' },
        ],
        availableOptions: [
          {
            key: 'outputStyle',
            options: [
              { value: 'default', label: 'Default' },
              { value: 'Explanatory', label: 'Explanatory' },
              { value: 'Learning', label: 'Learning' },
            ],
          },
        ],
      })}
    />,
  )
  expect(html).toContain('Output style')
  expect(html).toContain('Explanatory')
  expect(html).toContain('Learning')
})

test('a dynamic-enum with no live options renders disabled (honest degrade)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
        layers: [{ source: 'userSettings', origin: '/u.json', keys: ['outputStyle'] }],
        resolved: [
          { key: 'outputStyle', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'outputStyle', value: 'default', source: 'userSettings' },
        ],
        // availableOptions omitted → no live registry.
      })}
    />,
  )
  const row = html.slice(html.indexOf('>Output style<'))
  expect(row).toContain('disabled=""')
})

test('a dynamic-enum shows an on-disk value that is not in the live option set', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
        layers: [{ source: 'userSettings', origin: '/u.json', keys: ['outputStyle'] }],
        resolved: [
          { key: 'outputStyle', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'outputStyle', value: 'my-removed-style', source: 'userSettings' },
        ],
        availableOptions: [
          { key: 'outputStyle', options: [{ value: 'default', label: 'Default' }] },
        ],
      })}
    />,
  )
  expect(html).toContain('my-removed-style')
})

test('every pane renders at its defaults without throwing, snapshot or not', () => {
  for (const pane of ['general', 'model', 'privacy', 'theme'] as const) {
    const html = renderToStaticMarkup(
      <SettingsPane layer="userSettings" onWrite={noop} pane={pane} snapshot={null} />,
    )
    expect(html.length).toBeGreaterThan(0)
  }
})

/* ── spec §5: keys removed from the UI ────────────────────────────────────── */

test('the deprecated and terminal-only keys are no longer rendered anywhere', () => {
  const rendered = (['general', 'model', 'privacy', 'theme'] as const).flatMap(
    pane => settingsPaneSpecs(pane).map(spec => spec.key),
  )
  for (const gone of [
    'includeCoAuthoredBy',
    'spinnerTipsEnabled',
    'terminalTitleFromRename',
    // Model-dependent, and this page has no model (operator ruling 2026-07-27).
    // The model-aware control is the composer's run-control chip.
    'effortLevel',
  ]) {
    expect(rendered).not.toContain(gone)
  }
  // …and the panes are not simply empty: the keys a person revisits stayed.
  expect(rendered).toContain('respectGitignore')
  expect(rendered).toContain('fastMode')
  expect(rendered).toContain('outputStyle')

  const html = renderToStaticMarkup(
    <SettingsPane layer="userSettings" onWrite={noop} pane="general" snapshot={snapshot({})} />,
  )
  expect(html).not.toContain('Co-author attribution')
  expect(html).not.toContain('terminal title')
})

/* ── Law 3: the scope decides the destination, and says so first ──────────── */

test('the destination is stated once, above the controls, naming the real file', () => {
  const html = decode(
    renderToStaticMarkup(
      <SettingsPane
        layer="userSettings"
        onWrite={noop}
        pane="privacy"
        snapshot={snapshot({
          layers: [
            {
              source: 'userSettings',
              origin: '/Users/pt/.cat-code/settings.json',
              keys: ['cleanupPeriodDays'],
            },
          ],
          resolved: [
            { key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false },
          ],
          editableValues: [
            { key: 'cleanupPeriodDays', value: 7, source: 'userSettings' },
          ],
        })}
      />,
    ),
  )
  expect(html).toContain(
    'Edits here write to your own settings file: /Users/pt/.cat-code/settings.json',
  )
  // The destination appears BEFORE the control it governs.
  expect(html.indexOf('Edits here write to')).toBeLessThan(
    html.indexOf('inputMode="numeric"'),
  )
})

/**
 * The behaviour this redesign deletes: `targetSourceFor` wrote back to whichever
 * layer a key already resolved at, so editing a project-overridden value in the
 * user scope silently rewrote that project's file. Same snapshot, two scopes —
 * the destination follows the SCOPE, never the resolution.
 */
test('a project-overridden key writes to the user file in My defaults, and to the project file in project scope', () => {
  const overridden = snapshot({
    layers: [
      { source: 'userSettings', origin: '/u/settings.json', keys: [] },
      {
        source: 'projectSettings',
        origin: '/repo/.cat-code/settings.json',
        keys: ['respectGitignore'],
      },
    ],
    resolved: [
      { key: 'respectGitignore', source: 'projectSettings', editable: true, managed: false },
    ],
    editableValues: [
      { key: 'respectGitignore', value: false, source: 'projectSettings' },
    ],
  })

  const asUser = decode(
    renderToStaticMarkup(
      <SettingsPane layer="userSettings" onWrite={noop} pane="general" snapshot={overridden} />,
    ),
  )
  expect(asUser).toContain(
    'Edits here write to your own settings file: /u/settings.json',
  )
  expect(asUser).not.toContain('write to this project')
  // The override is still VISIBLE; it just does not redirect the write.
  expect(asUser).toContain(
    "Overridden by this project's shared settings: /repo/.cat-code/settings.json",
  )

  const asProject = decode(
    renderToStaticMarkup(
      <SettingsPane layer="projectSettings" onWrite={noop} pane="general" snapshot={overridden} />,
    ),
  )
  expect(asProject).toContain(
    "Edits here write to this project's shared settings file: /repo/.cat-code/settings.json",
  )
  expect(asProject).not.toContain('write to your own settings file')
  // Seen from the scope that sets it, the very same key is unremarkable: no
  // "Set here", and above all no "Overridden by" leaking from the other scope.
  expect(asProject).not.toContain('Set here')
  expect(asProject).not.toContain('Overridden by')
})

test('a value hidden under a higher layer shows unknown, not a guess, and offers no control', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: '/u/settings.json',
            keys: ['cleanupPeriodDays'],
          },
          {
            source: 'localSettings',
            origin: '/repo/.cat-code/settings.local.json',
            keys: ['cleanupPeriodDays'],
          },
        ],
        resolved: [
          { key: 'cleanupPeriodDays', source: 'localSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'cleanupPeriodDays', value: 3, source: 'localSettings' },
        ],
      })}
    />,
  )
  // `privacy` is a single-row pane, so this counts THIS row's controls.
  expect(controlCount(html)).toBe(0)
  expect(html).toContain('unknown')
  // Specifically: the overriding layer's value is never shown as if it were the
  // user's own — the number 3 appears nowhere.
  expect(html).not.toContain('value="3"')
  expect(decode(html)).toContain('your own value here cannot be shown')
})

/**
 * The other side of the row above, and the one the operator reaches by USING the
 * app: they flip a control in My defaults while a project overrides the key, the
 * write lands in their own file, and the next snapshot has their layer defining
 * it too. That row must not become an uneditable word.
 *
 * SSR-only limit, said plainly: this renders the SECOND snapshot directly. It
 * cannot click the control on the first one and watch the row survive, which is
 * the only thing that would prove the round trip.
 */
test('a row this scope wrote is still shown and still editable under an override', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
        layers: [
          {
            source: 'userSettings',
            origin: '/u/settings.json',
            keys: ['cleanupPeriodDays'],
          },
          {
            source: 'localSettings',
            origin: '/repo/.cat-code/settings.local.json',
            keys: ['cleanupPeriodDays'],
          },
        ],
        resolved: [
          { key: 'cleanupPeriodDays', source: 'localSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'cleanupPeriodDays', value: 3, source: 'localSettings' },
          { key: 'cleanupPeriodDays', value: 45, source: 'userSettings' },
        ],
      })}
    />,
  )
  // The operator's OWN value, live and editable — not the word "unknown".
  expect(html).toContain('value="45"')
  expect(html).not.toContain('unknown')
  expect(controlCount(html)).toBe(1)
  expect(html).not.toContain('disabled=""')
  // The badge names the operator's own layer, and its tooltip names that
  // layer's file rather than the overriding one.
  expect(html).toContain('title="/u/settings.json"')
  // The overriding layer's value is still never presented as theirs.
  expect(html).not.toContain('value="3"')
  // …and the row still says the override is in force.
  expect(decode(html)).toContain('Overridden by')
})

/**
 * An unset row shows the BUILT-IN DEFAULT. Choosing that same option is a real
 * edit ("pin it in my file so a later change elsewhere cannot move it"), but a
 * `<select>` fires no `change` event for the option already selected, so it was
 * unreachable and the operator got no feedback of any kind.
 */
test('an unset select offers a way to save the option it is already showing', () => {
  const unset = renderToStaticMarkup(
    <SettingsPane layer="userSettings" onWrite={noop} pane="model" snapshot={snapshot({})} />,
  )
  expect(unset).toContain('aria-label="Save Reasoning display"')

  // A row with a real saved value has nothing to pin, so the affordance is not
  // there to be misread as unsaved state.
  const set = renderToStaticMarkup(
    <SettingsPane
      layer="userSettings"
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        layers: [
          { source: 'userSettings', origin: '/u/settings.json', keys: ['reasoningDisplay'] },
        ],
        resolved: [
          { key: 'reasoningDisplay', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'reasoningDisplay', value: 'raw', source: 'userSettings' },
        ],
      })}
    />,
  )
  expect(set).not.toContain('aria-label="Save Reasoning display"')
})

test('with nothing read the pane offers no control at all, and says why', () => {
  const html = renderToStaticMarkup(
    <SettingsPane layer="userSettings" onWrite={noop} pane="general" snapshot={null} />,
  )
  // Not "disabled controls": no control is drawn, because a drawn toggle has a
  // position and a position is a claim about the operator's file.
  expect(controlCount(html)).toBe(0)
  expect(html).toContain('No session is open')
  // …and nothing promises a destination for a click that cannot happen.
  expect(html).not.toContain('Edits here write to')

  // The same pane with a real snapshot is fully live, so the guard is not
  // simply an empty render.
  const live = renderToStaticMarkup(
    <SettingsPane layer="userSettings" onWrite={noop} pane="general" snapshot={snapshot({})} />,
  )
  expect(controlCount(live)).toBeGreaterThan(0)
})

test('a project with no engine renders no values and no controls, and names the project', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      engine="absent"
      layer="projectSettings"
      noEngineNote="No engine is running in other-repo, so its settings files have not been read."
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        layers: [
          {
            source: 'projectSettings',
            origin: '/repo/.cat-code/settings.json',
            keys: ['respectGitignore'],
          },
        ],
        resolved: [
          { key: 'respectGitignore', source: 'projectSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'respectGitignore', value: false, source: 'projectSettings' },
        ],
      })}
    />,
  )
  expect(controlCount(html)).toBe(0)
  expect(html).toContain('No engine is running in other-repo')
  // The OTHER project's file must not leak in as if it described this one.
  expect(html).not.toContain('/repo/.cat-code/settings.json')
  expect(html).not.toContain('Edits here write to')
})
