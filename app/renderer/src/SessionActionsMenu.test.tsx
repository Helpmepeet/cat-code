import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import { resolveSessionActions } from './sessionActions.js'
import { SessionActionsMenu } from './SessionActionsMenu.js'

const noop = () => {}

function row(overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w/proj',
    title: 'Refactor auth',
    displayLabel: 'Refactor auth',
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    messageCount: 4,
    gitBranch: null,
    tag: null,
    mode: 'normal',
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...overrides,
  }
}

function render(isActiveOpen: boolean, r: MergedSessionRow = row()): string {
  return renderToStaticMarkup(
    <SessionActionsMenu
      items={resolveSessionActions(r, { isActiveOpen })}
      anchor={{ top: 40, left: 80 }}
      onAction={noop}
      onClose={noop}
    />,
  )
}

test('renders the menu with a scrim and the Session actions label', () => {
  const html = render(true)
  expect(html).toContain('Session actions')
  expect(html).toContain('role="menu"')
})

test('active-open row: Copy + Inspect render as live menuitem buttons', () => {
  const html = render(true)
  expect(html).toContain('Copy transcript for LLM')
  expect(html).toContain('Inspect metadata…')
  // Two live verbs (Open, Copy, Inspect) → real <button> menuitems present.
  expect(html).toContain('<button')
})

test('deferred verbs render disabled with a "soon" tag and the reason as a tooltip', () => {
  const html = render(true)
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('soon')
  // The Branch reason (source-cited) rides the disabled row's title attribute.
  expect(html).toContain('branch.ts:61')
  expect(html).toContain('exportRenderer.tsx:91')
})

test('inactive row: Copy + Inspect are disabled with the open-first reason', () => {
  const html = render(false)
  expect(html).toContain('Open this session first')
})

test('cut verbs never render (no Tag/Archive/Delete)', () => {
  const html = render(true)
  expect(html).not.toContain('Archive')
  expect(html).not.toContain('Delete')
  expect(html.toLowerCase()).not.toContain('>tag<')
})

test('history-only row: Open is disabled, not a clickable button label', () => {
  const html = render(false, row({ appSessionId: null, inRegistry: false, live: false, status: 'history' }))
  expect(html).toContain('host-API gap')
})
