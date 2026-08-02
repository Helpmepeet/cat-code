/**
 * Sidebar — the shell's left rail: a hover-expanding rail (48px → 240px, pin,
 * shadow, easing), a paw logo, session search, a New chat action, a Pinned
 * section, workspace ("Projects") grouping by cwd, and a footer that carries the
 * active account plus the nav destinations.
 *
 * Design source (2026-08-01): the operator's Claude Design project "Cat Code
 * Sidebar", `components/sidebar/index.html`. It supersedes the older
 * `Sidebar.jsx` prototype grammar for THIS surface; anything it does not speak
 * to (recency subtitle, workspace reordering, the live dot) is unchanged from
 * the P4-4 true-up below.
 *
 * Data (SESSIONS-UNIFICATION — operator ruling 2026-07-20): it renders the
 * MERGED roster — desktop registry rows ∪ terminal-created history — via the
 * D5-blessed shared selector `selectMergedSessionRows` (App computes it as
 * `sessionCatalogRows`; no second merge). A registry row raises the same
 * switch/restore intents as before; a terminal-history row with a resolvable
 * workspace raises `onOpenHistory` (the Part-A host path, opening it by engine
 * id); a history row with no recorded workspace (MAJOR-1) is browse-only.
 *
 * §0 fidelity flags (divergences from the design source, by design):
 *  - ➕ KEPT, not in the design source: the `time · model` subtitle and the O1
 *    live dot. The design source's rows are title-only because its sample data
 *    carries no timestamps or models at all, not because the operator asked for
 *    the subtitle to go; dropping real, already-shipped information on that
 *    reading would be a silent cut. Both stay.
 *  - 🔁 adapted: the design source also drags SESSION rows to reorder them
 *    inside a project. That is not built. A manual per-project row order would
 *    fight the CC-2 float-to-top ruling (a row rises only when its session sends
 *    a message, `sidebarState.ts`), and the two orders cannot both win. Manual
 *    ordering IS offered where it is the only sensible order: inside the Pinned
 *    section, which exists for exactly that.
 *  - 🔁 adapted: "New chat" opens a session in the ACTIVE workspace with no
 *    picker, falling back to the picker when nothing is open. The design source
 *    leaves the button unwired; a session here cannot exist without a workspace,
 *    and the picker is already what the Projects "+" does, so making both open
 *    it would give the rail two identical buttons.
 *  - Rows render NO visible status chip: the design source's rows are bare, and
 *    the operator ruled out per-row status labels (2026-07-20). Status TEXT
 *    stays in the `aria-label` only (the O1 dot below is unlabeled, and is the
 *    single exception). A browse-only history row is still non-interactive.
 *  - The per-workspace "+" renders only for a group that has at least one
 *    registry row to name (HC1: createSessionInWorkspace needs a registry id,
 *    not a path); a pure-terminal-history workspace has no such id, so its "+"
 *    is hidden (🔁 adapted — a fresh session there still goes via ⌘T / picker).
 *  - ➕ real-added, and a deliberate departure (operator ruling O1, 2026-07-31):
 *    a single small unlabeled dot on LIVE rows, absent otherwise. It is the
 *    minimum exception to the 2026-07-20 bare-row ruling, matching the standing
 *    live-vs-not-live target with no text. Its BOUND: no chip, no status word,
 *    no per-state colour vocabulary, and nothing at all on a row that is not
 *    live. Liveness is read from `row.live` (`sessionsCatalogState.ts:200` — a
 *    registry row with a running process), NOT `deriveMergedRowVisual().kind`,
 *    which also calls a non-restorable `exited` row live. Decorative
 *    (`aria-hidden`): the state is already in the row's `aria-label`, and a
 *    second announcement would be a duplicate. It sits in a fixed leading lane
 *    that EVERY row reserves, centred on the title's line box, so its presence
 *    never reflows the title or the `time · model` line. Richer per-state status
 *    still surfaces on the TabBar.
 *  - All five nav destinations are wired: Chat, Sessions (P4-6a), Goals,
 *    Accounts (P4-5), and Settings. None are mocked. They now live behind the
 *    footer's unfold toggle (the design source's placement) rather than as a
 *    permanently-open list; the COLLAPSED rail still shows all five as icons, so
 *    no destination is ever more than one click away.
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
 *    drag-reorderable, and the chosen order persists across restarts. The order
 *    is renderer-local (`sidebarWorkspaceOrder.ts`), keyed on `cwd` (never the
 *    derived label), applied on the SIDEBAR side of the shared
 *    `groupByWorkspace` so the Sessions page keeps frozen-alphabetical, and it
 *    never consults `activeCwd` — CC-2 warp-freedom is intact. The Pinned
 *    section's order works the same way (`sidebarPinnedSessions.ts`).
 *  - Session ROWS inside a project group are NOT reorderable, deliberately. A
 *    group is an unbounded, auto-generated activity feed, so a manual order over
 *    it cannot be stored: persisting the whole sequence needs a cap, and a cap
 *    splits the list into remembered and forgotten halves. That shipped on
 *    2026-08-01 with a 64-id cap and inverted the rail on the first project to
 *    exceed it — 168 sessions meant the 64 newest were held in an arrangement
 *    below the 104 oldest, so the group read "22d" at the top while the real
 *    newest row sat far below. Raising the cap defers that; it cannot fix it.
 *    Manual sequencing therefore lives in exactly ONE place, the Pinned section
 *    (`sidebarPinnedSessions.ts` — "the one place in the rail where the operator,
 *    not activity, decides the sequence"), whose list is short and operator-
 *    authored, so a total order over it is legitimate. Inside a group, CC-2
 *    activity order is the only rule. Reverted 2026-08-02.
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
import { usePopoverFocus } from './overlayFocus.js'
import {
  SESSION_ACTIONS_MENU_WIDTH,
  placeSessionActionsMenu,
  type SessionActionsAnchor,
} from './sessionActions.js'
import {
  createHiddenWorkspaces,
  readHiddenWorkspacesFromStorage,
  reduceHiddenWorkspacesCleared,
  reduceWorkspaceHidden,
  selectVisibleWorkspaceGroups,
  writeHiddenWorkspacesToStorage,
  type HiddenWorkspaces,
} from './sidebarHiddenWorkspaces.js'
import {
  deriveMergedRowVisual,
  isSidebarVisibleRow,
  normalizeSidebarGroupExpansion,
  resolveNavSelection,
  selectSidebarNavFocusHandoff,
  selectSidebarOpen,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  sidebarActivityKey,
  sortSidebarSessionRows,
} from './sidebarState.js'
import {
  createPinnedSessions,
  isSessionPinned,
  PINNED_SESSION_DRAG_MIME,
  readPinnedSessionsFromStorage,
  reducePinnedSessionsMoved,
  reducePinnedSessionsStepped,
  reducePinnedSessionsToggled,
  selectPinnedDropEdge,
  selectPinnedRows,
  selectUnpinnedRows,
  writePinnedSessionsToStorage,
  type PinnedSessions,
} from './sidebarPinnedSessions.js'
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

// Rail geometry + hover timing, matching the design source (RAIL_W/FULL_W/delays).
const HOVER_DELAY = 120
const HIDE_DELAY = 200

/**
 * Max session rows a workspace group shows before a "Show N more" toggle
 * (operator, 2026-07-14: one project's session list grew long enough to bury the
 * rest of the rail). The active session is always kept visible even when it
 * falls past the cap.
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

/**
 * The same shape for a session ROW, keyed on the merge id instead of a cwd, plus
 * the drag type that scopes it. The Pinned section is the only reorderable row
 * list; `mime` still scopes the drag so a pinned row never lights up a drop edge
 * on a project row, which it would never land on. The caller binds the list; the
 * row only reports what happened to it.
 *
 * Project groups are deliberately NOT reorderable — see the header note on
 * activity order being the single rule inside a group.
 */
/** Which side of the hovered row the dragged row would land on
 * (`sidebarPinnedSessions`). */
export type RowDropEdge = 'before' | 'after'

export type RowReorderHandlers = {
  /** The drag payload type this list accepts, and nothing else. */
  mime: string
  onDragStart: (sessionId: string) => void
  onDragOver: (sessionId: string) => void
  onDragLeave: (sessionId: string) => void
  onDrop: (sessionId: string) => void
  onDragEnd: () => void
  onStep: (sessionId: string, direction: 'up' | 'down') => void
}

type NavItem = {
  id: 'chat' | 'sessions' | 'goals' | 'accounts' | 'settings'
  label: string
  /** Wired to a built view. Unbuilt destinations render disabled + flagged. */
  enabled: boolean
  icon: ReactNode
}

// The design source's destination list (Chat/Sessions/Goals/Accounts/Settings).
// Orchestrator is a per-session chat mode, not a nav destination, so it has no
// rail entry (the standalone Orchestrator page was removed 2026-07-14).
const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', enabled: true, icon: <ChatIcon /> },
  { id: 'sessions', label: 'Sessions', enabled: true, icon: <SessionsIcon /> },
  { id: 'goals', label: 'Goals', enabled: true, icon: <GoalsIcon /> },
  { id: 'accounts', label: 'Accounts', enabled: true, icon: <AccountsIcon /> },
  { id: 'settings', label: 'Settings', enabled: true, icon: <SettingsIcon /> },
]

/**
 * Per-item entrance delay for the footer's unfold, by NAV index. The list
 * unfolds UPWARD out of the toggle, so the item nearest the toggle (last) leads
 * and the topmost trails — the design source's reverse `nth-child` delays.
 *
 * A static map, never an interpolated `delay-[${n}ms]`: an arbitrary-value class
 * built at runtime silently no-ops in this Tailwind v4 setup (CLAUDE.md), and a
 * headless test cannot see the difference.
 */
const NAV_UNFOLD_DELAY = [
  'delay-[150ms]',
  'delay-[120ms]',
  'delay-[90ms]',
  'delay-[60ms]',
  'delay-[30ms]',
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
  onNewChat,
  onAddProject,
  accountAlias = null,
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
    anchor: SessionActionsAnchor,
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
  /** The "New chat" action above the list. App points it at the active
   * workspace, falling back to the picker (see the §0 flag in the header).
   * Optional + additive: the button renders only when wired. */
  onNewChat?: () => void
  /** The Projects header's "+": choose a folder, and the session created there
   * makes the group appear. The native picker path (`onNewSession` in App), so
   * no cwd is authored here. Optional + additive. */
  onAddProject?: () => void
  /** The active account's alias for the footer row, or null when no account is
   * resolved yet — in which case the footer shows only the nav toggle rather
   * than an empty avatar. */
  accountAlias?: string | null
  /** Resolved model for a session (the subtitle's "· model"); null when unknown
   * — e.g. a restorable row that never attached this run. */
  modelForSession?: (id: SessionId) => string | null
  /**
   * P4-33 — true while an overlay ANCHORED TO A ROW HERE is open (the ⋮ actions
   * menu or the rename editor). Those render as App-level `fixed` overlays
   * outside this rail's hover box, so without this the pointer moving toward one
   * fires `onMouseLeave` and collapses the sidebar out from under a menu still
   * anchored to a now-hidden row.
   *
   * App passes false for a TabBar-raised menu even though it shares the same
   * state: pinning the rail open for a tab's ⋯ would slide it over the transcript
   * with nothing here to anchor.
   */
  menuActive?: boolean
  /** Where the operator's workspace order and pins are persisted. Injectable for
   * tests (`ReasoningLayoutProvider`'s `storage` prop idiom); defaults to the
   * renderer's own `localStorage`, and `null` disables persistence entirely. */
  storage?: OrderStorage | null
}) {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  )
  const orderStore = storage === undefined ? defaultOrderStorage() : storage
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrder>(
    () => readWorkspaceOrderFromStorage(orderStore) ?? createWorkspaceOrder(),
  )
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSessions>(
    () => readPinnedSessionsFromStorage(orderStore) ?? createPinnedSessions(),
  )
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<HiddenWorkspaces>(
    () => readHiddenWorkspacesFromStorage(orderStore) ?? createHiddenWorkspaces(),
  )
  /** The open project menu: which workspace, and the trigger rect its panel is
   * placed against. One at a time, like the row ⋮. */
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    cwd: string
    name: string
    anchor: SessionActionsAnchor
  } | null>(null)
  /** The in-flight header drag: the group being dragged and the one under the
   * pointer. Only the indicator reads it; the order itself changes on drop. */
  const [headerDrag, setHeaderDrag] = useState<{
    from: string
    over: string
  } | null>(null)
  /** The same, for a row being dragged within the Pinned section. */
  const [pinDrag, setPinDrag] = useState<{ from: string; over: string } | null>(
    null,
  )
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The rail element, so the backdrop-close re-collapse can ask whether the
   * pointer is genuinely still over it. */
  const asideRef = useRef<HTMLElement | null>(null)
  /** Live workspace-header buttons by cwd, and the one a keyboard step just
   * moved — see the re-focus effect below `reorderHandlers`. */
  const headerRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocusCwd = useRef<string | null>(null)
  /** The same for session rows in BOTH reorderable lists (a row is the focusable
   * element, not a button). Keyed on the merge id, which is unique across the
   * rail, so one map serves the Pinned section and every group. */
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const refocusRowId = useRef<string | null>(null)
  /** Expanded nav buttons by destination, plus a collapsed rail destination
   * whose focus must survive the branch replacement. */
  const navRefs = useRef(new Map<NavItem['id'], HTMLButtonElement>())
  const refocusNavId = useRef<NavItem['id'] | null>(null)

  const open = selectSidebarOpen({
    pinned,
    hovering,
    menuActive,
    focusWithin,
  })

  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovering(true), HOVER_DELAY)
  }
  const onLeave = () => {
    if (showTimer.current) clearTimeout(showTimer.current)
    // Don't start the hide timer while a row's menu/rename is open. Reaching for
    // that menu means leaving the rail.
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
  // unless the pointer really is back over the rail, or it is pinned. `:hover` is
  // the only honest answer here; React has no synthetic event for "pointer is
  // still inside after an unrelated unmount".
  useEffect(() => {
    if (menuActive || pinned) return
    const el = asideRef.current
    if (el && typeof el.matches === 'function' && el.matches(':hover')) return
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY)
  }, [menuActive, pinned])

  // The unfolded destination list is a rail-width overlay of the footer; leaving
  // the rail collapses it, so it is never re-found mid-air on the next hover.
  useEffect(() => {
    if (!open) setNavOpen(false)
  }, [open])

  const query = search.trim().toLowerCase()
  // Sort (CC-2 warp-free activity order) → partition pins → filter → group.
  // Recomputes only when the roster, the query, the pins or the active session
  // changes — not on every hover / pin / group-collapse re-render (frequent, and
  // leaving the grouping identical). The active session's cwd only MARKS its
  // workspace group (`current`); group order is frozen-alphabetical and
  // activeCwd-free (shared `groupByWorkspace`, which also collects empty-cwd rows
  // under one clearly labeled "Unknown workspace" bucket rather than a blank
  // header).
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

  const matchesQuery = (row: MergedSessionRow) =>
    !query ||
    row.displayLabel.toLowerCase().includes(query) ||
    row.cwd.toLowerCase().includes(query)

  // A pinned session is LIFTED into its own section, never duplicated inside its
  // project group (the design source's `visibleRows`).
  const pinnedRows = useMemo(
    () => selectPinnedRows(railRows, pinnedSessions).filter(matchesQuery),
    [railRows, pinnedSessions, query],
  )
  const groupRows = useMemo(
    () => selectUnpinnedRows(railRows, pinnedSessions),
    [railRows, pinnedSessions],
  )

  // ➕ The operator's custom WORKSPACE order is applied HERE, on the sidebar side
  // of the shared selector — `groupByWorkspace` itself stays frozen-alphabetical
  // for the Sessions page, which uses the same call.
  //
  // The UNFILTERED group sequence. A reorder is expressed against what is on
  // screen, but it FREEZES this one, so groups the search box is hiding keep
  // their current position instead of falling behind the two that were dragged.
  //
  // A group's ROWS take no manual order at all: inside a project, CC-2 activity
  // order is the only rule (see the header note). Manual sequencing lives solely
  // in the Pinned section.
  const allGroups = useMemo(
    () =>
      selectOrderedWorkspaceGroups(
        groupByWorkspace(groupRows, activeCwd),
        workspaceOrder,
      ),
    [groupRows, activeCwd, workspaceOrder],
  )
  const groups = useMemo(() => {
    if (!query) return allGroups
    return selectOrderedWorkspaceGroups(
      groupByWorkspace(groupRows.filter(matchesQuery), activeCwd),
      workspaceOrder,
    )
  }, [allGroups, groupRows, query, activeCwd, workspaceOrder])

  // ➕ Projects the operator has hidden are held back HERE, after ordering and
  // filtering, so unhiding one drops it straight back into its ranked slot
  // (`allGroups`, which feeds the reorder freeze list, deliberately still counts
  // it). A group reports the CC-2 warp-free activity of its newest row, which is
  // what lets a hidden project resurface on real work but not on a mere open.
  // A PINNED session from a hidden project still shows in Pinned: an explicit
  // pin is a stronger statement than a hidden group.
  const { visible: visibleGroups, hidden: hiddenGroups } = useMemo(
    () =>
      selectVisibleWorkspaceGroups(groups, hiddenWorkspaces, group =>
        group.rows.reduce(
          (newest, row) => Math.max(newest, sidebarActivityKey(row)),
          0,
        ),
      ),
    [groups, hiddenWorkspaces],
  )

  // The rendered sequence a reorder is expressed against (what the operator is
  // looking at, search filter and hidden projects included).
  const groupCwds = useMemo(
    () => visibleGroups.map(group => group.cwd),
    [visibleGroups],
  )
  const allGroupCwds = useMemo(
    () => allGroups.map(group => group.cwd),
    [allGroups],
  )
  const pinnedIds = useMemo(
    () => pinnedRows.map(row => row.sessionId),
    [pinnedRows],
  )

  const commitWorkspaceOrder = (next: WorkspaceOrder) => {
    if (next === workspaceOrder) return
    setWorkspaceOrder(next)
    writeWorkspaceOrderToStorage(orderStore, next)
  }

  const commitPinnedSessions = (next: PinnedSessions) => {
    if (next === pinnedSessions) return
    setPinnedSessions(next)
    writePinnedSessionsToStorage(orderStore, next)
  }

  const commitHiddenWorkspaces = (next: HiddenWorkspaces) => {
    if (next === hiddenWorkspaces) return
    setHiddenWorkspaces(next)
    writeHiddenWorkspacesToStorage(orderStore, next)
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

  const pinnedReorderHandlers: RowReorderHandlers = {
    mime: PINNED_SESSION_DRAG_MIME,
    onDragStart: id => setPinDrag({ from: id, over: id }),
    onDragOver: id =>
      setPinDrag(drag =>
        drag == null || drag.over === id ? drag : { ...drag, over: id },
      ),
    onDragLeave: id =>
      setPinDrag(drag =>
        drag == null || drag.over !== id ? drag : { ...drag, over: drag.from },
      ),
    onDrop: id => {
      if (pinDrag) {
        commitPinnedSessions(
          reducePinnedSessionsMoved(
            pinnedSessions,
            pinnedIds,
            pinDrag.from,
            id,
          ),
        )
      }
      setPinDrag(null)
    },
    onDragEnd: () => setPinDrag(null),
    onStep: (id, direction) => {
      const next = reducePinnedSessionsStepped(
        pinnedSessions,
        pinnedIds,
        id,
        direction,
      )
      if (next === pinnedSessions) return
      refocusRowId.current = id
      commitPinnedSessions(next)
    },
  }

  const togglePin = (sessionId: string) =>
    commitPinnedSessions(
      reducePinnedSessionsToggled(pinnedSessions, sessionId),
    )

  useLayoutEffect(() => {
    const cwd = refocusCwd.current
    if (cwd == null) return
    refocusCwd.current = null
    headerRefs.current.get(cwd)?.focus()
  }, [workspaceOrder])

  // The Pinned list hands focus back to the row a keyboard step just moved.
  useLayoutEffect(() => {
    const id = refocusRowId.current
    if (id == null) return
    refocusRowId.current = null
    rowRefs.current.get(id)?.focus()
  }, [pinnedSessions])

  useLayoutEffect(() => {
    const navId = refocusNavId.current
    if (navId == null || !open) return
    refocusNavId.current = null
    navRefs.current.get(navId)?.focus()
  }, [open])

  const rowProps = {
    activeSessionId,
    onSelectLive,
    onRestore,
    onOpenHistory,
    onOpenRowActions,
    onTogglePin: togglePin,
    modelForSession,
  }

  return (
    <>
      {/* Spacer reserves the collapsed rail's 48px footprint in the flex flow;
       * the rail itself floats (fixed) and expands OVER the content on hover. */}
      <div className="w-12 shrink-0" aria-hidden="true" />

      <aside
        ref={asideRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocusCapture={event => {
          const target = event.target
          const focusedNavId =
            target instanceof HTMLElement
              ? (NAV.find(
                  item => item.id === target.dataset.sidebarNavId,
                )?.id ?? null)
              : null
          refocusNavId.current = selectSidebarNavFocusHandoff(
            open,
            focusedNavId,
          )
          setFocusWithin(true)
        }}
        onBlurCapture={event => {
          const nextTarget = event.relatedTarget
          if (
            nextTarget instanceof Node &&
            event.currentTarget.contains(nextTarget)
          ) {
            return
          }
          setFocusWithin(false)
        }}
        aria-label="Primary"
        className={
          'fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden border-r border-white/[0.05] bg-surface-panel transition-[width,box-shadow] duration-200 ease-out ' +
          (open ? 'w-60 shadow-[4px_0_24px_rgba(0,0,0,0.45)]' : 'w-12')
        }
      >
        {/* Logo + pin. The pin stays mounted while collapsed so Tab has a stable
         * first entry target; focus capture expands the rail before it paints. */}
        <div
          className={
            'relative flex h-[50px] shrink-0 items-center ' +
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
          <button
            type="button"
            onClick={() => setPinned(value => !value)}
            title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            aria-pressed={pinned}
            className={
              open
                ? 'flex h-[22px] w-[22px] items-center justify-center rounded ' +
                  (pinned
                    ? 'bg-accent/[0.12] text-accent'
                    : 'text-text-faint hover:text-text-muted')
                : 'pointer-events-none absolute inset-0 h-[50px] w-12 opacity-0'
            }
          >
            <PinIcon />
          </button>
        </div>

        {open ? (
          <>
            {/* Search */}
            <div className="shrink-0 px-2.5 pb-2">
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

            {/* New chat — the action you came for, above the list. */}
            {onNewChat ? (
              <button
                type="button"
                onClick={onNewChat}
                className="mx-2 mb-2 flex shrink-0 items-center gap-[9px] rounded-md px-2 py-1.5 text-[12.5px] font-medium text-[#d4d4d8] transition-colors hover:bg-accent/10 hover:text-accent-soft"
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  <ComposeIcon />
                </span>
                <span>New chat</span>
              </button>
            ) : null}

            {/* Pinned + Projects */}
            <div
              aria-label="Sessions"
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {pinnedRows.length > 0 ? (
                <section className="mb-2.5">
                  <div className="flex items-center gap-1 px-1 pb-1.5 pt-0.5">
                    <span className="min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-[0.08em] text-text-faint">
                      Pinned
                    </span>
                  </div>
                  {pinnedRows.map(row => (
                    <SidebarRowItem
                      key={row.sessionId}
                      row={row}
                      isActive={
                        row.appSessionId != null &&
                        row.appSessionId === activeSessionId
                      }
                      pinned
                      reorder={pinnedReorderHandlers}
                      rowRef={element => {
                        if (element) rowRefs.current.set(row.sessionId, element)
                        else rowRefs.current.delete(row.sessionId)
                      }}
                      dragging={pinDrag?.from === row.sessionId}
                      dropEdge={
                        pinDrag != null && pinDrag.over === row.sessionId
                          ? selectPinnedDropEdge(
                              pinnedIds,
                              pinDrag.from,
                              row.sessionId,
                            )
                          : null
                      }
                      {...rowProps}
                    />
                  ))}
                </section>
              ) : null}

              {/* "Add project" lives on this header: pick a folder, a session is
               * created there, and the group appears with that row. No empty
               * group is ever persisted, because the model has no
               * empty-workspace record to persist. */}
              <section className="mb-2.5">
                <div className="flex items-center gap-1 px-1 pb-1.5 pt-0.5">
                  <span className="min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-[0.08em] text-text-faint">
                    Projects
                  </span>
                  {onAddProject ? (
                    <button
                      type="button"
                      onClick={onAddProject}
                      title="Add project: choose a folder"
                      aria-label="Add project"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-white/8 text-text-faint transition-colors hover:border-accent/40 hover:bg-accent/[0.08] hover:text-accent"
                    >
                      <PlusIcon />
                    </button>
                  ) : null}
                </div>

                {/* An empty Projects body is only worth explaining when the
                 * operator cannot see why. Nothing at all, and a search that
                 * matched no project, both need a line; everything having been
                 * lifted into Pinned does not — that list is right above it. */}
                {visibleGroups.length === 0 && rows.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-text-subtle">
                    No sessions yet.
                  </p>
                ) : visibleGroups.length === 0 && query ? (
                  <p className="px-2 py-2 text-xs text-text-subtle">
                    No matches.
                  </p>
                ) : visibleGroups.length === 0 ? null : (
                  visibleGroups.map(group => (
                    <SessionGroup
                      key={group.cwd}
                      group={group}
                      collapsed={collapsedGroups[group.cwd] ?? false}
                      onToggle={() =>
                        setCollapsedGroups(prev => ({
                          ...prev,
                          [group.cwd]: !(prev[group.cwd] ?? false),
                        }))
                      }
                      onNewSessionInWorkspace={onNewSessionInWorkspace}
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
                      pinnedSessions={pinnedSessions}
                      rowRef={(sessionId, element) => {
                        if (element) rowRefs.current.set(sessionId, element)
                        else rowRefs.current.delete(sessionId)
                      }}
                      onOpenWorkspaceActions={
                        group.cwd.trim().length > 0
                          ? anchor =>
                              setWorkspaceMenu({
                                cwd: group.cwd,
                                name: group.name,
                                anchor,
                              })
                          : undefined
                      }
                      {...rowProps}
                    />
                  ))
                )}

                {/* The only way back. Hiding is not destructive and must not
                 * feel one-way, so the rail says how many projects it is
                 * holding and brings them all back in one click. */}
                {hiddenGroups.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      commitHiddenWorkspaces(
                        reduceHiddenWorkspacesCleared(hiddenWorkspaces),
                      )
                    }
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-faint transition-colors hover:bg-shell-hover hover:text-text-muted"
                  >
                    {hiddenGroups.length === 1
                      ? 'Show 1 hidden project'
                      : `Show ${hiddenGroups.length} hidden projects`}
                  </button>
                ) : null}
              </section>
            </div>

            {/* Footer: the active account, and the destinations unfolding
             * upward out of the toggle (column-reverse puts the list above the
             * row that owns it). */}
            <nav
              aria-label="Views"
              className="flex shrink-0 flex-col-reverse items-stretch border-t border-shell-seam px-2 pb-2 pt-1.5"
            >
              <div className="flex shrink-0 items-center gap-2">
                {accountAlias ? (
                  <button
                    type="button"
                    onClick={() => onSelectView('accounts')}
                    title={`Active account: ${accountAlias}`}
                    aria-label={`Active account: ${accountAlias}`}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-text-subtle transition-colors hover:bg-shell-hover hover:text-text-muted"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/[0.16] text-[10px] font-semibold tracking-[0.02em] text-accent-soft"
                    >
                      {accountAlias.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 truncate text-[11px] font-medium">
                      {accountAlias}
                    </span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setNavOpen(value => !value)}
                  aria-expanded={navOpen}
                  aria-label={navOpen ? 'Hide destinations' : 'Show destinations'}
                  title={navOpen ? 'Hide destinations' : 'Show destinations'}
                  className={
                    'ml-auto flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-200 ' +
                    (navOpen
                      ? 'rotate-90 text-accent-soft'
                      : 'text-text-faint hover:bg-shell-hover hover:text-text-muted')
                  }
                >
                  <GridIcon />
                </button>
              </div>

              <div
                className={
                  'grid w-full origin-bottom transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,0.9,0.32,1)] ' +
                  (navOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
                }
                // Folded away it is visually gone but still in flow, so without
                // this Tab would walk five invisible destinations.
                inert={!navOpen}
              >
                <div className="flex flex-col overflow-hidden pb-1.5">
                  {NAV.map((item, index) => (
                    <NavItemExpanded
                      activeView={activeView}
                      buttonRef={element => {
                        if (element) navRefs.current.set(item.id, element)
                        else navRefs.current.delete(item.id)
                      }}
                      item={item}
                      key={item.id}
                      navOpen={navOpen}
                      unfoldDelay={NAV_UNFOLD_DELAY[index] ?? ''}
                      onSelectView={onSelectView}
                    />
                  ))}
                </div>
              </div>
            </nav>
          </>
        ) : (
          /* Collapsed rail: the account glyph over the nav icons, anchored to
           * the bottom. Every destination stays one click away here, which is
           * what lets the expanded footer keep them folded. */
          <nav
            aria-label="Views"
            className="mt-auto flex flex-col items-center gap-1 pb-3 pt-2"
          >
            {accountAlias ? (
              <span
                title={`Active account: ${accountAlias}`}
                className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/[0.16] text-[10px] font-semibold tracking-[0.02em] text-accent-soft"
              >
                {accountAlias.slice(0, 1).toUpperCase()}
              </span>
            ) : null}
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

        {/* Kept INSIDE the aside's React subtree even though it paints as a
         * fixed overlay: focus moving into it bubbles as `focusWithin`, which is
         * what stops the rail collapsing out from under the menu the moment the
         * pointer leaves it. */}
        {workspaceMenu ? (
          <WorkspaceActionsMenu
            workspaceName={workspaceMenu.name}
            anchor={workspaceMenu.anchor}
            onHide={() =>
              commitHiddenWorkspaces(
                reduceWorkspaceHidden(
                  hiddenWorkspaces,
                  workspaceMenu.cwd,
                  Date.now(),
                ),
              )
            }
            onClose={() => setWorkspaceMenu(null)}
          />
        ) : null}
      </aside>
    </>
  )
}

// Workspace grouping (frozen-alphabetical by the rendered label; empty-cwd in one
// "Unknown workspace" bucket) is the shared `groupByWorkspace` from
// `sessionsCatalogState` — the SAME selector the Sessions page uses, so both
// surfaces group AND label the unified roster identically (no local dup).

/**
 * The one-row panel behind a project header's ⋮ (operator, 2026-08-02). Hiding
 * sits behind a menu rather than on a bare ✕ because the ✕ would land a click
 * away from the group's own "+", and a mis-hit would sweep a project off the
 * rail.
 *
 * Deliberately NOT `SessionActionsMenu`: that menu renders the closed
 * `SessionActionKind` union for one SESSION, and widening it with a workspace
 * verb would put two different subjects in one vocabulary. Only the placement
 * (`placeSessionActionsMenu`, incl. the bottom-flip) and the scrim/panel shape
 * are shared.
 */
export function WorkspaceActionsMenu({
  workspaceName,
  anchor,
  onHide,
  onClose,
}: {
  workspaceName: string
  anchor: SessionActionsAnchor
  onHide: () => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: menuRef,
    onEscape: onClose,
  })
  // One row (`px-2.5 py-1.5` + a 15px line ≈ 30) plus the panel's own chrome
  // (`p-1.5` + 1px border top and bottom = 14) — the height model
  // `estimateSessionActionsMenuHeight` states for the session menu, at this
  // panel's single row. Only the flip threshold reads it.
  const placement = placeSessionActionsMenu(
    anchor,
    typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight },
    44,
  )

  return (
    <>
      <div
        className="fixed inset-0 z-[70]"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* §0 EXCEPTION: data-driven geometry Tailwind can't express — the
          measured anchor of the ⋮ that opened this menu. */}
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Project actions for ${workspaceName}`}
        className="animate-sa-pop fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.6)]"
        style={
          placement.placeAbove
            ? { bottom: placement.bottom, left: placement.left }
            : { top: placement.top, left: placement.left }
        }
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            restoreTriggerFocus()
            onHide()
            onClose()
          }}
          className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-shell-hover hover:text-text-primary"
        >
          Hide project
        </button>
      </div>
    </>
  )
}

// Exported for SSR tests: the sidebar collapses to the rail by default
// (all four open sources are false under renderToStaticMarkup), so the
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
  onOpenWorkspaceActions,
  onTogglePin,
  pinnedSessions = [],
  modelForSession,
  reorder,
  rowRef,
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
    anchor: SessionActionsAnchor,
  ) => void
  onNewSessionInWorkspace?: (repId: SessionId) => void
  /** ➕ Project menu (operator, 2026-08-02: the Projects header could add a
   * project but nothing could remove one). Optional + additive: without it the
   * header carries no ⋮. The caller withholds it for the "Unknown workspace"
   * bucket, which is not a project and cannot be hidden. */
  onOpenWorkspaceActions?: (anchor: SessionActionsAnchor) => void
  /** Pin toggle for this group's rows. Optional + additive: without it a row
   * shows only its ⋮ (the pre-Pinned-section markup). */
  onTogglePin?: (sessionId: string) => void
  /** Read only to paint an already-pinned row's pin as pressed. A pinned row is
   * normally lifted into the Pinned section, so this matters for the boundary
   * where a group still holds one. */
  pinnedSessions?: PinnedSessions
  modelForSession?: (id: SessionId) => string | null
  /** ➕ workspace reordering (operator, 2026-07-26). Optional + additive: the
   * header is a plain, non-draggable header when this is absent. */
  reorder?: WorkspaceReorderHandlers
  /** Each row element, so a keyboard step can put focus back on the row it just
   * moved. Keyed on the merge id (the caller keeps one map for the whole rail). */
  rowRef?: (sessionId: string, element: HTMLDivElement | null) => void
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
      className="relative mb-1"
      onDragOver={
        reorderable
          ? event => {
              // Only a workspace drag is accepted — a tab dragged for a split
              // carries `text/sessionId`, a pinned row carries its own type, and
              // both must fall through untouched.
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
       * "+" sits flush-right of the workspace label. ➕ The row is also the
       * workspace drag handle. */}
      <div
        className={
          'group/head flex select-none items-center gap-[5px] px-1 pb-1 pt-0.5 ' +
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
          {group.cwd.trim().length > 0 ? (
            <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center text-text-subtle group-hover/head:text-accent-soft">
              {collapsed ? <FolderClosedIcon /> : <FolderOpenIcon />}
            </span>
          ) : null}
          <span className="truncate text-[12.5px] font-medium text-text-muted group-hover/head:text-[#d4d4d8]">
            {group.name}
          </span>
        </button>
        {onNewSessionInWorkspace && repId ? (
          <button
            type="button"
            onClick={() => onNewSessionInWorkspace(repId)}
            title="New session in this workspace"
            aria-label="New session in this workspace"
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-text-faint opacity-0 transition-[opacity,color,background-color] hover:bg-accent/[0.12] hover:text-accent group-hover/head:opacity-100 focus-visible:opacity-100"
          >
            <PlusIcon />
          </button>
        ) : null}
        {onOpenWorkspaceActions ? (
          <button
            type="button"
            onClick={event => {
              // The trigger's rect, right-aligned to the ⋮ — the row kebab's
              // arrangement (`SidebarRowItem`); the menu owns the gap, the clamp
              // and the bottom-flip.
              const rect = event.currentTarget.getBoundingClientRect()
              onOpenWorkspaceActions({
                top: rect.top,
                bottom: rect.bottom,
                left: rect.right - SESSION_ACTIONS_MENU_WIDTH,
              })
            }}
            // The header is the collapse toggle AND the drag handle; keep this
            // button's own keys off both.
            onKeyDown={event => event.stopPropagation()}
            title="Project actions"
            aria-label={`Project actions for ${group.name}`}
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-text-faint opacity-0 transition-[opacity,color,background-color] hover:bg-accent/[0.12] hover:text-accent group-hover/head:opacity-100 focus-visible:opacity-100"
          >
            <KebabIcon />
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
              pinned={isSessionPinned(pinnedSessions, row.sessionId)}
              onSelectLive={onSelectLive}
              onRestore={onRestore}
              onOpenHistory={onOpenHistory}
              onOpenRowActions={onOpenRowActions}
              onTogglePin={onTogglePin}
              modelForSession={modelForSession}
              rowRef={
                rowRef
                  ? element => rowRef(row.sessionId, element)
                  : undefined
              }
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
  onTogglePin,
  pinned = false,
  reorder,
  rowRef,
  dragging = false,
  dropEdge = null,
  modelForSession,
}: {
  row: MergedSessionRow
  isActive: boolean
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
  onOpenHistory: (engineSessionId: string) => void
  onOpenRowActions?: (
    sessionId: SessionId,
    anchor: SessionActionsAnchor,
  ) => void
  /** Pin/unpin this row. Optional + additive: the pin button renders only when
   * wired, so a test or a caller that omits it gets the pre-Pinned markup. */
  onTogglePin?: (sessionId: string) => void
  /** This row is currently pinned — its pin reads pressed and stays visible at
   * rest (an unpin must be reachable without hunting for a hover). */
  pinned?: boolean
  /** Reorder handlers for the list this row is rendered in (the Pinned section,
   * or its workspace group). Optional + additive: without them the row is not a
   * drag handle at all. */
  reorder?: RowReorderHandlers
  /** The row element, so a keyboard step can put focus back on the row it just
   * moved (the workspace header's `headerRef` idiom). */
  rowRef?: (element: HTMLDivElement | null) => void
  /** This row is the one being dragged (drawn dimmed). */
  dragging?: boolean
  /** This row is the drop target; which edge the dragged row would land on. */
  dropEdge?: RowDropEdge | null
  modelForSession?: (id: SessionId) => string | null
}) {
  const visual = deriveMergedRowVisual(row)
  const title = row.displayLabel
  const appSessionId = row.appSessionId
  // CC-2 recency: last MESSAGE SENT for a registry row (falling back to createdAt),
  // the transcript mtime for a history row — `sidebarActivityKey` folds both, and
  // never `lastAttachedAt` (open/attach bumps that; see `sidebarState.ts`).
  const recency = formatRecency(sidebarActivityKey(row))
  // The subtitle is `time · model`. Only a registry row that attached this run
  // has a known model; a history row shows none.
  const model = appSessionId != null ? modelForSession?.(appSessionId) ?? null : null
  const shortModel = model ? model.split('-').slice(-1)[0] : null

  const openable = visual.openable
  const showActions = openable && (onOpenRowActions != null || onTogglePin != null)
  const showKebab = onOpenRowActions != null && appSessionId != null
  const reorderable = reorder != null

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
      ref={rowRef}
      className={
        'group relative flex select-none items-center gap-2 rounded-md border py-1.5 pl-1 pr-2 transition-colors ' +
        // Exactly one cursor class: two of them in the same attribute would be
        // resolved by Tailwind's own emit order, not by the order written here.
        (reorderable
          ? 'cursor-grab '
          : openable
            ? 'cursor-pointer '
            : 'cursor-default ') +
        (dragging ? 'opacity-50 ' : '') +
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
      aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
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
      draggable={reorderable ? true : undefined}
      onDragStart={
        reorderable
          ? event => {
              event.dataTransfer.setData(reorder!.mime, row.sessionId)
              event.dataTransfer.effectAllowed = 'move'
              reorder?.onDragStart(row.sessionId)
              // A row lives inside its workspace group, whose own handler would
              // otherwise read this as the start of a HEADER drag.
              event.stopPropagation()
            }
          : undefined
      }
      onDragOver={
        reorderable
          ? event => {
              // Only THIS list's drag is accepted. A pinned row dragged over a
              // project row, a workspace header drag, and a tab dragged for a
              // split all fall through untouched rather than lighting up a drop
              // edge they would never land on.
              if (
                !event.dataTransfer.types.some(
                  type => type.toLowerCase() === reorder!.mime,
                )
              ) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              reorder?.onDragOver(row.sessionId)
            }
          : undefined
      }
      onDragLeave={
        reorderable
          ? event => {
              const entering = event.relatedTarget as Node | null
              if (entering && event.currentTarget.contains(entering)) return
              reorder?.onDragLeave(row.sessionId)
            }
          : undefined
      }
      onDrop={
        reorderable
          ? event => {
              if (
                !event.dataTransfer.types.some(
                  type => type.toLowerCase() === reorder!.mime,
                )
              ) {
                return
              }
              event.preventDefault()
              // Don't let the group's own drop handler also fire for a row move.
              event.stopPropagation()
              reorder?.onDrop(row.sessionId)
            }
          : undefined
      }
      onDragEnd={reorderable ? () => reorder?.onDragEnd() : undefined}
      onClick={openable ? activate : undefined}
      onContextMenu={
        showKebab
          ? event => {
              // #11 — right-click opens the row's actions menu at the pointer;
              // suppress the native context menu.
              event.preventDefault()
              event.stopPropagation()
              if (onOpenRowActions && appSessionId != null) {
                // P4-39 — a pointer is a zero-height trigger. The menu clamps it
                // into the viewport and flips it above the pointer near the
                // bottom edge; before, these coordinates were applied raw.
                onOpenRowActions(appSessionId, {
                  top: event.clientY,
                  bottom: event.clientY,
                  left: event.clientX,
                })
              }
            }
          : undefined
      }
      onKeyDown={
        openable
          ? event => {
              if (
                reorderable &&
                event.altKey &&
                (event.key === 'ArrowUp' || event.key === 'ArrowDown')
              ) {
                // Keyboard path for the pinned reorder drag, the same ⌥↑/⌥↓ the
                // workspace headers take.
                event.preventDefault()
                reorder?.onStep(
                  row.sessionId,
                  event.key === 'ArrowUp' ? 'up' : 'down',
                )
                return
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                activate()
              }
            }
          : undefined
      }
    >
      {/* Drop indicator for a pinned reorder — the workspace groups' rule,
       * on the row's own edges. Static classes only. */}
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

      {/* O1 (operator ruling 2026-07-31) — the live-only dot. One tone, no
       * label. The LANE renders on every row and only the dot inside it is
       * conditional, so a live row and a not-live row share one text edge and
       * neither reflows. `self-start` plus a lane exactly as tall as the title's
       * line box centres the dot on the TITLE; centring it on the row instead
       * dropped it into the gap between the title and the `time · model` line
       * and read as floating (operator, 2026-07-31). Static classes: an
       * interpolated arbitrary value silently no-ops in this Tailwind v4 setup. */}
      <span
        aria-hidden="true"
        className="pointer-events-none flex h-4 w-1.5 shrink-0 items-center self-start"
      >
        {row.live ? (
          <span className="h-1.5 w-1.5 rounded-full bg-tone-good" />
        ) : null}
      </span>

      <div
        className={
          'min-w-0 flex-1 ' + (pinned && showActions ? 'pr-5' : '')
        }
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={
              'truncate text-[13px] font-medium ' +
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

      {/* Actions OVERLAY the row's right edge rather than sitting in flow, so a
       * title gets the rail's full width at rest and only gives it up under the
       * pointer. The backing is the row's own tint flattened onto the panel
       * (`.sidebar-row-actions` in `theme.css`, accent-derived so it tracks the
       * theme, and painted only under hover/focus). A
       * pinned row keeps its pin visible at rest — an unpin must not be a
       * hover-hunt — while its ⋮ still waits for the pointer. */}
      {showActions ? (
        <div
          className={
            'absolute inset-y-0 right-1 flex items-center gap-0.5 pl-3.5 transition-opacity ' +
            (pinned
              ? 'opacity-100 '
              : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-within:opacity-100 ') +
            (isActive
              ? 'sidebar-row-actions-active'
              : 'sidebar-row-actions')
          }
        >
          {showKebab ? (
            <button
              type="button"
              className={
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-text-subtle transition-[opacity,background-color,color] hover:bg-accent/[0.16] hover:text-accent-soft ' +
                (pinned
                  ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  : '')
              }
              onClick={event => {
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                if (onOpenRowActions && appSessionId != null) {
                  // P4-39 — the trigger's rect, right-aligned to the kebab; the
                  // menu owns the gap, the clamp and the bottom-flip.
                  onOpenRowActions(appSessionId, {
                    top: rect.top,
                    bottom: rect.bottom,
                    left: rect.right - SESSION_ACTIONS_MENU_WIDTH,
                  })
                }
              }}
              // Keep key events off the row's activate handler (Enter/Space on
              // the kebab opens the menu, it must not also fire onKeyDown).
              onKeyDown={event => event.stopPropagation()}
              title="Session actions"
              aria-label={`Session actions for ${title}`}
            >
              <KebabIcon />
            </button>
          ) : null}
          {onTogglePin ? (
            <button
              type="button"
              className={
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded transition-[background-color,color] hover:bg-accent/[0.16] hover:text-accent-soft ' +
                (pinned ? 'text-accent' : 'text-text-faint')
              }
              aria-pressed={pinned}
              onClick={event => {
                event.stopPropagation()
                onTogglePin(row.sessionId)
              }}
              onKeyDown={event => event.stopPropagation()}
              title={pinned ? 'Unpin' : 'Pin to top'}
              aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`}
            >
              {pinned ? <PinFilledIcon /> : <PinIcon />}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function NavItemExpanded({
  item,
  activeView,
  buttonRef,
  navOpen,
  unfoldDelay,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  buttonRef: (element: HTMLButtonElement | null) => void
  /** The footer is unfolded — items rise into place; folded, they drop back
   * with no stagger (the delays are an entrance effect only). */
  navOpen: boolean
  unfoldDelay: string
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  const motion = navOpen
    ? `translate-y-0 scale-100 opacity-100 ${unfoldDelay}`
    : 'translate-y-1.5 scale-95 opacity-0'
  if (!item.enabled) {
    return (
      <button
        ref={buttonRef}
        type="button"
        disabled
        aria-disabled="true"
        data-sidebar-nav-id={item.id}
        title={`${item.label} is not available yet`}
        className={
          'flex w-full cursor-not-allowed items-center gap-1 rounded-md py-1.5 text-text-subtle/55 transition-[opacity,transform] duration-200 ' +
          motion
        }
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
      ref={buttonRef}
      type="button"
      aria-current={active ? 'page' : undefined}
      data-sidebar-nav-id={item.id}
      onClick={() => {
        const view = resolveNavSelection(item)
        if (view) onSelectView(view)
      }}
      className={
        'flex w-full items-center gap-1 rounded-md py-1.5 transition-[opacity,transform] duration-200 ' +
        motion +
        (active
          ? ' bg-accent/[0.09] text-accent-soft'
          : ' text-text-subtle hover:text-[#d4d4d8]')
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
        data-sidebar-nav-id={item.id}
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
      data-sidebar-nav-id={item.id}
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
 * falling back to `createdAt` — the real, source-backed subtitle. */
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

/* ── Icons (ported from the design source's inline SVGs; attribute-only, no CSS) ── */

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

/** The footer's destination toggle — a 2×2 grid of apps. */
function GridIcon() {
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
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  )
}

/** "New chat" — the compose pencil. */
function ComposeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
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

/** The pinned state of the row pin — the same silhouette, filled. */
function PinFilledIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 4V3h6v1h-1v6.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17h-6v5h-2v-5H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z" />
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

/** An expanded workspace group. */
function FolderOpenIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V9" />
      <path d="M2 12h18.5a1.5 1.5 0 0 1 1.45 1.9l-1.3 4.8A2 2 0 0 1 18.7 20H4" />
    </svg>
  )
}

/** A collapsed workspace group. */
function FolderClosedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 19V6a2 2 0 0 1 2-2h3.6l2 2.5H19a2 2 0 0 1 2 2V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    </svg>
  )
}

/** #10 per-workspace "+" glyph, and the Projects header's "add project". */
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

/** #11 per-row actions ⋮ glyph — three vertically-stacked dots (the same
 * grammar as the TabBar's ⋯ button). */
function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  )
}
