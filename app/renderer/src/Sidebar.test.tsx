import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId } from '../../shared/protocol.js'
import { SessionGroup, SidebarRowItem } from './Sidebar.js'
import type { MergedSessionRow, WorkspaceGroup } from './sessionsCatalogState.js'

// The Sidebar renders the MERGED roster (desktop registry ∪ terminal history —
// SESSIONS-UNIFICATION). It collapses to the rail by default under
// renderToStaticMarkup (`open = pinned || hovering`), so the expanded group
// header (#10 "+") and rows (#11 ⋮ / open-from-history) are exercised by
// rendering the exported subcomponents directly.

function registryRow(
  id: string,
  over: Partial<MergedSessionRow> = {},
): MergedSessionRow {
  return {
    sessionId: `engine-${id}`,
    appSessionId: id as SessionId,
    cwd: '/tmp/proj',
    title: 'Alpha',
    displayLabel: 'Alpha',
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 0,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    messageCount: 0,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...over,
  }
}

/** A terminal-created history row (no desktop registry row). */
function historyRow(
  id: string,
  over: Partial<MergedSessionRow> = {},
): MergedSessionRow {
  return registryRow(id, {
    appSessionId: null,
    inRegistry: false,
    live: false,
    restorable: false,
    status: 'history',
    ...over,
  })
}

const noop = () => {}

function group(rows: MergedSessionRow[]): WorkspaceGroup {
  return { cwd: '/tmp/proj', name: 'proj', current: false, rows }
}

function renderRow(
  r: MergedSessionRow,
  onOpenRowActions?: (
    sessionId: SessionId,
    anchor: { top: number; left: number },
  ) => void,
): string {
  return renderToStaticMarkup(
    <SidebarRowItem
      row={r}
      isActive={false}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onOpenRowActions={onOpenRowActions}
    />,
  )
}

function renderGroup(
  rows: MergedSessionRow[],
  {
    onNewSessionInWorkspace,
    onOpenRowActions,
  }: {
    onNewSessionInWorkspace?: (repId: SessionId) => void
    onOpenRowActions?: (
      sessionId: SessionId,
      anchor: { top: number; left: number },
    ) => void
  } = {},
): string {
  return renderToStaticMarkup(
    <SessionGroup
      group={group(rows)}
      activeSessionId={null}
      collapsed={false}
      onToggle={noop}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onNewSessionInWorkspace={onNewSessionInWorkspace}
      onOpenRowActions={onOpenRowActions}
    />,
  )
}

// ── #11 per-row actions kebab ────────────────────────────────────────────────

test('a registry row exposes a session-actions ⋮ kebab only when onOpenRowActions is wired', () => {
  const wired = renderRow(registryRow('a', { displayLabel: 'Alpha' }), noop)
  expect(wired).toContain('aria-label="Session actions for Alpha"')
  expect(wired).toContain('title="Session actions"')
})

test('no ⋮ kebab renders when the row is not wired for actions', () => {
  const html = renderRow(registryRow('a', { displayLabel: 'Alpha' }))
  expect(html).not.toContain('Session actions for')
  expect(html).not.toContain('title="Session actions"')
})

test('a history row never renders a ⋮ kebab (no desktop session to act on)', () => {
  const html = renderRow(historyRow('h', { displayLabel: 'Old terminal run' }), noop)
  expect(html).not.toContain('Session actions for')
})

test('CC-2: registry-row recency derives from lastMessageSentAt (createdAt fallback)', () => {
  const now = Date.now()
  const hour = 60 * 60 * 1000

  // Last message 2h ago: the subtitle reads the message time (never an attach —
  // the merged row carries no lastAttachedAt at all).
  const sent = renderRow(
    registryRow('a', {
      displayLabel: 'Alpha',
      lastMessageSentAt: now - 2 * hour,
      createdAtMs: now - 72 * hour,
    }),
  )
  expect(sent).toContain('<span class="shrink-0">2h</span>')

  // Never sent → fall back to createdAt (3d ago).
  const neverSent = renderRow(
    registryRow('b', {
      displayLabel: 'Beta',
      lastMessageSentAt: null,
      createdAtMs: now - 72 * hour,
    }),
  )
  expect(neverSent).toContain('<span class="shrink-0">3d</span>')
})

test('every registry row in a group gets its own action kebab (target-session-bound)', () => {
  const html = renderGroup(
    [
      registryRow('a', { displayLabel: 'Alpha' }),
      registryRow('b', { displayLabel: 'Beta' }),
      registryRow('c', { displayLabel: 'Gamma', restorable: true, live: false, status: 'exited' }),
    ],
    { onOpenRowActions: noop },
  )
  expect(html.match(/aria-label="Session actions for/g)).toHaveLength(3)
  // A restorable row still gets a kebab — the menu itself gates the live verbs.
  expect(html).toContain('aria-label="Session actions for Gamma"')
})

// ── SESSIONS-UNIFICATION: history rows (open-from-history vs browse-only) ─────

test('a history row WITH a resolvable workspace is openable (open-from-history)', () => {
  const html = renderRow(
    historyRow('h', { displayLabel: 'Terminal session', cwd: '/tmp/proj' }),
  )
  // Openable: focusable, not disabled, labeled + titled for opening.
  expect(html).toContain('tabindex="0"')
  expect(html).not.toContain('aria-disabled="true"')
  expect(html).toContain('session Terminal session — history')
  expect(html).toContain('· open')
})

test('a history row with NO recorded workspace is browse-only (degrades, never dead-looking)', () => {
  const html = renderRow(
    historyRow('h', { displayLabel: 'Orphan session', cwd: '' }),
  )
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('tabindex="-1"')
  expect(html).toContain('open from terminal')
  expect(html).toContain('no recorded workspace')
})

// Operator ruling 2026-07-20: NO visible per-row status label in the sidebar.
// Status stays in the aria-label (assistive tech) only — the rows render bare,
// matching the prototype. This test is the tripwire against re-adding a chip.
test('no row renders a visible status label; status stays in aria-label only', () => {
  const restorable = renderRow(
    registryRow('r', { displayLabel: 'R', live: false, restorable: true, status: 'exited' }),
  )
  expect(restorable).not.toContain('>closed<')
  expect(restorable).toContain('aria-label="session R — closed"')

  const history = renderRow(historyRow('h', { displayLabel: 'H', cwd: '/tmp/proj' }))
  expect(history).not.toContain('>history<')
  expect(history).toContain('aria-label="session H — history"')
})

// ── #10 per-workspace new-session "+" ────────────────────────────────────────

test('a workspace group with a registry row exposes a "+" when onNewSessionInWorkspace is wired', () => {
  const html = renderGroup([registryRow('a', { displayLabel: 'Alpha' })], {
    onNewSessionInWorkspace: noop,
  })
  expect(html.match(/aria-label="New session in this workspace"/g)).toHaveLength(
    1,
  )
  expect(html).toContain('title="New session in this workspace"')
})

test('no "+" renders when the group is not wired for new sessions', () => {
  const html = renderGroup([registryRow('a', { displayLabel: 'Alpha' })])
  expect(html).not.toContain('New session in this workspace')
})

test('a pure-terminal-history group hides the "+" (HC1: no registry id to name)', () => {
  const html = renderGroup(
    [historyRow('h1', { displayLabel: 'One', cwd: '/tmp/proj' })],
    { onNewSessionInWorkspace: noop },
  )
  expect(html).not.toContain('New session in this workspace')
})
