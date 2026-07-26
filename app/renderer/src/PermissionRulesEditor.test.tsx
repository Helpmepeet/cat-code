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
  expect(html).toContain('Current permission mode: plan')
  expect(html).toContain('>plan<')
  // T6b: no interactive mode selector — no set-mode control (aria-pressed
  // buttons) is rendered when showModes=false.
  expect(html).not.toContain('aria-pressed')
})

test('showModes=true: the pill AND the interactive selector both render', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor context={CONTEXT} onSetMode={() => {}} showModes />,
  )
  // The read-only pill is still shown (rendered unconditionally)…
  expect(html).toContain('Current permission mode: plan')
  // …plus the interactive selector (aria-pressed mode buttons).
  expect(html).toContain('aria-pressed')
})

test('waits for the engine context before rendering the pill', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor context={null} onSetMode={() => {}} showModes={false} />,
  )
  expect(html).toContain('Waiting for the engine')
  expect(html).not.toContain('Current permission mode')
})

test('renders engine-derived match type and read-only managed/classifier facts', () => {
  const html = renderToStaticMarkup(
    <PermissionRulesEditor
      context={CONTEXT}
      onSetMode={() => {}}
      showModes={false}
    />,
  )
  expect(html).toContain('>exact<')
  expect(html).toContain(
    'Managed-rules-only enforcement: on, managed read-only',
  )
  expect(html).toContain('Permission classifier: off, managed read-only')
})
