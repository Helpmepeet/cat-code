import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExtensionsSnapshot, SettingsSnapshot } from '../../shared/protocol.js'
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
  // Privacy stays a stub (its value editors land in a later Phase-4 session).
  const html = renderToStaticMarkup(<SettingsShell initialCategory="privacy" snapshot={SNAPSHOT} />)
  expect(html).toContain('coming soon')
})

const EXTENSIONS: ExtensionsSnapshot = {
  mcp: [{ name: 'linear', transport: 'http', scope: 'user', url: 'https://mcp.linear/rpc' }],
  plugins: [
    {
      id: 'fmt@tools',
      name: 'formatter',
      source: 'fmt@tools',
      enabled: true,
      builtin: false,
      provides: { commands: 1, agents: 0, skills: 0, hooks: 0, mcpServers: 0, lsp: 0 },
    },
  ],
  skills: [
    {
      name: 'deep-research',
      source: 'userSettings',
      context: 'inline',
      disableModelInvocation: false,
      userInvocable: true,
      description: 'research a topic',
    },
  ],
  hooks: [
    {
      event: 'PreToolUse',
      type: 'command',
      source: 'userSettings',
      async: false,
      displayLine: 'run-check',
    },
  ],
  notes: [],
}

test('extension categories render the P4-12 panels over the real snapshot, not stubs', () => {
  const mcp = renderToStaticMarkup(
    <SettingsShell initialCategory="mcp" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(mcp).not.toContain('coming soon')
  expect(mcp).toContain('linear')
  expect(mcp).toContain('Configured')

  const skills = renderToStaticMarkup(
    <SettingsShell initialCategory="skills" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(skills).toContain('/deep-research')

  const hooks = renderToStaticMarkup(
    <SettingsShell initialCategory="hooks" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(hooks).toContain('PreToolUse')
  expect(hooks).toContain('run-check')
})

test('renders without a snapshot (waiting state)', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={null} />)
  expect(html).toContain('Waiting for the engine')
})
