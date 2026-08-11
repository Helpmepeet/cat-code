import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId } from '../../shared/protocol.js'
import {
  SessionGroup,
  Sidebar,
  SidebarRowItem,
  WorkspaceActionsMenu,
  type WorkspaceReorderHandlers,
} from './Sidebar.js'
import { SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY } from './sidebarHiddenWorkspaces.js'
import type { MergedSessionRow, WorkspaceGroup } from './sessionsCatalogState.js'
import {
  PINNED_SESSION_DRAG_MIME,
  SIDEBAR_PINNED_SESSIONS_STORAGE_KEY,
} from './sidebarPinnedSessions.js'
import {
  WORKSPACE_ORDER_DRAG_MIME,
  type WorkspaceDropEdge,
} from './sidebarWorkspaceOrder.js'

// The Sidebar renders the MERGED roster (desktop registry ∪ terminal history —
// SESSIONS-UNIFICATION). It collapses to the rail by default under
// renderToStaticMarkup (all open sources are initially false), so the expanded group
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
    parked: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 0,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
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
    parked: false,
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
  modelForSession?: (id: SessionId) => string | null,
): string {
  return renderToStaticMarkup(
    <SidebarRowItem
      row={r}
      isActive={false}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onOpenRowActions={onOpenRowActions}
      modelForSession={modelForSession}
    />,
  )
}

const REORDER: WorkspaceReorderHandlers = {
  onDragStart: noop,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
  onDragEnd: noop,
  onStep: noop,
}

function renderGroup(
  rows: MergedSessionRow[],
  {
    onNewSessionInWorkspace,
    onOpenRowActions,
    onOpenWorkspaceActions,
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
    onOpenWorkspaceActions?: () => void
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
      onOpenWorkspaceActions={onOpenWorkspaceActions}
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

/**
 * The `time · model` subtitle. `modelForSession` is asked for the LIVE model
 * (App reads the re-broadcast run-controls seam, not the spawn-frozen
 * diagnostics snapshot), and only a row with an `appSessionId` can be asked at
 * all — a history row has no session to resolve.
 */
test('the subtitle renders the model name verbatim, and asks only for rows that have a session', () => {
  const asked: (SessionId | null)[] = []
  const model = (id: SessionId) => {
    asked.push(id)
    return 'GPT-5.6 Sol'
  }

  // Verbatim: a display name carries its own spaces and dots, and the row used
  // to cut it at the last hyphen (leaving "5.6 Sol", and a bare "5" for Opus 5).
  const live = renderRow(registryRow('a', { displayLabel: 'Alpha' }), undefined, model)
  expect(live).toContain('<span class="truncate">GPT-5.6 Sol</span>')
  expect(asked).toEqual(['a'])

  // A model the engine has no marketing name for arrives as its raw id, and is
  // shown as-is rather than trimmed to a meaningless fragment.
  const raw = renderRow(registryRow('b'), undefined, () => 'claude-opus-5')
  expect(raw).toContain('<span class="truncate">claude-opus-5</span>')

  // A history row carries no appSessionId, so the resolver is never called and
  // the subtitle is recency alone — never a borrowed model from another row.
  asked.length = 0
  const history = renderRow(historyRow('h'), undefined, model)
  expect(history).not.toContain('terra')
  expect(asked).toEqual([])

  // An unknown model is omitted rather than printed as a placeholder.
  const unknown = renderRow(registryRow('c'), undefined, () => null)
  expect(unknown).not.toContain('class="truncate"')
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

// ── O1 (operator ruling 2026-07-31): the live-only dot ───────────────────────
// A single small unlabeled dot on LIVE rows, absent otherwise. Bound: no chip,
// no status word, no per-state colour vocabulary, nothing at all on a not-live
// row. Liveness comes from `row.live` (a registry row with a running process),
// not from `deriveMergedRowVisual().kind`, which also calls a non-restorable
// `exited` row live. The exact markup is asserted so an interpolated
// arbitrary-value class (the Tailwind v4 trap, invisible to a headless test)
// cannot slip in.
//
// PLACEMENT IS NOT COVERED HERE, by construction: this suite renders to static
// markup, so it pins WHICH rows carry a dot and cannot see WHERE the dot lands.
// The lane's geometry (centred on the title's line box, reserved on every row so
// live and not-live share a text edge) is operator-verified only.
const LIVE_DOT_LANE_OPEN =
  '<span aria-hidden="true" class="pointer-events-none flex h-4 w-1.5 shrink-0 items-center self-start">'
const LIVE_DOT =
  `${LIVE_DOT_LANE_OPEN}<span class="h-1.5 w-1.5 rounded-full bg-tone-good"></span></span>`
const EMPTY_DOT_LANE = `${LIVE_DOT_LANE_OPEN}</span>`

test('a live registry row carries the O1 dot, unlabeled and announced only once', () => {
  const html = renderRow(registryRow('l', { displayLabel: 'L' }))
  expect(html).toContain(LIVE_DOT)
  // Decorative: the state is already in the aria-label, so the dot adds no
  // second announcement and no visible text.
  expect(html).toContain('aria-label="session L, live"')
  expect(html).not.toContain('>live<')
})

test('a restorable registry row carries no dot at all', () => {
  const html = renderRow(
    registryRow('r', {
      displayLabel: 'R',
      live: false,
      restorable: true,
      parked: false,
      status: 'exited',
    }),
  )
  expect(html).not.toContain('rounded-full')
  // The lane still renders, so this row's title starts at the same x as a live
  // row's and the dot's presence never shifts text.
  expect(html).toContain(EMPTY_DOT_LANE)
})

test('a non-restorable exited registry row carries no dot (row.live, not visual.kind)', () => {
  // `deriveMergedRowVisual` folds this row to kind `live` (inRegistry && !restorable);
  // `row.live` is false because the process is gone. The dot follows `row.live`.
  const html = renderRow(
    registryRow('x', {
      displayLabel: 'X',
      live: false,
      restorable: false,
      parked: false,
      status: 'exited',
    }),
  )
  expect(html).not.toContain('rounded-full')
})

test('history rows carry no dot, openable or browse-only', () => {
  const openable = renderRow(
    historyRow('h', { displayLabel: 'H', cwd: '/tmp/proj' }),
  )
  expect(openable).not.toContain('rounded-full')

  const browseOnly = renderRow(historyRow('o', { displayLabel: 'O', cwd: '' }))
  expect(browseOnly).not.toContain('rounded-full')

  // Both keep the reserved lane, so a mixed group has one straight text edge.
  expect(openable).toContain(EMPTY_DOT_LANE)
  expect(browseOnly).toContain(EMPTY_DOT_LANE)
})

test('a mixed group paints exactly one dot in exactly one tone', () => {
  const html = renderGroup([
    registryRow('a', { displayLabel: 'Alpha' }),
    registryRow('b', {
      displayLabel: 'Beta',
      live: false,
      restorable: true,
      parked: false,
      status: 'exited',
    }),
    registryRow('c', {
      displayLabel: 'Gamma',
      live: false,
      restorable: true,
      parked: false,
      status: 'disconnected',
    }),
    historyRow('h', { displayLabel: 'Delta', cwd: '/tmp/proj' }),
  ])
  expect(html.match(/rounded-full/g)).toHaveLength(1)
  // One tone only — no per-state colour vocabulary.
  expect(html.match(/bg-tone-/g)).toHaveLength(1)
  expect(html).toContain(LIVE_DOT)
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

/* --------------------------------------------------------------------------- *
 * P4-33 — `menuActive` holds the rail open (the prototype's Sidebar.jsx:80-81).
 * The `open` derivation IS observable under SSR: it picks the width class, which
 * is why these render the whole Sidebar rather than a subcomponent.
 * --------------------------------------------------------------------------- */

function renderSidebar(
  over: Partial<Parameters<typeof Sidebar>[0]> = {},
): string {
  return renderToStaticMarkup(
    <Sidebar
      rows={[registryRow('s1')]}
      activeSessionId={'s1' as SessionId}
      activeView="chat"
      onSelectView={() => {}}
      onSelectLive={() => {}}
      onRestore={() => {}}
      onOpenHistory={() => {}}
      storage={null}
      {...over}
    />,
  )
}

// The rail is `fixed`, so a permanent `w-12` spacer div reserves its width in
// flow and is present in BOTH states. Assert on the <aside>'s own width, which
// trails the shared transition classes.
const ASIDE_COLLAPSED = 'ease-out w-12'
const ASIDE_EXPANDED = 'ease-out w-60'

test('P4-33 — the rail stays collapsed when no row menu is open', () => {
  const html = renderSidebar()
  expect(html).toContain(ASIDE_COLLAPSED)
  expect(html).not.toContain(ASIDE_EXPANDED)
})

test('P4-53 — the collapsed rail keeps the pin as its stable keyboard entry target', () => {
  const html = renderSidebar()
  expect(html).toContain('aria-label="Pin sidebar open"')
  expect(html).toContain(
    'class="pointer-events-none absolute inset-0 h-[50px] w-12 opacity-0"',
  )
  expect(html).not.toContain('aria-label="Search sessions"')
  // SSR proves the pin is present and natively focusable before expansion. It
  // cannot dispatch focus, observe the capture handler, or prove the next Tab
  // reaches search/roster controls; those remain operator-only checks.
})

test('P4-53 — collapsed and expanded nav buttons share generic focus-handoff ids', () => {
  const collapsed = renderSidebar()
  const expanded = renderSidebar({ menuActive: true })
  for (const id of [
    'chat',
    'sessions',
    'goals',
    'accounts',
    'settings',
  ]) {
    const marker = `data-sidebar-nav-id="${id}"`
    expect(collapsed.match(new RegExp(marker, 'g'))).toHaveLength(1)
    expect(expanded.match(new RegExp(marker, 'g'))).toHaveLength(1)
  }
  // The shared id pins the generic ref handoff for reverse entry, including
  // Settings. SSR cannot press Shift+Tab or observe the layout-effect focus.
})

test('P4-33 — a sidebar-anchored row menu holds the rail expanded', () => {
  // Without this the pointer moving toward the (App-level, `fixed`) menu leaves
  // the rail, the hide timer fires, and the sidebar collapses out from under a
  // menu still anchored to the row that is now hidden.
  const html = renderSidebar({ menuActive: true })
  expect(html).toContain(ASIDE_EXPANDED)
  expect(html).not.toContain(ASIDE_COLLAPSED)
})

test('P4-33 — holding it open reveals the row content the menu is anchored to', () => {
  // The point of the guard is that the ANCHOR stays visible, not merely that a
  // width changed: the expanded rail renders the row title.
  expect(renderSidebar({ menuActive: true })).toContain('Alpha')
})

/* --------------------------------------------------------------------------- *
 * Design source `components/sidebar/index.html` (2026-08-01): New chat, the
 * Pinned section, the Projects header, and the account/destinations footer.
 *
 * These render the WHOLE Sidebar with `menuActive` — the only SSR-reachable way
 * into the expanded branch (all four open sources are false under
 * `renderToStaticMarkup`). Ordering/pin LOGIC is proven in
 * `sidebarPinnedSessions.test.ts`; what follows is the DOM wiring over it.
 * --------------------------------------------------------------------------- */

/** A seeded storage stub, so a pin exists before the first render. */
function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

function pinning(...sessionIds: string[]) {
  return storage({
    [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      sessionIds,
    }),
  })
}

/** Projects the operator has hidden, as the project menu would have left them. */
function hiding(...workspaces: { cwd: string; hiddenAt: number }[]) {
  return storage({
    [SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      workspaces,
    }),
  })
}

/** A per-project row arrangement left behind by the reverted 2026-08-01 in-group
 * drag. Nothing reads this key any more; the fixture exists to prove it. */
function staleOrdering(cwd: string, ...sessionIds: string[]) {
  return storage({
    'catcode.sidebarSessionOrder.v1': JSON.stringify({
      version: 1,
      byWorkspace: { [cwd]: sessionIds },
    }),
  })
}

// ── New chat / Add project ───────────────────────────────────────────────────

test('New chat renders above the list only when wired', () => {
  expect(renderSidebar({ menuActive: true, onNewChat: noop })).toContain(
    'New chat',
  )
  expect(renderSidebar({ menuActive: true })).not.toContain('New chat')
})

test('the Projects header carries an "add project" only when wired', () => {
  const wired = renderSidebar({ menuActive: true, onAddProject: noop })
  expect(wired).toContain('aria-label="Add project"')
  // No em dash in user-visible text (CLAUDE.md §7).
  expect(wired).toContain('title="Add project: choose a folder"')
  expect(renderSidebar({ menuActive: true })).not.toContain('Add project')
})

test('the Projects section header is always present, empty roster included', () => {
  expect(renderSidebar({ menuActive: true })).toContain('Projects')
  const empty = renderSidebar({ menuActive: true, rows: [] })
  expect(empty).toContain('Projects')
  expect(empty).toContain('No sessions yet.')
  // Nothing is pinned, so the section that would hold pins never renders.
  expect(empty).not.toContain('>Pinned<')
})

// ── Hide project ─────────────────────────────────────────────────────────────

test('a project header carries a ⋮ only when wired for project actions', () => {
  const wired = renderGroup([registryRow('a')], {
    onOpenWorkspaceActions: noop,
  })
  expect(wired).toContain('aria-label="Project actions for proj"')
  expect(wired).toContain('title="Project actions"')
  expect(renderGroup([registryRow('a')])).not.toContain('Project actions')
})

test('the "Unknown workspace" bucket gets no project ⋮ (it is not a project)', () => {
  // The rail withholds the callback for the empty-cwd bucket, the same rule that
  // makes it non-reorderable.
  const html = renderSidebar({
    menuActive: true,
    rows: [registryRow('s1', { cwd: '', displayLabel: 'Alpha' })],
  })
  expect(html).toContain('Unknown workspace')
  expect(html).not.toContain('Project actions for')
})

test('the project menu offers Hide project and nothing else', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActionsMenu
      workspaceName="proj"
      anchor={{ top: 100, bottom: 118, left: 40 }}
      onHide={noop}
      onClose={noop}
    />,
  )
  expect(html).toContain('Hide project')
  expect(html).toContain('aria-label="Project actions for proj"')
  // No em dash in user-visible text (CLAUDE.md §7).
  expect(html).not.toContain('—')
})

test('a hidden project leaves the rail, and the roster says how to get it back', () => {
  const html = renderSidebar({
    menuActive: true,
    rows: [
      registryRow('s1', { cwd: '/w/keep', displayLabel: 'Alpha' }),
      registryRow('s2', { cwd: '/w/gone', displayLabel: 'Beta' }),
    ],
    activeSessionId: null,
    storage: hiding({ cwd: '/w/gone', hiddenAt: Date.now() }),
  })
  expect(html).toContain('>keep<')
  expect(html).not.toContain('>gone<')
  expect(html).not.toContain('>Beta<')
  expect(html).toContain('Show 1 hidden project')
})

test('a project with work newer than the hide comes back on its own', () => {
  // Why `hiddenAt` exists: picking a hidden project's folder from "Add project"
  // creates a session there, and the group must not swallow it.
  const html = renderSidebar({
    menuActive: true,
    rows: [
      registryRow('s2', {
        cwd: '/w/gone',
        displayLabel: 'Beta',
        lastMessageSentAt: 5_000,
      }),
    ],
    activeSessionId: null,
    storage: hiding({ cwd: '/w/gone', hiddenAt: 1_000 }),
  })
  expect(html).toContain('>gone<')
  expect(html).not.toContain('hidden project')
})

test('nothing hidden means no restore line at all', () => {
  expect(renderSidebar({ menuActive: true })).not.toContain('hidden project')
})

// ── Pinned section ───────────────────────────────────────────────────────────

test('a pinned session is LIFTED into the Pinned section, not duplicated below', () => {
  const html = renderSidebar({
    menuActive: true,
    rows: [
      registryRow('s1', { displayLabel: 'Alpha' }),
      registryRow('s2', { displayLabel: 'Beta' }),
    ],
    storage: pinning('engine-s1'),
  })
  expect(html).toContain('>Pinned<')
  // Exactly once on the page: the Pinned section owns it now.
  expect(html.match(/>Alpha</g)).toHaveLength(1)
  expect(html.match(/>Beta</g)).toHaveLength(1)
  // Its project group still renders, holding only what is left.
  expect(html).toContain('>proj<')
})

test('the Pinned section is absent when nothing is pinned', () => {
  expect(renderSidebar({ menuActive: true })).not.toContain('>Pinned<')
})

test('a project row is NOT a drag handle; only a pinned row is', () => {
  const rows = [
    registryRow('s1', { displayLabel: 'Alpha' }),
    registryRow('s2', { displayLabel: 'Beta' }),
  ]
  // Only the workspace HEADER carries ⌥↑/⌥↓ — its two project rows do not.
  const html = renderSidebar({ menuActive: true, rows })
  expect(
    html.match(/aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/g),
  ).toHaveLength(1)
  // Scoped to ROWS: the workspace header is still a grab handle (2026-07-26
  // workspace reordering), and only a row carries the `transition-colors` prefix.
  expect(html).toContain('transition-colors cursor-pointer')
  expect(html).not.toContain('transition-colors cursor-grab')

  // Pinning one lifts it into the Pinned section, which IS reorderable, so the
  // handle count goes up by exactly one and that row becomes a grab handle.
  const withPin = renderSidebar({
    menuActive: true,
    rows,
    storage: pinning('engine-s1'),
  })
  expect(
    withPin.match(/aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/g),
  ).toHaveLength(2)
  expect(withPin).toContain('transition-colors cursor-grab')
})

test('the pinned drag type collides with no other list in the rail', () => {
  // Pinned is the only reorderable row list, but its payload must still not be
  // accepted by the workspace-header drag or the tab→panel split.
  expect(PINNED_SESSION_DRAG_MIME).not.toBe(WORKSPACE_ORDER_DRAG_MIME)
  expect(PINNED_SESSION_DRAG_MIME).not.toBe('text/sessionid')
})

test('a group ignores a stale hand-arrangement and stays in activity order', () => {
  // REGRESSION (2026-08-02). In-group ordering stored the group's whole id list
  // capped at 64, and rendered un-stored rows ABOVE the stored block. Any project
  // past the cap therefore surfaced its OLDEST rows: cat-code had 168 sessions, so
  // the rail's top row read 22 days old while the newest sat far below.
  //
  // Here the arrangement names the two NEWEST rows, which is exactly the shape
  // that inverted. Activity order must win outright.
  const html = renderSidebar({
    menuActive: true,
    rows: [
      registryRow('s3', { displayLabel: 'Gamma', lastMessageSentAt: 3 }),
      registryRow('s2', { displayLabel: 'Beta', lastMessageSentAt: 2 }),
      registryRow('s1', { displayLabel: 'Alpha', lastMessageSentAt: 1 }),
    ],
    storage: staleOrdering('/tmp/proj', 'engine-s3', 'engine-s2'),
  })
  const order = ['Gamma', 'Beta', 'Alpha'].map(name => html.indexOf(`>${name}<`))
  expect(order.every(at => at > -1)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

// ── The row's pin button ─────────────────────────────────────────────────────

test('the pin button renders only when a pin handler is wired', () => {
  const wired = renderToStaticMarkup(
    <SidebarRowItem
      row={registryRow('a', { displayLabel: 'Alpha' })}
      isActive={false}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onTogglePin={noop}
    />,
  )
  expect(wired).toContain('aria-label="Pin Alpha"')
  expect(wired).toContain('title="Pin to top"')
  expect(wired).toContain('aria-pressed="false"')

  expect(renderRow(registryRow('a', { displayLabel: 'Alpha' }))).not.toContain(
    'aria-label="Pin Alpha"',
  )
})

test('a pinned row reads pressed and offers the unpin', () => {
  const html = renderToStaticMarkup(
    <SidebarRowItem
      row={registryRow('a', { displayLabel: 'Alpha' })}
      isActive={false}
      pinned
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onTogglePin={noop}
    />,
  )
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('aria-label="Unpin Alpha"')
  expect(html).toContain('title="Unpin"')
})

test('a browse-only row offers no actions at all (nothing to act on)', () => {
  const html = renderToStaticMarkup(
    <SidebarRowItem
      row={historyRow('h', { displayLabel: 'Orphan', cwd: '' })}
      isActive={false}
      onSelectLive={noop}
      onRestore={noop}
      onOpenHistory={noop}
      onOpenRowActions={noop}
      onTogglePin={noop}
    />,
  )
  expect(html).not.toContain('aria-label="Pin Orphan"')
  expect(html).not.toContain('Session actions for')
})

// ── Footer: account + destinations ───────────────────────────────────────────

test('the footer names the active account, and links it to the Accounts page', () => {
  const html = renderSidebar({ menuActive: true, accountAlias: 'pubmtaki' })
  // No em dash in user-visible text (CLAUDE.md §7).
  expect(html).toContain('aria-label="Active account: pubmtaki"')
  expect(html).toContain('>pubmtaki<')
  expect(html).toContain('>P<')
})

test('no account resolved yet leaves the footer with just the destinations toggle', () => {
  const html = renderSidebar({ menuActive: true, accountAlias: null })
  expect(html).not.toContain('Active account')
  expect(html).toContain('aria-label="Show destinations"')
})

test('the destinations start folded, inert, and out of the tab order', () => {
  const html = renderSidebar({ menuActive: true })
  expect(html).toContain('aria-expanded="false"')
  // Folded it is visually gone but still in flow; without `inert` Tab would walk
  // five invisible destinations.
  expect(html).toContain('inert=""')
  expect(html).toContain('grid-rows-[0fr] opacity-0')
  // Every destination is still MOUNTED (the focus-handoff ref map depends on it).
  expect(html).toContain('data-sidebar-nav-id="settings"')
})

test('the unfold stagger uses static delay classes, never an interpolated one', () => {
  // An arbitrary-value class built at runtime silently no-ops in this Tailwind
  // v4 setup and a headless test cannot see the difference — so the folded state
  // must carry no delay class at all, and the source must hold literals.
  const folded = renderSidebar({ menuActive: true })
  expect(folded).not.toContain('delay-[')
  expect(folded).toContain('translate-y-1.5 scale-95 opacity-0')
})

test('the collapsed rail keeps the account glyph above the destination icons', () => {
  const html = renderSidebar({ accountAlias: 'pubmtaki' })
  expect(html).toContain('title="Active account: pubmtaki"')
  expect(html).toContain('>P<')
  // The rail is the reason the expanded footer may keep its list folded: every
  // destination stays one click away here.
  for (const id of ['chat', 'sessions', 'goals', 'accounts', 'settings']) {
    expect(html).toContain(`data-sidebar-nav-id="${id}"`)
  }
})
