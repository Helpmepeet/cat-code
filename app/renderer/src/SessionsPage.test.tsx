import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BulkBar, SessionsPage } from './SessionsPage.js'
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
    parked: false,
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

test('tag popover Enter applies only a value resolved from the query', () => {
  const source = readFileSync(new URL('./SessionsPage.tsx', import.meta.url), 'utf8')
  expect(source).toContain('if (resolved) apply(resolved)')
  expect(source).not.toContain('else if (matches[0]) apply(matches[0])')
})

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
          parked: false,
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

/* --------------------------------------------------------------------------- *
 * P4-35 — the bulk bar's Export control. Rendered directly because the bar only
 * mounts once rows are selected, which this harness cannot do.
 * --------------------------------------------------------------------------- */

function bulkBar(overrides: Partial<Parameters<typeof BulkBar>[0]> = {}) {
  return (
    <BulkBar
      selectedCount={3}
      visibleCount={10}
      allSelected={false}
      writableCount={3}
      onSelectAll={noop}
      onTag={noop}
      onExport={noop}
      onClear={noop}
      {...overrides}
    />
  )
}

test('P4-35 — the bulk bar offers Export beside Tag, in the prototype order', () => {
  const html = renderToStaticMarkup(bulkBar())
  expect(html).toContain('Export')
  expect(html).toContain('3 selected')
  // Tag then Export then the clear affordance (`SessionsPage.jsx:625-629`), with
  // Archive and Delete absent (no engine verb exists for either).
  expect(html.indexOf('Tag')).toBeLessThan(html.indexOf('Export'))
  expect(html.indexOf('Export')).toBeLessThan(html.indexOf('Clear selection'))
  expect(html).not.toContain('Archive')
  expect(html).not.toContain('Delete')
})

test('P4-35 — Export fires with the rows, once', () => {
  let fired = 0
  const el = BulkBar({
    selectedCount: 2,
    visibleCount: 5,
    allSelected: false,
    writableCount: 2,
    onSelectAll: noop,
    onTag: noop,
    onExport: () => (fired += 1),
    onClear: noop,
  }) as never as { props: { children: { props: { children: unknown[] } } } }
  const buttons = (el.props.children.props.children as { props: Record<string, unknown> }[])
    .filter(child => child?.props && 'onClick' in child.props)
  const exportButton = buttons.find(
    button => JSON.stringify(button.props.children).includes('Export'),
  )
  expect(exportButton).toBeDefined()
  expect(exportButton!.props.disabled).toBe(false)
  ;(exportButton!.props.onClick as () => void)()
  expect(fired).toBe(1)
})

test('P4-35 — a selection with no live row cannot export, and says what to do', () => {
  // Export reads each transcript through that session's OWN engine, so a closed
  // row has nothing to read it with. Same posture and wording shape as Tag.
  const html = renderToStaticMarkup(bulkBar({ writableCount: 0 }))
  expect(html).toContain('Open or restore at least one of these sessions first.')
  expect(html).toContain('disabled')
})

test('P4-35 — a partly-closed selection says how many it will actually export', () => {
  const html = renderToStaticMarkup(bulkBar({ selectedCount: 5, writableCount: 2 }))
  expect(html).toContain('Exports 2 of 5: the rest are closed.')
})

test('P4-35 — Export is inert when the page was given no export handler', () => {
  // Never a Potemkin control: without the wiring it is visibly disabled, not a
  // live button over a missing callback.
  const el = BulkBar({
    selectedCount: 2,
    visibleCount: 5,
    allSelected: false,
    writableCount: 2,
    onSelectAll: noop,
    onTag: noop,
    onClear: noop,
  }) as never as { props: { children: { props: { children: unknown[] } } } }
  const buttons = (el.props.children.props.children as { props: Record<string, unknown> }[])
    .filter(child => child?.props && 'onClick' in child.props)
  const exportButton = buttons.find(
    button => JSON.stringify(button.props.children).includes('Export'),
  )
  expect(exportButton!.props.disabled).toBe(true)
})

test('P4-35 — the bulk bar carries no em dash (operator rule)', () => {
  for (const writableCount of [0, 2, 3]) {
    expect(renderToStaticMarkup(bulkBar({ writableCount }))).not.toContain('—')
  }
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
