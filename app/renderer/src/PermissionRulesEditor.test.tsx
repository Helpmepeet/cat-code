import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import type { PermissionContextSnapshot } from '../../shared/protocol.js'

const CONTEXT: PermissionContextSnapshot = {
  mode: 'plan',
  alwaysAllowRules: { userSettings: ['Bash(ls)'] },
  alwaysDenyRules: {},
  alwaysAskRules: {},
  ruleMetadata: [
    {
      behavior: 'allow',
      source: 'userSettings',
      rule: 'Bash(ls)',
      matchType: 'exact',
    },
  ],
  managedRulesOnly: true,
  permissionClassifierEnabled: false,
  additionalWorkingDirectories: [],
  isBypassPermissionsModeAvailable: false,
}

test('showModes=false: the read-only current-mode pill renders, the interactive selector does NOT', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={CONTEXT}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  // D1: the pill is a pure DISPLAY of the current mode — present read-only.
  // The mode reads in the same vocabulary the mode chip beside it uses, never
  // the engine's own key.
  expect(html).toContain('Current permission mode: Plan')
  expect(html).toContain('>Plan<')
  expect(html).not.toContain('>plan<')
  // T6b: no interactive mode selector — no set-mode control (aria-pressed
  // buttons) is rendered when showModes=false.
  expect(html).not.toContain('aria-pressed')
})

test('showModes=true: the pill AND the interactive selector both render', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor context={CONTEXT} onSetMode={() => {}} showModes />,
  )
  // The read-only pill is still shown (rendered unconditionally)…
  expect(html).toContain('Current permission mode: Plan')
  // The mode buttons read as labels too, not as `dontAsk`/`acceptEdits`.
  expect(html).toContain('>Accept edits<')
  expect(html).toContain('>Auto<')
  expect(html).toContain('>Don&#x27;t ask<')
  expect(html).not.toContain('>acceptEdits<')
  // This fixture reports the classifier unavailable, so Auto is visible but
  // cannot issue a mode transition.
  expect(html).toContain('disabled=""')
  // …plus the interactive selector (aria-pressed mode buttons).
  expect(html).toContain('aria-pressed')
})

/**
 * CC-13 — the settings-backed half must not depend on a session. These four
 * cover the operator-observed failure and its neighbours: no session at all, no
 * session but a default IS configured, a session whose live mode DIVERGES from
 * the configured default, and a session with no default configured.
 */
test('CC-13: with NO session attached the pane still renders its default-mode content', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={null}
      defaultMode={{ value: 'acceptEdits', source: 'userSettings' }}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  // The settings-backed default renders, with its provenance.
  expect(html).toContain('Default permission mode: Accept edits')
  expect(html).toContain('User')
  // …and the pane is NOT an indefinite wait.
  expect(html).not.toContain('Waiting for the engine')
  // The session-derived half states plainly that it needs a session.
  expect(html).toContain('No session is attached')
  expect(html).not.toContain('Current permission mode')
})

test('CC-13: the Default mode section shows the SETTING, not the session mode', () => {
  // The divergence the old code could not express: the session sits in `plan`
  // while `permissions.defaultMode` is `acceptEdits`.
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={CONTEXT}
      defaultMode={{ value: 'acceptEdits', source: 'projectSettings' }}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  expect(CONTEXT.mode).toBe('plan')
  // Heading promises a default; the default is what it shows.
  expect(html).toContain('Default permission mode: Accept edits')
  expect(html).toContain('Project')
  // The session's live mode is still shown — but labelled as this session's.
  expect(html).toContain('This session')
  expect(html).toContain('Current permission mode: Plan')
})

test('CC-13: an unset defaultMode renders an explicit unset state, never a fake value', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={CONTEXT}
      defaultMode={null}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  expect(html).toContain('Default permission mode: not set')
  // The session's mode must NOT be borrowed as the default.
  expect(html).not.toContain('Default permission mode: Plan')
  expect(html).toContain('Current permission mode: Plan')
})

// "Unset at every layer" and "no settings file has been read yet" are different
// facts, and only the first licenses a statement about the operator's files. The
// snapshot is session-keyed, so the second is the state the Settings page is in
// with nothing open — exactly where the original CC-13 report came from.
test('CC-13: an unread settings snapshot reads as unknown, and claims nothing about the files', () => {
  const props = {
    context: null,
    defaultMode: null,
    onSetMode: () => {},
    showModes: false,
  } as const
  const unread = renderToStaticMarkup(
    <PermissionRulesEditor {...props} settingsLoaded={false} />,
  )
  const read = renderToStaticMarkup(
    <PermissionRulesEditor {...props} settingsLoaded />,
  )

  expect(unread).toContain('Default permission mode: unknown')
  expect(unread).not.toContain('is not set')
  expect(unread).toContain('have not been read yet')

  // The loaded case is the ONLY one allowed to speak for the settings files.
  expect(read).toContain('Default permission mode: not set')
  expect(read).toContain('is not set')
  expect(read).not.toContain('have not been read yet')

  // The whole bug was these two rendering identically.
  expect(unread).not.toBe(read)
})

test('CC-13 + T6b: the settings-backed default is never a control, even with showModes', () => {
  // Making the default-mode section session-independent must not turn it into a
  // set-mode affordance: `permission.setMode` is session-scoped and has no
  // destination for `permissions.defaultMode` (PERMISSION-BOUNDARY.md §3).
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={null}
      defaultMode={{ value: 'plan', source: 'policySettings' }}
      onSetMode={() => {}}
      showModes
    />,
  )
  expect(html).toContain('Default permission mode: Plan')
  expect(html).not.toContain('aria-pressed')
  expect(html).not.toContain('<button')
})

test('CC-13: no session AND no settings snapshot still resolves to a stated state', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={null}
      defaultMode={null}
      onSetMode={() => {}}
      settingsLoaded={false}
      showModes={false}
    />,
  )
  expect(html).toContain('Default permission mode: unknown')
  expect(html).toContain('No session is attached')
  expect(html).not.toContain('Waiting for the engine')
})

test('renders engine-derived match type and read-only managed/classifier facts', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={CONTEXT}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  // The match type reads in words; the engine's `exact`/`prefix` tokens do not
  // reach the page.
  expect(html).toContain('>exact match<')
  expect(html).not.toContain('>exact<')
  expect(html).toContain(
    'Managed-rules-only enforcement: on, managed read-only',
  )
  expect(html).toContain('Permission classifier: off, managed read-only')
})
