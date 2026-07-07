import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import { SettingsShell } from './SettingsShell.js'

const SNAPSHOT: SettingsSnapshot = {
  layers: [
    { source: 'userSettings', origin: '~/.cat-code/settings.json', keys: ['model', 'theme'] },
    { source: 'policySettings', origin: '/Library/Managed/managed-settings.json', keys: ['telemetry', 'bypassPermissions'] },
  ],
  resolved: [
    { key: 'bypassPermissions', source: 'policySettings', editable: false, managed: true },
    { key: 'model', source: 'userSettings', editable: true, managed: false },
    { key: 'telemetry', source: 'policySettings', editable: false, managed: true },
    { key: 'theme', source: 'userSettings', editable: true, managed: false },
  ],
  policyOrigin: 'file',
}

test('shell renders the two-pane frame with the ported category rail', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
  expect(html).toContain('Settings')
  expect(html).toContain('Search settings')
  // Ported nav categories + groups.
  for (const label of ['General', 'Model &amp; Inference', 'Permissions', 'Theme &amp; Output', 'MCP', 'Managed']) {
    expect(html).toContain(label)
  }
  for (const group of ['Interface', 'Extensions', 'System', 'Organization']) {
    expect(html).toContain(group)
  }
  // CUT surfaces never appear.
  expect(html).not.toContain('Prototype controls')
})

test('the default (General) view surfaces the real layer summary + resolution legend', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
  expect(html).toContain('Configuration sources')
  expect(html).toContain('Resolution order:')
  expect(html).toContain('~/.cat-code/settings.json') // real layer origin
  expect(html).toContain('2 keys') // userSettings key count
})

test('the Managed panel renders real policy-locked keys as managed Fields', () => {
  const html = renderToStaticMarkup(<SettingsShell initialCategory="managed" snapshot={SNAPSHOT} />)
  expect(html).toContain('Managed by your organization')
  expect(html).toContain('Enforced settings')
  expect(html).toContain('policy source: file')
  // Only the two policy-won keys, each managed (with a lock badge).
  expect(html).toContain('telemetry')
  expect(html).toContain('bypassPermissions')
  // A user-source key is NOT in the enforced list.
  expect(html).not.toContain('>theme<')
})

test('value-editor categories are honest stubs, not mocked controls', () => {
  const html = renderToStaticMarkup(<SettingsShell initialCategory="mcp" snapshot={SNAPSHOT} />)
  expect(html).toContain('coming soon')
  expect(html).toContain('P4-12')
})

test('renders without a snapshot (waiting state)', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={null} />)
  expect(html).toContain('Waiting for the engine')
})
