import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionsPage } from './SessionsPage.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

function row(partial: Partial<MergedSessionRow> & { sessionId: string }): MergedSessionRow {
  return {
    appSessionId: null,
    cwd: '/w/proj',
    cwdExists: true,
    title: null,
    displayLabel: partial.sessionId,
    live: false,
    restorable: false,
    status: 'history',
    inRegistry: false,
    modifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    messageCount: 0,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...partial,
  }
}

const noop = () => {}

test('renders the header, count subtitle and real session titles', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[
        row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, status: 'ready', title: 'Fix the parser', displayLabel: 'Fix the parser' }),
        row({ sessionId: 'b', title: 'Old TUI session', displayLabel: 'Old TUI session' }),
      ]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  expect(html).toContain('Sessions')
  expect(html).toContain('2 sessions')
  expect(html).toContain('Fix the parser')
  expect(html).toContain('Old TUI session')
  expect(html).toContain('New session')
})

test('renders the live status badge for a live registry row', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, status: 'ready', displayLabel: 'Live one' })]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  expect(html).toContain('live')
})

test('renders the history badge for a non-registry session', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'a', displayLabel: 'History one' })]}
      activeCwd={null}
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  expect(html).toContain('history')
})

test('shows the empty state (no rows) and the loading state (catalog not loaded)', () => {
  const empty = renderToStaticMarkup(
    <SessionsPage rows={[]} activeCwd={null} catalogLoaded truncated={false} onOpenRow={noop} onNewSession={noop} />,
  )
  expect(empty).toContain('No sessions yet')

  const loading = renderToStaticMarkup(
    <SessionsPage rows={[]} activeCwd={null} catalogLoaded={false} truncated={false} onOpenRow={noop} onNewSession={noop} />,
  )
  expect(loading).toContain('Loading sessions')
})

test('F3 — shows the terminal-history-loading notice above rows when the catalog is not loaded', () => {
  const loadingWithRows = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, status: 'ready', displayLabel: 'Registry one' })]}
      activeCwd={null}
      catalogLoaded={false}
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  // The registry row still renders (page is not empty)...
  expect(loadingWithRows).toContain('Registry one')
  // ...but the honesty notice makes clear the list is not the full history.
  expect(loadingWithRows).toContain('Terminal-session history is still loading')

  // Once a catalog (live or baseline) is present, the notice is gone.
  const loaded = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, status: 'ready', displayLabel: 'Registry one' })]}
      activeCwd={null}
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  expect(loaded).not.toContain('Terminal-session history is still loading')
})

test('shows the truncation / registry-eviction note when truncated', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'a', displayLabel: 'One' })]}
      activeCwd={null}
      catalogLoaded
      truncated
      onOpenRow={noop}
      onNewSession={noop}
    />,
  )
  expect(html).toContain('the oldest can drop off this list entirely')
})

/* --- P4-29 action affordances --------------------------------------------
 * These are SSR snapshots, so they prove the affordances MOUNT with the right
 * enablement and copy; the interaction itself is covered by the pure reducer +
 * placement tests in `sessionsPageState.test.ts`, and the click-through remains
 * an operator GUI step (this suite has no DOM).
 * ------------------------------------------------------------------------- */

const live = (sessionId: string, extra: Partial<MergedSessionRow> = {}) =>
  row({
    sessionId,
    appSessionId: `app-${sessionId}`,
    inRegistry: true,
    live: true,
    status: 'ready',
    displayLabel: sessionId,
    ...extra,
  })

test('P4-29 — every row offers selection, and a live row offers the actions menu', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[live('a')]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(html).toContain('Select session')
  expect(html).toContain('Session actions')
})

test('P4-29 — a terminal-history row has no actions menu (no engine to act on)', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[row({ sessionId: 'h', displayLabel: 'History one' })]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(html).toContain('History one')
  expect(html).toContain('Select session')
  expect(html).not.toContain('Session actions')
})

test('P4-29 — the tag control reads "+ tag" when untagged and "#tag" when tagged', () => {
  const untagged = renderToStaticMarkup(
    <SessionsPage
      rows={[live('a')]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(untagged).toContain('+ tag')
  expect(untagged).toContain('Add tag')

  const tagged = renderToStaticMarkup(
    <SessionsPage
      rows={[live('a', { tag: 'infra' })]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(tagged).toContain('#infra')
  expect(tagged).toContain('Edit tag')
})

test('P4-29 — a CLOSED row cannot be tagged, and says what would make it possible', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[
        row({
          sessionId: 'a',
          appSessionId: 'app-a',
          inRegistry: true,
          live: false,
          restorable: true,
          status: 'exited',
          displayLabel: 'Closed one',
        }),
      ]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(html).toContain('Open or restore this session first.')
  expect(html).toContain('disabled')
})

test('P4-29 — the bulk bar is absent with no selection (and needs no scrim then)', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[live('a'), live('b')]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated={false}
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(html).not.toContain('selected')
  expect(html).not.toContain('Clear selection')
})

test('P4-29 — user-visible copy carries no em dash (operator rule)', () => {
  const html = renderToStaticMarkup(
    <SessionsPage
      rows={[live('a', { tag: 'infra' }), row({ sessionId: 'h' })]}
      activeCwd="/w/proj"
      catalogLoaded
      truncated
      onOpenRow={noop}
      onNewSession={noop}
      onOpenRowActions={noop}
    />,
  )
  expect(html).not.toContain('—')
})
