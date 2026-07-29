/**
 * Sidebar (P4-4 fidelity true-up) — the shell's left rail, trued up to the
 * prototype's `Sidebar.jsx` grammar: a hover-expanding rail (48px → 240px, pin,
 * shadow, easing), a paw logo, session search, workspace grouping (by cwd), and
 * a nav destination rail — replacing P3-5b's static 240px roster.
 *
 * Data (SESSIONS-UNIFICATION — operator ruling 2026-07-20): it renders the
 * MERGED roster — desktop registry rows ∪ terminal-created history — via the
 * D5-blessed shared selector `selectMergedSessionRows` (App computes it as
 * `sessionCatalogRows`; no second merge). This is the ruling that a session
 * created in the terminal is the SAME session as one created in the app: the
 * whole enumeration is listed and grouped by workspace, exactly as the prototype
 * `Sidebar.jsx` receives the entire session list. A registry row raises the same
 * switch/restore intents as before; a terminal-history row with a resolvable
 * workspace raises `onOpenHistory` (the Part-A host path, opening it by engine
 * id); a history row with no recorded workspace (MAJOR-1) is browse-only.
 *
 * §0 fidelity flags (divergences from the prototype, by design):
 *  - Rows render NO visible status chip: the prototype's rows are bare, and the
 *    operator ruled out per-row status labels (2026-07-20). Status stays in the
 *    `aria-label` only. A browse-only history row is still non-interactive.
 *  - The per-workspace "+" renders only for a group that has at least one
 *    registry row to name (HC1: createSessionInWorkspace needs a registry id,
 *    not a path); a pure-terminal-history workspace has no such id, so its "+"
 *    is hidden (🔁 adapted — a fresh session there still goes via ⌘T / picker).
 *  - No per-row status dot: the prototype's sidebar rows carry none (title +
 *    `time · model` only), so the earlier real-added health dot was removed
 *    2026-07-14 to match the prototype (operator decision). Live/dead/busy state
 *    still surfaces on the TabBar.
 *  - All five nav destinations are wired: Chat, Sessions (P4-6a), Goals,
 *    Accounts (P4-5), and Settings. None are mocked.
 *  - Per-row actions (#11): each session row raises the SAME P4-6b
 *    `SessionActionsMenu` as the TabBar — a hover-revealed ⋮ kebab and a
 *    right-click both call `onOpenRowActions(sessionId, anchor)`, which App routes
 *    to its single already-rendered menu instance (target-session-bound; the menu's
 *    `resolveSessionActions` auto-disables live-gated verbs on non-active/restorable
 *    rows with honest reasons). No new inbound frame / preload channel is added.
 *  - Per-workspace "+" (#10/#15): each group header carries a "+" that spawns a
 *    fresh session DIRECTLY in THAT workspace — no native picker. It calls
 *    `onNewSessionInWorkspace(repId)` with the group's active row id (else its
 *    first row) — a REGISTRY id, never a path. The host looks that id up, re-derives
 *    + re-validates the row's cwd from its OWN registry (exactly as restore does),
 *    and spawns there (HC1/T8 — the renderer authors no cwd). The whole-app ⌘T /
 *    TabBar "+" still uses the native picker (`onNewSession`), unchanged.
 *  - Session-row drag-to-panel is omitted; the built split model is drag-tab-to-
 *    edge (P3-6), which stays intact.
 *  - ➕ real-added (operator, 2026-07-26): the workspace GROUP HEADERS are
 *    drag-reorderable, and the chosen order persists across restarts. The
 *    prototype has no such affordance, so there is nothing to match here. The
 *    order is renderer-local (`sidebarWorkspaceOrder.ts`), keyed on `cwd` (never
 *    the derived label), applied on the SIDEBAR side of the shared
 *    `groupByWorkspace` so the Sessions page keeps frozen-alphabetical, and it
 *    never consults `activeCwd` — CC-2 warp-freedom is intact.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SessionId } from '../../shared/protocol.js'
import {
  deriveMergedRowVisual,
  isSidebarVisibleRow,
  normalizeSidebarGroupExpansion,
  resolveNavSelection,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  sidebarActivityKey,
  sortSidebarSessionRows,
} from './sidebarState.js'
import {
  createWorkspaceOrder,
  readWorkspaceOrderFromStorage,
  reduceWorkspaceOrderMoved,
  reduceWorkspaceOrderStepped,
  selectOrderedWorkspaceGroups,
  selectWorkspaceDropEdge,
  WORKSPACE_ORDER_DRAG_MIME,
  writeWorkspaceOrderToStorage,
  type WorkspaceDropEdge,
  type WorkspaceOrder,
} from './sidebarWorkspaceOrder.js'
import {
  groupByWorkspace,
  type MergedSessionRow,
  type WorkspaceGroup,
} from './sessionsCatalogState.js'

// Rail geometry + hover timing, matching the prototype (RAIL_W/FULL_W/delays).
const HOVER_DELAY = 120
const HIDE_DELAY = 200

/**
 * Max session rows a workspace group shows before a "Show N more" toggle
 * (operator, 2026-07-14: one project's session list grew long enough to bury the
 * rest of the rail). NOT a prototype element — a deliberate declutter deviation.
 * The active session is always kept visible even when it falls past the cap.
 */
const SIDEBAR_GROUP_ROW_LIMIT = 6

type OrderStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The renderer's own `localStorage`, or `null` under SSR / a locked-down
 * renderer — the `ReasoningLayoutProvider.tsx:26-33` helper, verbatim. */
function defaultOrderStorage(): OrderStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The callbacks a workspace group needs to take part in reordering. Passed as
 * one optional object (the `onOpenRowActions` idiom: additive, so a headless
 * test that omits it renders the pre-existing, non-draggable header).
 */
export type WorkspaceReorderHandlers = {
  onDragStart: (cwd: string) => void
  onDragOver: (cwd: string) => void
  /** The pointer left this group entirely — clear its drop indicator, which
   * otherwise stays painted over a group release will not drop onto. */
  onDragLeave: (cwd: string) => void
  onDrop: (cwd: string) => void
  onDragEnd: () => void
  onStep: (cwd: string, direction: 'up' | 'down') => void
}

type NavItem = {
  id: 'chat' | 'sessions' | 'goals' | 'accounts' | 'settings'
  label: string
  /** Wired to a built view. Unbuilt destinations render disabled + flagged. */
  enabled: boolean
  icon: ReactNode
}

// The prototype's destination rail (Chat/Sessions/Goals/Accounts/Settings — its
// own comments already dropped Tasks/Agents from the rail). Orchestrator is a
// per-session chat mode in the prototype, not a nav destination, so it has no
// rail entry (the standalone Orchestrator page was removed 2026-07-14).
const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', enabled: true, icon: <ChatIcon /> },
  { id: 'sessions', label: 'Sessions', enabled: true, icon: <SessionsIcon /> },
  { id: 'goals', label: 'Goals', enabled: true, icon: <GoalsIcon /> },
  { id: 'accounts', label: 'Accounts', enabled: true, icon: <AccountsIcon /> },
  { id: 'settings', label: 'Settings', enabled: true, icon: <SettingsIcon /> },
]

type SidebarView = 'chat' | 'sessions' | 'goals' | 'accounts' | 'settings'

export function Sidebar({
  rows,
  activeSessionId,
  activeView,
  onSelectView,
  onSelectLive,
  onRestore,
  onOpenHistory,
  onOpenRowActions,
  onNewSessionInWorkspace,
  modelForSession,
  menuActive = false,
  storage,
}: {
  rows: MergedSessionRow[]
  activeSessionId: SessionId | null
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
  /**
   * SESSIONS-UNIFICATION — open a terminal-created history row by its ENGINE
   * session id (the Part-A host path). Called only for a history row whose
   * workspace is resolvable; the renderer authors no cwd (HC1).
   */
  onOpenHistory: (engineSessionId: string) => void
  /**
   * #11 — open the SAME target-session-bound `SessionActionsMenu` the TabBar uses,
   * for THIS row's session (mirrors TabBar's `onOpenActions`). Optional + additive:
   * the ⋮ kebab + right-click render only when wired, so headless tests that omit
   * it are untouched. App owns the single menu instance; the row only raises the
   * anchor (the kebab's rect, or the pointer coords on right-click).
   */
  onOpenRowActions?: (
    sessionId: SessionId,
    anchor: { top: number; left: number },
  ) => void
  /**
   * #10/#15 — the per-workspace "+" (new session DIRECTLY in this workspace, no
   * picker). Called with a REGISTRY id representing the group (its active row if
   * present, else its first row); the host re-derives + re-validates that row's
   * cwd from its OWN registry and spawns a fresh session there (HC1/T8 — the
   * renderer never authors a cwd). Optional + additive: the "+" renders only when
   * wired.
   */
  onNewSessionInWorkspace?: (repId: SessionId) => void
  /** Resolved model for a session (the subtitle's "· model", prototype grammar);
   * null when unknown — e.g. a restorable row that never attached this run. */
  modelForSession?: (id: SessionId) => string | null
  /**
   * P4-33 (the prototype's `menuActive`, Sidebar.jsx:80) — true while an overlay
   * ANCHORED TO A ROW HERE is open (the ⋮ actions menu or the rename editor).
   * Those render as App-level `fixed` overlays outside this rail's hover box, so
   * without this the pointer moving toward one fires `onMouseLeave` and collapses
   * the sidebar out from under a menu still anchored to a now-hidden row.
   *
   * App passes false for a TabBar-raised menu even though it shares the same
   * state: pinning the rail open for a tab's ⋯ would slide it over the transcript
   * with nothing here to anchor.
   */
  menuActive?: boolean
  /** Where the operator's workspace order is persisted. Injectable for tests
   * (`ReasoningLayoutProvider`'s `storage` prop idiom); defaults to the
   * renderer's own `localStorage`, and `null` disables persistence entirely. */
  storage?: OrderStorage | null
}) {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  )
  const orderStore = storage === undefined ? defaultOrderStorage() : storage
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrder>(
    () => readWorkspaceOrderFromStorage(orderStore) ?? createWorkspaceOrder(),
  )
  /** The in-flight header drag: the group being dragged and the one under the
   * pointer. Only the indicator reads it; the order itself changes on drop. */
  const [headerDrag, setHeaderDrag] = useState<{
    from: string
    over: string
  } | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The rail element, so the backdrop-close re-collapse can ask whether the
   * pointer is genuinely still over it (Sidebar.jsx:106 `sbRef`). */
  const asideRef = useRef<HTMLElement | null>(null)
  /** Live workspace-header buttons by cwd, and the one a keyboard step just
   * moved — see the re-focus effect below `reorderHandlers`. */
  const headerRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocusCwd = useRef<string | null>(null)

  const open = pinned || hovering || menuActive

  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovering(true), HOVER_DELAY)
  }
  const onLeave = () => {
    if (showTimer.current) clearTimeout(showTimer.current)
    // Don't start the hide timer while a row's menu/rename is open
    // (Sidebar.jsx:99). Reaching for that menu means leaving the rail.
    if (menuActive) return
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY)
  }
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  // When that overlay CLOSES, its full-screen backdrop swallowed the click, so
  // the pointer is wherever the menu was with no `onMouseLeave` to follow and
  // `hovering` still true — the rail would stay expanded indefinitely. Re-collapse
  // unless the pointer really is back over the rail, or it is pinned
  // (Sidebar.jsx:103-111). `:hover` is the only honest answer here; React has no
  // synthetic event for "pointer is still inside after an unrelated unmount".
  useEffect(() => {
    if (menuActive || pinned) return
    const el = asideRef.current
    if (el && typeof el.matches === 'function' && el.matches(':hover')) return
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY)
  }, [menuActive, pinned])

  const query = search.trim().toLowerCase()
  // Sort (CC-2 warp-free activity order) → filter → group. Recomputes only when
  // the roster, the query, or the active session changes — not on every hover /
  // pin / group-collapse re-render (frequent, and leaving the grouping identical).
  // The active session's cwd only MARKS its workspace group (`current`); group
  // order is frozen-alphabetical and activeCwd-free (shared `groupByWorkspace`,
  // which also collects empty-cwd rows under one clearly labeled "Unknown
  // workspace" bucket rather than a blank header).
  const activeCwd = useMemo(
    () =>
      activeSessionId == null
        ? null
        : rows.find(row => row.appSessionId === activeSessionId)?.cwd ?? null,
    [rows, activeSessionId],
  )
  // Hide dead-workspace history rows from the rail (bug-sweep #1) BEFORE the
  // text filter/group — registry rows and empty-cwd "Unknown workspace" rows
  // stay (`isSidebarVisibleRow`). The Sessions page is unaffected (lists all).
  const railRows = useMemo(
    () => sortSidebarSessionRows(rows).filter(isSidebarVisibleRow),
    [rows],
  )
  // ➕ The operator's custom order is applied HERE, on the sidebar side of the
  // shared selector — `groupByWorkspace` itself stays frozen-alphabetical for
  // the Sessions page, which uses the same call.
  //
  // The UNFILTERED group sequence. A reorder is expressed against what is on
  // screen, but it FREEZES this one, so groups the search box is hiding keep
  // their current position instead of falling behind the two that were dragged.
  const allGroups = useMemo(
    () =>
      selectOrderedWorkspaceGroups(
        groupByWorkspace(railRows, activeCwd),
        workspaceOrder,
      ),
    [railRows, activeCwd, workspaceOrder],
  )
  const groups = useMemo(() => {
    if (!query) return allGroups
    const filtered = railRows.filter(
      row =>
        row.displayLabel.toLowerCase().includes(query) ||
        row.cwd.toLowerCase().includes(query),
    )
    return selectOrderedWorkspaceGroups(
      groupByWorkspace(filtered, activeCwd),
      workspaceOrder,
    )
  }, [allGroups, railRows, query, activeCwd, workspaceOrder])

  // The rendered sequence a reorder is expressed against (what the operator is
  // looking at, search filter included).
  const groupCwds = useMemo(() => groups.map(group => group.cwd), [groups])
  const allGroupCwds = useMemo(
    () => allGroups.map(group => group.cwd),
    [allGroups],
  )

  const commitWorkspaceOrder = (next: WorkspaceOrder) => {
    if (next === workspaceOrder) return
    setWorkspaceOrder(next)
    writeWorkspaceOrderToStorage(orderStore, next)
  }

  const reorderHandlers: WorkspaceReorderHandlers = {
    onDragStart: cwd => setHeaderDrag({ from: cwd, over: cwd }),
    onDragOver: cwd =>
      setHeaderDrag(drag =>
        drag == null || drag.over === cwd ? drag : { ...drag, over: cwd },
      ),
    // Park the indicator back on the dragged group itself (which draws none, a
    // group cannot drop onto itself), so it is never left promising a landing
    // spot the pointer has already left.
    onDragLeave: cwd =>
      setHeaderDrag(drag =>
        drag == null || drag.over !== cwd ? drag : { ...drag, over: drag.from },
      ),
    onDrop: cwd => {
      if (headerDrag) {
        commitWorkspaceOrder(
          reduceWorkspaceOrderMoved(
            workspaceOrder,
            groupCwds,
            headerDrag.from,
            cwd,
            allGroupCwds,
          ),
        )
      }
      setHeaderDrag(null)
    },
    onDragEnd: () => setHeaderDrag(null),
    onStep: (cwd, direction) => {
      const next = reduceWorkspaceOrderStepped(
        workspaceOrder,
        groupCwds,
        cwd,
        direction,
        allGroupCwds,
      )
      if (next === workspaceOrder) return
      // React's keyed diff moves the stepped header by re-inserting its node,
      // which drops focus to the body — so a second ⌥↓ would go nowhere. Ask
      // for it back once the new order has rendered.
      refocusCwd.current = cwd
      commitWorkspaceOrder(next)
    },
  }

  useLayoutEffect(() => {
    const cwd = refocusCwd.current
    if (cwd == null) return
    refocusCwd.current = null
    headerRefs.current.get(cwd)?.focus()
  }, [workspaceOrder])

  return (
    <>
      {/* Spacer reserves the collapsed rail's 48px footprint in the flex flow;
       * the rail itself floats (fixed) and expands OVER the content on hover. */}
      <div className="w-12 shrink-0" aria-hidden="true" />

      <aside
        ref={asideRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        aria-label="Primary"
        className={
          'fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden border-r border-white/[0.05] bg-surface-panel transition-[width,box-shadow] duration-200 ease-out ' +
          (open ? 'w-60 shadow-[4px_0_24px_rgba(0,0,0,0.45)]' : 'w-12')
        }
      >
        {/* Logo + pin */}
        <div
          className={
            'flex h-[50px] shrink-0 items-center ' +
            (open ? 'justify-between pl-4 pr-2.5' : 'justify-center')
          }
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex text-accent">
              <PawLogo />
            </span>
            {open ? (
              <span className="truncate text-[13px] font-semibold tracking-tight text-text-primary">
                Cat Code
              </span>
            ) : null}
          </div>
          {open ? (
            <button
              type="button"
              onClick={() => setPinned(value => !value)}
              title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              aria-pressed={pinned}
              className={
                'flex h-[22px] w-[22px] items-center justify-center rounded ' +
                (pinned
                  ? 'bg-accent/[0.12] text-accent'
                  : 'text-text-faint hover:text-text-muted')
              }
            >
              <PinIcon />
            </button>
          ) : null}
        </div>

        {open ? (
          <>
            {/* Search */}
            <div className="shrink-0 px-2.5 pb-2.5">
              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 flex -translate-y-1/2 text-text-faint">
                  <SearchIcon />
                </span>
                <input
                  type="text"
                  aria-label="Search sessions"
                  placeholder="Search sessions…"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  className="w-full rounded-lg border border-white/[0.07] bg-white/[0.04] py-1.5 pl-[26px] pr-2 text-xs text-[#d4d4d8] outline-none placeholder:text-text-subtle focus:border-accent/35"
                />
              </div>
            </div>

            {/* Session groups (by workspace / cwd) */}
            <div
              aria-label="Sessions"
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {groups.length === 0 ? (
                <p className="px-2 py-2 text-xs text-text-subtle">
                  {rows.length === 0 ? 'No sessions yet.' : 'No matches.'}
                </p>
              ) : (
                groups.map(group => (
                  <SessionGroup
                    key={group.cwd}
                    group={group}
                    activeSessionId={activeSessionId}
                    collapsed={collapsedGroups[group.cwd] ?? false}
                    onToggle={() =>
                      setCollapsedGroups(prev => ({
                        ...prev,
                        [group.cwd]: !(prev[group.cwd] ?? false),
                      }))
                    }
                    onSelectLive={onSelectLive}
                    onRestore={onRestore}
                    onOpenHistory={onOpenHistory}
                    onOpenRowActions={onOpenRowActions}
                    onNewSessionInWorkspace={onNewSessionInWorkspace}
                    modelForSession={modelForSession}
                    reorder={reorderHandlers}
                    headerRef={element => {
                      if (element) headerRefs.current.set(group.cwd, element)
                      else headerRefs.current.delete(group.cwd)
                    }}
                    dragging={headerDrag?.from === group.cwd}
                    dropEdge={
                      headerDrag != null && headerDrag.over === group.cwd
                        ? selectWorkspaceDropEdge(
                            groupCwds,
                            headerDrag.from,
                            group.cwd,
                          )
                        : null
                    }
                  />
                ))
              )}
            </div>

            {/* Nav destinations (expanded) */}
            <nav
              aria-label="Views"
              className="shrink-0 border-t border-shell-seam px-2 pb-3 pt-2"
            >
              {NAV.map(item => (
                <NavItemExpanded
                  activeView={activeView}
                  item={item}
                  key={item.id}
                  onSelectView={onSelectView}
                />
              ))}
            </nav>
          </>
        ) : (
          /* Collapsed rail: nav icons only, anchored to the bottom. */
          <nav
            aria-label="Views"
            className="mt-auto flex flex-col items-center gap-1 pb-3 pt-2"
          >
            {NAV.map(item => (
              <NavItemRail
                activeView={activeView}
                item={item}
                key={item.id}
                onSelectView={onSelectView}
              />
            ))}
          </nav>
        )}
      </aside>
    </>
  )
}

// Workspace grouping (frozen-alphabetical by the rendered label; empty-cwd in one
// "Unknown workspace" bucket) is the shared `groupByWorkspace` from
// `sessionsCatalogState` — the SAME selector the Sessions page uses, so both
// surfaces group AND label the unified roster identically (no local dup).

// Exported for SSR tests: the sidebar collapses to the rail by default
// (`open = pinned || hovering`, both false under renderToStaticMarkup), so the
// expanded group header (#10 "+") and rows (#11 ⋮) are only reachable by
// rendering these subcomponents directly (SessionActionsMenu.test idiom).
export function SessionGroup({
  group,
  activeSessionId,
  collapsed,
  onToggle,
  onSelectLive,
  onRestore,
  onOpenHistory,
  onOpenRowActions,
  onNewSessionInWorkspace,
  modelForSession,
  reorder,
  headerRef,
  dragging = false,
  dropEdge = null,
}: {
  group: WorkspaceGroup
  activeSessionId: SessionId | null
  collapsed: boolean
  onToggle: () => void
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
  onOpenHistory: (engineSessionId: string) => void
  onOpenRowActions?: (
    sessionId: SessionId,
    anchor: { top: number; left: number },
  ) => void
  onNewSessionInWorkspace?: (repId: SessionId) => void
  modelForSession?: (id: SessionId) => string | null
  /** ➕ workspace reordering (operator, 2026-07-26). Optional + additive: the
   * header is a plain, non-draggable header when this is absent. */
  reorder?: WorkspaceReorderHandlers
  /** The header button, so a keyboard step can put focus back on the workspace
   * it just moved (the TabBar's per-tab `ref` idiom). */
  headerRef?: (element: HTMLButtonElement | null) => void
  /** This group is the one being dragged (drawn dimmed). */
  dragging?: boolean
  /** This group is the drop target; which edge the dragged group would land on. */
  dropEdge?: WorkspaceDropEdge | null
}) {
  // "Show more" cap — a long single-project session list buries the rest of the
  // rail. Pure logic (tested in sidebarState.test) keeps the active session
  // visible even when it falls past the cap.
  const [expanded, setExpanded] = useState(false)
  const {
    visible: visibleRows,
    hiddenCount,
    overLimit,
  } = selectVisibleSidebarRows(
    group.rows,
    row => row.appSessionId != null && row.appSessionId === activeSessionId,
    SIDEBAR_GROUP_ROW_LIMIT,
    expanded,
  )

  useEffect(() => {
    setExpanded(value => normalizeSidebarGroupExpansion(value, overLimit))
  }, [overLimit])

  // #15 — the per-workspace "+" needs a REGISTRY id to name (HC1: the host
  // re-derives the cwd from a registry row, never a renderer path). A
  // pure-terminal-history group has no such id, so its "+" is hidden.
  const repId =
    group.rows.find(r => r.appSessionId === activeSessionId)?.appSessionId ??
    group.rows.find(r => r.appSessionId != null)?.appSessionId ??
    null

  // ➕ Reordering is offered for a real workspace only — the "Unknown workspace"
  // bucket (cwd === '') is pinned last by `selectOrderedWorkspaceGroups` and is
  // neither a drag source nor a drop target.
  const reorderable = reorder != null && group.cwd.trim().length > 0

  return (
    /* The WHOLE group (header + rows + "Show more") is the drop target, not just
     * the ~20px header strip: the pointer spends most of a drag over the session
     * rows, and a dragover the rows swallowed left a stale indicator painted on a
     * group that release would not have dropped onto. It is also what physically
     * MOVES, so the drop indicator belongs on its edges too. */
    <div
      className="relative mb-4"
      onDragOver={
        reorderable
          ? event => {
              // Only a workspace drag is accepted — a tab dragged for a split
              // carries `text/sessionId` and must fall through untouched.
              if (
                !event.dataTransfer.types.some(
                  type => type.toLowerCase() === WORKSPACE_ORDER_DRAG_MIME,
                )
              ) {
                return
              }
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              reorder?.onDragOver(group.cwd)
            }
          : undefined
      }
      onDragLeave={
        reorderable
          ? event => {
              // `dragleave` also fires when the pointer crosses between this
              // group's own children; only a move OUT of the group counts.
              const entering = event.relatedTarget as Node | null
              if (entering && event.currentTarget.contains(entering)) return
              reorder?.onDragLeave(group.cwd)
            }
          : undefined
      }
      onDrop={
        reorderable
          ? event => {
              event.preventDefault()
              reorder?.onDrop(group.cwd)
            }
          : undefined
      }
    >
      {/* Drop indicator — a static 2px accent rule on the edge the dragged
       * group would land on, matching the TabBar's active-tab underline
       * idiom (`TabBar.tsx:271`). Static classes only: an interpolated
       * arbitrary-value class silently no-ops in this Tailwind v4 setup. */}
      {dropEdge === 'before' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-0 h-[2px] rounded-full bg-accent"
        />
      ) : null}
      {dropEdge === 'after' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-accent"
        />
      ) : null}
      {/* Header row: collapse toggle (flex-1) + the #10 per-workspace "+" so the
       * "+" sits flush-right of the workspace label (prototype Sidebar.jsx:219).
       * ➕ The row is also the workspace drag handle. */}
      <div
        className={
          'flex select-none items-center gap-1 px-1 pb-1.5 pt-0.5 ' +
          (reorderable ? 'cursor-grab ' : '') +
          (dragging ? 'opacity-50' : '')
        }
        draggable={reorderable ? true : undefined}
        onDragStart={
          reorderable
            ? event => {
                event.dataTransfer.setData(
                  WORKSPACE_ORDER_DRAG_MIME,
                  group.cwd,
                )
                event.dataTransfer.effectAllowed = 'move'
                reorder?.onDragStart(group.cwd)
              }
            : undefined
        }
        onDragEnd={reorderable ? () => reorder?.onDragEnd() : undefined}
      >
        <button
          type="button"
          ref={headerRef}
          // Also draggable so the whole label — not just the header's padding —
          // is a grab surface; `dragstart` bubbles, so the row above owns the
          // one handler.
          draggable={reorderable ? true : undefined}
          onClick={onToggle}
          onKeyDown={
            reorderable
              ? event => {
                  // Keyboard path for a drag-only affordance: ⌥↑/⌥↓ moves the
                  // workspace one slot. The header is already focusable, and
                  // Alt+Arrow is unclaimed elsewhere in the renderer.
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
                    return
                  }
                  if (!event.altKey) return
                  event.preventDefault()
                  reorder?.onStep(
                    group.cwd,
                    event.key === 'ArrowUp' ? 'up' : 'down',
                  )
                }
              : undefined
          }
          aria-expanded={!collapsed}
          aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          title={
            reorderable
              ? `${group.cwd}. Drag to reorder, or ⌥↑/⌥↓`
              : group.cwd || 'Sessions with no recorded workspace'
          }
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          <span
            className={
              'flex shrink-0 text-text-faint transition-transform ' +
              (collapsed ? '-rotate-90' : '')
            }
          >
            <ChevronIcon />
          </span>
          <span className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-text-faint">
            {group.name}
          </span>
        </button>
        {onNewSessionInWorkspace && repId ? (
          <button
            type="button"
            onClick={() => onNewSessionInWorkspace(repId)}
            title="New session in this workspace"
            aria-label="New session in this workspace"
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-white/8 text-text-faint transition-colors hover:border-accent/40 hover:text-accent"
          >
            <PlusIcon />
          </button>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {visibleRows.map(row => (
            <SidebarRowItem
              key={row.sessionId}
              row={row}
              isActive={
                row.appSessionId != null &&
                row.appSessionId === activeSessionId
              }
              onSelectLive={onSelectLive}
              onRestore={onRestore}
              onOpenHistory={onOpenHistory}
              onOpenRowActions={onOpenRowActions}
              modelForSession={modelForSession}
            />
          ))}
          {shouldShowSidebarGroupExpansionToggle(
            expanded,
            hiddenCount,
            overLimit,
          ) ? (
            <button
              type="button"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 pl-[26px] text-[11px] font-medium text-text-faint transition-colors hover:bg-shell-hover hover:text-text-muted"
            >
              {expanded ? 'Show less' : `Show ${hiddenCount} more`}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

// Exported for SSR tests (see SessionGroup note): the #11 ⋮ kebab lives here.
export function SidebarRowItem({
  row,
  isActive,
  onSelectLive,
  onRestore,
  onOpenHistory,
  onOpenRowActions,
  modelForSession,
}: {
  row: MergedSessionRow
  isActive: boolean
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
  onOpenHistory: (engineSessionId: string) => void
  onOpenRowActions?: (
    sessionId: SessionId,
    anchor: { top: number; left: number },
  ) => void
  modelForSession?: (id: SessionId) => string | null
}) {
  const visual = deriveMergedRowVisual(row)
  const title = row.displayLabel
  const appSessionId = row.appSessionId
  // CC-2 recency: last MESSAGE SENT for a registry row (falling back to createdAt),
  // the transcript mtime for a history row — `sidebarActivityKey` folds both, and
  // never `lastAttachedAt` (open/attach bumps that; see `sidebarState.ts`).
  const recency = formatRecency(sidebarActivityKey(row))
  // The prototype's subtitle is `time · model` (Sidebar.jsx:271). Only a registry
  // row that attached this run has a known model; a history row shows none.
  const model = appSessionId != null ? modelForSession?.(appSessionId) ?? null : null
  const shortModel = model ? model.split('-').slice(-1)[0] : null

  const openable = visual.openable
  const showActions = onOpenRowActions != null && appSessionId != null

  // A live registry row focuses its tab; a restorable row re-spawns via restore;
  // a resolvable history row opens by its ENGINE id (Part-A host path); a
  // browse-only row (no recorded workspace) does nothing.
  const activate = () => {
    if (visual.intent === 'open-history') {
      onOpenHistory(row.sessionId)
      return
    }
    if (appSessionId == null) return
    if (visual.intent === 'restore') onRestore(appSessionId)
    else if (visual.intent === 'select') onSelectLive(appSessionId)
  }

  return (
    <div
      className={
        'group relative flex select-none items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ' +
        (openable ? 'cursor-pointer ' : 'cursor-default ') +
        (isActive
          ? 'border-accent/[0.18] bg-accent/[0.09]'
          : openable
            ? 'border-transparent hover:border-accent/[0.22] hover:bg-accent/[0.07]'
            : 'border-transparent')
      }
      role="button"
      tabIndex={openable ? 0 : -1}
      aria-current={isActive ? 'true' : undefined}
      aria-disabled={openable ? undefined : 'true'}
      aria-label={`session ${title}, ${visual.label}${openable ? '' : ', open from terminal'}`}
      title={
        openable
          ? `${row.cwd || title}${
              visual.kind === 'restorable'
                ? ' · restore'
                : visual.kind === 'history'
                  ? ' · open'
                  : ''
            }`
          : 'This session has no recorded workspace. Open it from the terminal.'
      }
      onClick={openable ? activate : undefined}
      onContextMenu={
        showActions
          ? event => {
              // #11 — right-click opens the row's actions menu at the pointer
              // (prototype Sidebar.jsx:245); suppress the native context menu.
              event.preventDefault()
              event.stopPropagation()
              if (onOpenRowActions && appSessionId != null) {
                onOpenRowActions(appSessionId, {
                  top: event.clientY,
                  left: event.clientX,
                })
              }
            }
          : undefined
      }
      onKeyDown={
        openable
          ? event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                activate()
              }
            }
          : undefined
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={
              'truncate text-xs font-medium ' +
              (isActive
                ? 'text-[#fce7f3]'
                : openable
                  ? 'text-[#c4c4c8] group-hover:text-text-primary'
                  : 'text-text-subtle')
            }
          >
            {title}
          </span>
        </div>
        {recency || shortModel ? (
          <div className="flex items-center gap-[5px] text-[10px] text-text-faint">
            {recency ? <span className="shrink-0">{recency}</span> : null}
            {recency && shortModel ? (
              <span className="text-text-ghost">·</span>
            ) : null}
            {shortModel ? <span className="truncate">{shortModel}</span> : null}
          </div>
        ) : null}
      </div>

      {/* #11 — hover-revealed ⋮ kebab: opens the SAME target-session-bound
       * SessionActionsMenu the TabBar uses (App owns the instance). Registry rows
       * only — a history row has no desktop session to act on. */}
      {showActions ? (
        <button
          type="button"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-text-subtle opacity-0 transition-[opacity,background-color,color] hover:bg-accent/[0.16] hover:text-accent-soft group-hover:opacity-100 focus-visible:opacity-100"
          onClick={event => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            if (onOpenRowActions && appSessionId != null) {
              onOpenRowActions(appSessionId, {
                top: rect.bottom + 4,
                left: Math.max(8, rect.right - 232),
              })
            }
          }}
          // Keep key events off the row's activate handler (Enter/Space on the
          // kebab opens the menu, it must not also fire the row's onKeyDown).
          onKeyDown={event => event.stopPropagation()}
          title="Session actions"
          aria-label={`Session actions for ${title}`}
        >
          <KebabIcon />
        </button>
      ) : null}
    </div>
  )
}

function NavItemExpanded({
  item,
  activeView,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  if (!item.enabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={`${item.label} is not available yet`}
        className="flex w-full cursor-not-allowed items-center gap-1 rounded-md py-1.5 text-text-subtle/55"
      >
        <span className="flex h-5 w-8 shrink-0 items-center justify-center">
          {item.icon}
        </span>
        <span className="text-[13px]">{item.label}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        const view = resolveNavSelection(item)
        if (view) onSelectView(view)
      }}
      className={
        'flex w-full items-center gap-1 rounded-md py-1.5 ' +
        (active
          ? 'bg-accent/[0.09] text-accent-soft'
          : 'text-text-subtle hover:text-[#d4d4d8]')
      }
    >
      <span className="flex h-5 w-8 shrink-0 items-center justify-center">
        {item.icon}
      </span>
      <span className={'text-[13px] ' + (active ? 'font-medium' : '')}>
        {item.label}
      </span>
    </button>
  )
}

function NavItemRail({
  item,
  activeView,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  if (!item.enabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        aria-label={item.label}
        title={`${item.label} is not available yet`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-text-subtle/55"
      >
        {item.icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      title={item.label}
      onClick={() => {
        const view = resolveNavSelection(item)
        if (view) onSelectView(view)
      }}
      className={
        'flex h-8 w-8 items-center justify-center rounded-md ' +
        (active
          ? 'bg-accent/[0.12] text-accent-soft'
          : 'text-text-subtle hover:text-[#d4d4d8]')
      }
    >
      {item.icon}
    </button>
  )
}

/** Relative recency from `lastMessageSentAt` (the CC-2 message-sent signal),
 * falling back to `createdAt` — the real, source-backed subtitle (the
 * prototype's `time`); model/cost are NOT rendered (no real backing, C3). */
function formatRecency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/* ── Icons (ported from the prototype's inline SVGs; attribute-only, no CSS) ── */

function PawLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <ellipse cx="6.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="11.5" cy="4" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="16.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="4" cy="9.5" rx="1.4" ry="2" opacity=".45" />
      <path d="M12 21.5c-4.2 0-7.5-2.3-7.5-6 0-1.9 1.1-3.6 2.8-4.6.75-.45 1.6-.65 2.3-.65h.8c.7 0 1.55.2 2.3.65 1.7.95 2.8 2.7 2.8 4.6 0 3.7-3.3 6-7.5 6z" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function SessionsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function GoalsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

function AccountsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1V4H8v2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
      <path
        d="M2 3.5L5 6.5L8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** #10 per-workspace "+" glyph (prototype Sidebar.jsx:233). */
function PlusIcon() {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="5" y1="1" x2="5" y2="9" />
      <line x1="1" y1="5" x2="9" y2="5" />
    </svg>
  )
}

/** #11 per-row actions ⋮ glyph — three vertically-stacked dots (prototype
 * Sidebar.jsx:282, same grammar as the TabBar's ⋯ button). */
function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  )
}
