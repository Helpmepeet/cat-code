import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import { resolveSessionActions } from './sessionActions.js'
import {
  SessionActionsMenu,
  SessionRenamePopover,
} from './SessionActionsMenu.js'

const noop = () => {}

function row(overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w/proj',
    cwdExists: true,
    title: 'Refactor auth',
    displayLabel: 'Refactor auth',
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
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

test('active-open row: Copy hosts a flyout and Inspect renders as a live menuitem button', () => {
  const html = render(true)
  // P4-30 — Copy became the flyout HOST (`SessionActions.jsx:174`): it renders
  // with a chevron and `aria-haspopup`, and it is NOT a dispatching button. Its
  // variants live in the submenu, which only opens on hover/focus.
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('Copy transcript for LLM')
  expect(html).toContain('Inspect metadata…')
  expect(html).toContain('<button')
})

test('P4-30: the menu renders leading icons, the History section label and the sa-pop entrance', () => {
  const html = render(true)
  // SA_IC icon slot — every row now carries a glyph, and the panel animates in.
  expect(html).toContain('animate-sa-pop')
  expect(html).toContain('<svg')
  // SectionLabel: History is the ONE labelled section in the prototype.
  expect(html).toContain('>History<')
})

test('a still-deferred verb (Rewind) renders disabled with a "soon" tag and the reason as a tooltip', () => {
  const html = render(true)
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('soon')
  // Rewind stays deferred (no engine conversation-rewind verb); its source-cited
  // reason rides the disabled row's title attribute.
  expect(html).toContain('not available in the desktop app yet')
})

test('P4-6b wired verbs (Rename/Export/Branch) render as live buttons for a LIVE row', () => {
  const html = render(true)
  expect(html).toContain('Rename')
  expect(html).toContain('Export…')
  expect(html).toContain('Branch from HEAD…')
  // None of the three carries a "soon"-tagged deferral title on a live row.
  expect(html).not.toContain('exportRenderer.tsx:91')
  expect(html).not.toContain('branch.ts:61')
})

test('non-live row: Rename/Export/Branch render disabled with the live-engine reason', () => {
  const html = render(false, row({ live: false, restorable: true, status: 'exited' }))
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('live engine')
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
  expect(html).toContain('came from terminal history')
})

test('SessionRenamePopover prefills the input with the current title', () => {
  const html = renderToStaticMarkup(
    <SessionRenamePopover
      anchor={{ top: 40, left: 80 }}
      initial="Refactor auth"
      onCommit={noop}
      onCancel={noop}
    />,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-label="Rename session"')
  expect(html).toContain('value="Refactor auth"')
})
