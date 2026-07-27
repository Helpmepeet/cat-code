/**
 * P4-19 value-editor render tests. This package has NO DOM harness (bun test
 * exposes no document/window; adding happy-dom needs sign-off), so — like every
 * sibling renderer test — these use `renderToStaticMarkup` for render/state/
 * degrade assertions. The click→write path is proven end-to-end at the sidecar
 * boundary (sidecarServer.test.ts) + the domain round-trip (settingsDomain.test.ts);
 * here we prove the controls REFLECT real snapshot state and correctly DISABLE
 * managed / flag-sourced keys.
 */

import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import { SettingsPane } from './SettingsEditors.js'

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

test('a boolean editor reflects the current editableValue (aria-checked)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        resolved: [
          { key: 'includeCoAuthoredBy', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'includeCoAuthoredBy', value: false, source: 'userSettings' },
        ],
      })}
    />,
  )
  // The co-author switch reflects the persisted `false`.
  expect(html).toContain('role="switch"')
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('Co-author attribution')
})

test('an unset boolean editor falls back to the spec default', () => {
  const html = renderToStaticMarkup(
    <SettingsPane onWrite={noop} pane="general" snapshot={snapshot({})} />,
  )
  // includeCoAuthoredBy defaults to true when unset at every layer.
  expect(html).toContain('aria-checked="true"')
})

test('a managed key renders disabled with the Managed badge', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        resolved: [
          { key: 'fastMode', source: 'policySettings', editable: false, managed: true },
        ],
        editableValues: [{ key: 'fastMode', value: true, source: 'policySettings' }],
      })}
    />,
  )
  expect(html).toContain('disabled')
  expect(html).toContain('Managed')
})

test('a flag-sourced key renders disabled (non-editable) without a Managed badge', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="model"
      snapshot={snapshot({
        resolved: [
          { key: 'effortLevel', source: 'flagSettings', editable: false, managed: false },
        ],
        editableValues: [{ key: 'effortLevel', value: 'high', source: 'flagSettings' }],
      })}
    />,
  )
  expect(html).toContain('disabled')
  expect(html).toContain('Flag') // the flag source badge, not Managed
})

test('an enum editor renders its options with labels and selects the current value', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
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
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
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
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
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
  expect(html).toContain('Default')
  expect(html).toContain('Explanatory')
  expect(html).toContain('Learning')
})

test('a dynamic-enum with no live options renders disabled (honest degrade)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
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
  expect(html).toContain('Output style')
  expect(html).toContain('disabled')
})

test('a dynamic-enum shows an on-disk value that is not in the live option set', () => {
  // A style whose dir was removed: the value must still display (reflect truth).
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
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

test('a null snapshot renders every pane at its defaults without throwing', () => {
  for (const pane of ['general', 'model', 'privacy', 'theme'] as const) {
    const html = renderToStaticMarkup(
      <SettingsPane onWrite={noop} pane={pane} snapshot={null} />,
    )
    expect(html.length).toBeGreaterThan(0)
  }
})

/* ── write-target disclosure ──────────────────────────────────────────────
 * `targetSourceFor` (SettingsEditors.tsx) writes back to whichever editable
 * layer a key already resolves at. A key that already has a project override
 * therefore writes into THAT project's settings file, invisible everywhere
 * else — and previously nothing on the row said so before the click. These
 * tests assert the user-file and project-file cases render DIFFERENT text
 * (not merely that some text is present, per the false-positive caution
 * above: `toContain('disabled')` once passed with the guard deleted).
 *
 * Panes render every spec for that pane, so a snapshot naming ONE key still
 * renders its sibling rows (at their unset/user-layer defaults). Tests that
 * need "no note anywhere" use `privacy` (single-spec pane, `cleanupPeriodDays`)
 * to avoid sibling noise; the dynamic-enum test scopes to the tail of the html
 * starting at its own label, since `outputStyle` is that pane's LAST row. */

test('a key resolving to the user layer shows a quiet write-target note naming the user file, not the project one', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        resolved: [
          { key: 'includeCoAuthoredBy', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'includeCoAuthoredBy', value: false, source: 'userSettings' },
        ],
      })}
    />,
  )
  expect(html).toContain('Writes to your settings')
  expect(html).not.toContain('Writes to Project settings')
  expect(html).not.toContain('text-source-project')
})

test('a key resolving to a project override shows the project write-target note with the real file path', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        layers: [
          {
            source: 'projectSettings',
            origin: '/repo/.cat-code/settings.json',
            keys: ['includeCoAuthoredBy'],
          },
        ],
        resolved: [
          { key: 'includeCoAuthoredBy', source: 'projectSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'includeCoAuthoredBy', value: false, source: 'projectSettings' },
        ],
      })}
    />,
  )
  // `includeCoAuthoredBy` is the FIRST row in `general`; scope to it so a
  // sibling's (unset → user-layer) note can't leak a false pass/fail either
  // way — the sibling rows legitimately say "Writes to your settings" too.
  const coAuthorRow = html.slice(0, html.indexOf('Git workflow instructions'))
  // Distinguishes the project destination from the user one: different text
  // AND the actual on-disk path, not just "some note is present".
  expect(coAuthorRow).toContain('Writes to Project settings, not yours')
  expect(coAuthorRow).toContain('/repo/.cat-code/settings.json')
  expect(coAuthorRow).toContain('text-source-project')
  expect(coAuthorRow).not.toContain('Writes to your settings')
})

test('a key resolving to a local override shows the local write-target note, distinct from the project one', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="general"
      snapshot={snapshot({
        layers: [
          {
            source: 'localSettings',
            origin: '/repo/.cat-code/settings.local.json',
            keys: ['includeCoAuthoredBy'],
          },
        ],
        resolved: [
          { key: 'includeCoAuthoredBy', source: 'localSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'includeCoAuthoredBy', value: false, source: 'localSettings' },
        ],
      })}
    />,
  )
  const coAuthorRow = html.slice(0, html.indexOf('Git workflow instructions'))
  expect(coAuthorRow).toContain('Writes to Local settings, not yours')
  expect(coAuthorRow).toContain('/repo/.cat-code/settings.local.json')
  expect(coAuthorRow).toContain('text-source-local')
  expect(coAuthorRow).not.toContain('Writes to Project settings')
  expect(coAuthorRow).not.toContain('Writes to your settings')
})

test('an unread snapshot shows no write-target note at all (the disabled controls assert nothing)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane onWrite={noop} pane="general" snapshot={null} />,
  )
  expect(html).not.toContain('Writes to')
})

test('a managed key shows no write-target note (it cannot be clicked)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
        resolved: [
          { key: 'cleanupPeriodDays', source: 'policySettings', editable: false, managed: true },
        ],
        editableValues: [{ key: 'cleanupPeriodDays', value: 30, source: 'policySettings' }],
      })}
    />,
  )
  expect(html).not.toContain('Writes to')
})

test('a flag-sourced key shows no write-target note (it cannot be clicked)', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="privacy"
      snapshot={snapshot({
        resolved: [
          { key: 'cleanupPeriodDays', source: 'flagSettings', editable: false, managed: false },
        ],
        editableValues: [{ key: 'cleanupPeriodDays', value: 14, source: 'flagSettings' }],
      })}
    />,
  )
  expect(html).not.toContain('Writes to')
})

test('a dynamic-enum with no live options shows no write-target note (the control is inert despite being "editable")', () => {
  const html = renderToStaticMarkup(
    <SettingsPane
      onWrite={noop}
      pane="theme"
      snapshot={snapshot({
        resolved: [
          { key: 'outputStyle', source: 'userSettings', editable: true, managed: false },
        ],
        editableValues: [
          { key: 'outputStyle', value: 'default', source: 'userSettings' },
        ],
        // availableOptions omitted → no live registry → the select disables
        // itself for a SECOND reason beyond `resolution.editable`.
      })}
    />,
  )
  // `outputStyle` is the last row in `theme`, so the tail of the html from its
  // own label onward belongs to it alone — no sibling row's note can leak in.
  const outputStyleRow = html.slice(html.indexOf('>Output style<'))
  expect(outputStyleRow).not.toContain('Writes to')
})
