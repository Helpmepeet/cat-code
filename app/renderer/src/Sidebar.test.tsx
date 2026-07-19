import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import { SessionGroup, SidebarRowItem } from './Sidebar.js'
import type { SidebarRow } from './sidebarState.js'

// The Sidebar collapses to the rail by default under renderToStaticMarkup
// (`open = pinned || hovering`), so the expanded group header (#10 "+") and rows
// (#11 ⋮) are exercised by rendering the exported subcomponents directly — the
// same idiom SessionActionsMenu.test uses for a floating surface.

function descriptor(
  id: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    appSessionId: id as SessionId,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${id}`,
    title: null,
    status: 'ready',
    restorable: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...overrides,
  }
}

function row(
  id: string,
  descriptorOverrides: Partial<SessionDescriptor> = {},
  visual: Partial<SidebarRow['visual']> = {},
): SidebarRow {
  const d = descriptor(id, descriptorOverrides)
  return {
    descriptor: d,
    visual: {
      kind: d.restorable ? 'restorable' : 'live',
      tone: 'live',
      label: 'ready',
      restorable: d.restorable,
      ...visual,
    },
  }
}

const noop = () => {}

function renderRow(
  r: SidebarRow,
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
      onOpenRowActions={onOpenRowActions}
    />,
  )
}

function renderGroup(
  rows: SidebarRow[],
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
      group={{ cwd: '/tmp/proj', label: 'proj', rows }}
      activeSessionId={null}
      collapsed={false}
      onToggle={noop}
      onSelectLive={noop}
      onRestore={noop}
      onNewSessionInWorkspace={onNewSessionInWorkspace}
      onOpenRowActions={onOpenRowActions}
    />,
  )
}

// ── #11 per-row actions kebab ────────────────────────────────────────────────

test('a row exposes a session-actions ⋮ kebab only when onOpenRowActions is wired', () => {
  const wired = renderRow(row('a', { title: 'Alpha' }), noop)
  expect(wired).toContain('aria-label="Session actions for Alpha"')
  expect(wired).toContain('title="Session actions"')
})

test('no ⋮ kebab renders when the row is not wired for actions', () => {
  const html = renderRow(row('a', { title: 'Alpha' }))
  expect(html).not.toContain('Session actions for')
  expect(html).not.toContain('title="Session actions"')
})

test('CC-2: row recency derives from lastMessageSentAt (createdAt fallback), never lastAttachedAt', () => {
  const now = Date.now()
  const hour = 60 * 60 * 1000

  // Just opened (lastAttachedAt ≈ now) but the last message was 2h ago: the
  // subtitle must read the message time, NOT the attach time (the CC-2 bug).
  const sent = renderRow(
    row('a', {
      title: 'Alpha',
      lastAttachedAt: now,
      lastMessageSentAt: now - 2 * hour,
      createdAt: now - 72 * hour,
    }),
  )
  expect(sent).toContain('<span class="shrink-0">2h</span>')
  expect(sent).not.toContain('<span class="shrink-0">now</span>')

  // Never sent → fall back to createdAt (3d ago), still never lastAttachedAt.
  const neverSent = renderRow(
    row('b', {
      title: 'Beta',
      lastAttachedAt: now,
      lastMessageSentAt: null,
      createdAt: now - 72 * hour,
    }),
  )
  expect(neverSent).toContain('<span class="shrink-0">3d</span>')
  expect(neverSent).not.toContain('<span class="shrink-0">now</span>')
})

test('every row in a group gets its own action kebab (target-session-bound)', () => {
  const html = renderGroup(
    [
      row('a', { title: 'Alpha' }),
      row('b', { title: 'Beta' }),
      row('c', { title: 'Gamma', restorable: true }),
    ],
    { onOpenRowActions: noop },
  )
  expect(html.match(/aria-label="Session actions for/g)).toHaveLength(3)
  // A restorable row still gets a kebab — the menu itself gates the live verbs.
  expect(html).toContain('aria-label="Session actions for Gamma"')
})

// ── #10 per-workspace new-session "+" ────────────────────────────────────────

test('a workspace group header exposes a "+" only when onNewSessionInWorkspace is wired', () => {
  const html = renderGroup([row('a', { title: 'Alpha' })], {
    onNewSessionInWorkspace: noop,
  })
  expect(html.match(/aria-label="New session in this workspace"/g)).toHaveLength(
    1,
  )
  expect(html).toContain('title="New session in this workspace"')
})

test('no "+" renders when the group is not wired for new sessions', () => {
  const html = renderGroup([row('a', { title: 'Alpha' })])
  expect(html).not.toContain('New session in this workspace')
})
