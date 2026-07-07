import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Field,
  ManagedBadge,
  ResolutionOrderLegend,
  SourceBadge,
} from './SettingsField.js'

test('SourceBadge renders the real display label per source', () => {
  expect(renderToStaticMarkup(<SourceBadge source="userSettings" />)).toContain('User')
  expect(renderToStaticMarkup(<SourceBadge source="projectSettings" />)).toContain('Project')
  expect(renderToStaticMarkup(<SourceBadge source="localSettings" />)).toContain('Local')
  expect(renderToStaticMarkup(<SourceBadge source="flagSettings" />)).toContain('Flag')
  // Policy is the "Managed" source in the real model.
  expect(renderToStaticMarkup(<SourceBadge source="policySettings" />)).toContain('Managed')
})

test('SourceBadge colors are token-backed per source (no inline style)', () => {
  const html = renderToStaticMarkup(<SourceBadge source="projectSettings" origin="/repo/.cat-code/settings.json" />)
  expect(html).toContain('text-source-project')
  expect(html).toContain('/repo/.cat-code/settings.json') // origin → tooltip
  expect(html).not.toContain('style=')
})

test('SourceBadge meta escape hatch overrides label + class (AgentsPage reuse)', () => {
  const html = renderToStaticMarkup(
    <SourceBadge meta={{ label: 'Builtin', className: 'text-source-user' }} />,
  )
  expect(html).toContain('Builtin')
})

test('ManagedBadge renders a lock and the Managed label', () => {
  const html = renderToStaticMarkup(<ManagedBadge origin="managed-settings.json" />)
  expect(html).toContain('Managed')
  expect(html).toContain('<svg') // lock icon
  expect(html).toContain('managed-settings.json')
})

test('Field shows the ManagedBadge (not SourceBadge) for a managed value', () => {
  const html = renderToStaticMarkup(
    <Field label="Anonymous telemetry" managed source="policySettings" desc="Enforced by policy">
      <span>on</span>
    </Field>,
  )
  expect(html).toContain('Anonymous telemetry')
  expect(html).toContain('Enforced by policy')
  expect(html).toContain('Managed')
  // A managed field never offers reset.
  expect(html).not.toContain('Reset to default')
})

test('Field source-badges an editable value and offers reset when modified', () => {
  const html = renderToStaticMarkup(
    <Field label="Default model" source="projectSettings" modified onReset={() => {}}>
      <span>sonnet</span>
    </Field>,
  )
  expect(html).toContain('Default model')
  expect(html).toContain('Project')
  expect(html).toContain('Reset to default')
})

test('Field hides reset for a non-editable (flag-overridden) value', () => {
  const html = renderToStaticMarkup(
    <Field label="Update channel" source="flagSettings" editable={false} modified onReset={() => {}}>
      <span>latest</span>
    </Field>,
  )
  expect(html).toContain('Flag')
  expect(html).not.toContain('Reset to default')
})

test('Field renders an inline validation error', () => {
  const html = renderToStaticMarkup(
    <Field label="Max output tokens" source="userSettings" error="Must be a number.">
      <span>abc</span>
    </Field>,
  )
  expect(html).toContain('Must be a number.')
})

test('ResolutionOrderLegend shows all five sources highest-wins', () => {
  const html = renderToStaticMarkup(<ResolutionOrderLegend />)
  expect(html).toContain('Resolution order:')
  expect(html).toContain('highest wins')
  for (const label of ['Managed', 'Flag', 'Local', 'Project', 'User']) {
    expect(html).toContain(label)
  }
})
