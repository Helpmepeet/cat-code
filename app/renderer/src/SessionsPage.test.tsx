import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionsPage } from './SessionsPage.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

function row(partial: Partial<MergedSessionRow> & { sessionId: string }): MergedSessionRow {
  return {
    appSessionId: null,
    cwd: '/w/proj',
    title: null,
    displayLabel: partial.sessionId,
    live: false,
    restorable: false,
    status: 'history',
    inRegistry: false,
    modifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
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
        row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, title: 'Fix the parser', displayLabel: 'Fix the parser' }),
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
      rows={[row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true, displayLabel: 'Live one' })]}
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
  expect(html).toContain('MAX_REGISTRY_SESSIONS')
})
