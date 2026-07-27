import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ExtensionsSnapshot,
  PermissionContextSnapshot,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import { SettingsShell } from './SettingsShell.js'
import {
  ReasoningLayoutContext,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'

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
  editableValues: [],
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

test('core value-editor categories render real editors (P4-19), deferred ones stay stubs', () => {
  // Privacy now ships real value editors over the write-seam (P4-19), no stub.
  const privacy = renderToStaticMarkup(
    <SettingsShell initialCategory="privacy" snapshot={SNAPSHOT} />,
  )
  expect(privacy).not.toContain('coming soon')
  expect(privacy).toContain('Transcript retention (days)') // a real editor
  // Model + Theme likewise ship real editors.
  const model = renderToStaticMarkup(
    <SettingsShell initialCategory="model" snapshot={SNAPSHOT} />,
  )
  expect(model).toContain('Always-on thinking')
  expect(model).toContain('Reasoning effort')
  // Keybindings + IDE/LSP remain honest stubs (deferred — need their own seams).
  const keybindings = renderToStaticMarkup(
    <SettingsShell initialCategory="keybindings" snapshot={SNAPSHOT} />,
  )
  expect(keybindings).toContain('coming soon')
})

test('the Theme pane carries the app-local reasoning-layout selector at the live mode', () => {
  const html = renderToStaticMarkup(
    <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
      <SettingsShell initialCategory="theme" snapshot={SNAPSHOT} />
    </ReasoningLayoutContext.Provider>,
  )

  expect(html).toContain('Reasoning layout')
  // Both treatments are offered, and the control reflects the live mode.
  expect(html).toContain(REASONING_LAYOUT_LABELS.trail)
  expect(html).toContain(REASONING_LAYOUT_LABELS.blocks)
  expect(html).toContain('value="blocks"')
  // App-local, not an engine key: the row carries no settings SourceBadge.
  expect(html).toContain('not in your settings files')
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

const PERMISSION_CONTEXT: PermissionContextSnapshot = {
  mode: 'default',
  alwaysAllowRules: { userSettings: ['Bash(ls)', 'Read'] },
  alwaysDenyRules: { localSettings: ['Bash(rm -rf /tmp)'] },
  alwaysAskRules: {},
  ruleMetadata: [],
  managedRulesOnly: false,
  permissionClassifierEnabled: false,
  additionalWorkingDirectories: [{ path: '/tmp/work', source: 'cliArg' }],
  isBypassPermissionsModeAvailable: false,
}

test('the Permissions pane embeds the P2-4 read-only rules view over the real C3 context', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={PERMISSION_CONTEXT}
      snapshot={SNAPSHOT}
    />,
  )
  // Not the deferred stub any more.
  expect(html).not.toContain('coming soon')
  // Real engine rule strings + behavior group headings from the C3 snapshot.
  expect(html).toContain('Always allow')
  expect(html).toContain('Always deny')
  expect(html).toContain('Bash(ls)')
  expect(html).toContain('Bash(rm -rf /tmp)')
  expect(html).toContain('>userSettings<')
  // C3 additional working directories.
  expect(html).toContain('/tmp/work')
  expect(html).toContain('(cliArg)')
  // Read-only: no mode-switch buttons (showModes=false → no aria-pressed
  // control) and no rule-CRUD affordances (T6b — renderer never authors rules).
  expect(html).not.toContain('aria-pressed')
  expect(html).not.toContain('Add rule')
  expect(html).not.toContain('Save to')
  // D1: the read-only current-mode PILL still displays the engine mode even
  // though the interactive selector is hidden (pure display, not a control).
  expect(html).toContain('Current permission mode: default')
})

/**
 * CC-13 — the operator-observed failure, at the pane the operator actually
 * opens: Settings → Permissions with NO session attached rendered one
 * never-resolving "Waiting for the engine's permission context…" line as its
 * entire content, hiding the persisted `permissions.defaultMode` setting (which
 * the desktop app had no other way to show) and everything P4-34 Lane 2 added.
 */
test('CC-13: Settings → Permissions renders the default-mode setting with NO session attached', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={{
        ...SNAPSHOT,
        permissionDefaultMode: { value: 'plan', source: 'userSettings' },
      }}
    />,
  )
  expect(html).not.toContain('coming soon')
  // The pane's content is the SETTING, sourced from the settings seam…
  expect(html).toContain('Default mode')
  expect(html).toContain('Default permission mode: plan')
  // …not a wait that can never resolve.
  expect(html).not.toContain('Waiting for the engine')
  expect(html).toContain('No session is attached')
})

test('CC-13: the Permissions pane reads defaultMode from the settings seam, not the session', () => {
  // Session mode `default` (PERMISSION_CONTEXT) vs configured default
  // `acceptEdits` — the heading/value mismatch this row fixes.
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={PERMISSION_CONTEXT}
      snapshot={{
        ...SNAPSHOT,
        permissionDefaultMode: { value: 'acceptEdits', source: 'localSettings' },
      }}
    />,
  )
  expect(PERMISSION_CONTEXT.mode).toBe('default')
  expect(html).toContain('Default permission mode: acceptEdits')
  expect(html).toContain('Local')
  expect(html).toContain('Current permission mode: default')
})

test('CC-13: a settings snapshot without the field renders the unset state, not a wait', () => {
  // SNAPSHOT carries no `permissionDefaultMode` (unset at every layer, or a
  // snapshot predating the field) — tolerant read, explicit unset state.
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={SNAPSHOT}
    />,
  )
  expect(html).toContain('Default permission mode: not set')
  expect(html).not.toContain('Waiting for the engine')
})

// The shell is the only production caller, so it is the only place the
// settings-read distinction can actually be got wrong: the editor cannot tell
// "unset" from "never read" unless the shell passes `settingsLoaded`. Both
// panes must still render — the pane not blocking was the original CC-13 fix.
test('CC-13: with NO settings snapshot the Permissions pane renders, and says unknown rather than unset', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={null}
    />,
  )
  expect(html).toContain('Default permission mode: unknown')
  // Must not assert anything about settings files it has not read.
  expect(html).not.toContain('is not set')
  expect(html).toContain('No session is attached')
  expect(html).not.toContain('Waiting for the engine')
})

test('CC-13: WITH a snapshot and no defaultMode, the same pane says unset', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={SNAPSHOT}
    />,
  )
  expect(html).toContain('Default permission mode: not set')
  expect(html).toContain('is not set')
  expect(html).not.toContain('Default permission mode: unknown')
})

test('renders without a snapshot (waiting state)', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={null} />)
  expect(html).toContain('Waiting for the engine')
})
