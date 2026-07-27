import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId } from '../../shared/protocol.js'
import {
  SessionGroup,
  SidebarRowItem,
  type WorkspaceReorderHandlers,
} from './Sidebar.js'
import type { MergedSessionRow, WorkspaceGroup } from './sessionsCatalogState.js'
import type { WorkspaceDropEdge } from './sidebarWorkspaceOrder.js'

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
    cwdExists: true,
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

function group(
  rows: MergedSessionRow[],
  over: Partial<WorkspaceGroup> = {},
): WorkspaceGroup {
  return { cwd: '/tmp/proj', name: 'proj', current: false, rows, ...over }
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

const REORDER: WorkspaceReorderHandlers = {
  onDragStart: noop,
  onDragOver: noop,
  onDrop: noop,
  onDragEnd: noop,
  onStep: noop,
}

function renderGroup(
  rows: MergedSessionRow[],
  {
    onNewSessionInWorkspace,
    onOpenRowActions,
    reorder,
    dragging,
    dropEdge,
    groupOver,
  }: {
    onNewSessionInWorkspace?: (repId: SessionId) => void
    onOpenRowActions?: (
      sessionId: SessionId,
      anchor: { top: number; left: number },
    ) => void
    reorder?: WorkspaceReorderHandlers
    dragging?: boolean
    dropEdge?: WorkspaceDropEdge | null
    groupOver?: Partial<WorkspaceGroup>
  } = {},
): string {
  return renderToStaticMarkup(
    <SessionGroup
      group={group(rows, groupOver)}
      activeSessionId={null}
      collapsed={false}
      onToggle={noop}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onNewSessionInWorkspace={onNewSessionInWorkspace}
      onOpenRowActions={onOpenRowActions}
      reorder={reorder}
      dragging={dragging}
      dropEdge={dropEdge}
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
  expect(html).toContain('session Terminal session, history')
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
  expect(restorable).toContain('aria-label="session R, closed"')

  const history = renderRow(historyRow('h', { displayLabel: 'H', cwd: '/tmp/proj' }))
  expect(history).not.toContain('>history<')
  expect(history).toContain('aria-label="session H, history"')
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

// ── ➕ workspace reordering (operator, 2026-07-26) ────────────────────────────
// The ordering logic itself is proven in `sidebarWorkspaceOrder.test.ts`; these
// assert the DOM wiring over it. The live gesture is operator-GUI only — this
// suite is SSR (`renderToStaticMarkup`) and cannot fire a drag.

test('a workspace header is a drag handle only when reordering is wired', () => {
  const wired = renderGroup([registryRow('a')], { reorder: REORDER })
  // The header row AND the label button — so the whole label is a grab surface,
  // not just the row's padding.
  expect(wired.match(/draggable="true"/g)).toHaveLength(2)
  expect(wired).toContain('cursor-grab')
  expect(wired).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"')
  expect(wired).toContain('title="/tmp/proj. Drag to reorder, or ⌥↑/⌥↓"')

  const unwired = renderGroup([registryRow('a')])
  expect(unwired).not.toContain('draggable')
  expect(unwired).not.toContain('cursor-grab')
  expect(unwired).not.toContain('aria-keyshortcuts')
  expect(unwired).toContain('title="/tmp/proj"')
})

test('the "Unknown workspace" bucket is not a drag handle even when wired', () => {
  const html = renderGroup([historyRow('h', { cwd: '' })], {
    reorder: REORDER,
    groupOver: { cwd: '', name: 'Unknown workspace' },
  })
  expect(html).not.toContain('draggable')
  expect(html).not.toContain('cursor-grab')
  expect(html).not.toContain('aria-keyshortcuts')
  expect(html).toContain('title="Sessions with no recorded workspace"')
})

test('the drop indicator renders on the edge the drop would land on', () => {
  const before = renderGroup([registryRow('a')], {
    reorder: REORDER,
    dropEdge: 'before',
  })
  expect(before).toContain('absolute inset-x-1 top-0 h-[2px] rounded-full bg-accent')
  expect(before).not.toContain('bottom-0 h-[2px] rounded-full bg-accent')

  const after = renderGroup([registryRow('a')], {
    reorder: REORDER,
    dropEdge: 'after',
  })
  expect(after).toContain(
    'absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-accent',
  )
  expect(after).not.toContain('top-0 h-[2px] rounded-full bg-accent')

  const idle = renderGroup([registryRow('a')], { reorder: REORDER })
  expect(idle).not.toContain('h-[2px] rounded-full bg-accent')
})

test('the dragged header is dimmed with a STATIC class (no interpolated arbitrary value)', () => {
  expect(
    renderGroup([registryRow('a')], { reorder: REORDER, dragging: true }),
  ).toContain('opacity-50')
  expect(
    renderGroup([registryRow('a')], { reorder: REORDER, dragging: false }),
  ).not.toContain('opacity-50')
})
