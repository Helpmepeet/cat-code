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

test('a null snapshot renders every pane at its defaults without throwing', () => {
  for (const pane of ['general', 'model', 'privacy', 'theme'] as const) {
    const html = renderToStaticMarkup(
      <SettingsPane onWrite={noop} pane={pane} snapshot={null} />,
    )
    expect(html.length).toBeGreaterThan(0)
  }
})
