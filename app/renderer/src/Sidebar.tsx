import { UsageBarsIcon } from './AccountsUsageCharts.js'
/**
 * Sidebar — the shell's left rail: a hover-expanding rail (48px → 240px, pin,
 * shadow, easing), a paw logo, session search, a New chat action, pinned
 * sessions, workspace ("Projects") grouping by cwd, and a footer that carries
 * the active account plus the nav destinations.
 *
 * One-line rows (operator, 2026-09-27, `docs/design-html/2026-09-27-sidebar-one-line-rows.html`):
 * a row is its title and the live dot, nothing else. The recency and the session
 * name left the row; the name moved into the row tooltip. Resting titles use the
 * muted ink and brighten under the pointer. The open rail's footer rests as one
 * strip of icons and grows into the labelled list only while the pointer is
 * inside the band the collapsed rail's icon column occupies.
 *
 * Design source (2026-08-01): the operator's Claude Design project "Cat Code
 * Sidebar", `components/sidebar/index.html`. It supersedes the older
 * `Sidebar.jsx` prototype grammar for THIS surface; anything it does not speak
 * to (workspace reordering, the live dot) is unchanged from
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
 *  - ➕ KEPT, not in the design source: the O1 live dot. The recency subtitle
 *    it used to sit beside was cut by the operator on 2026-09-27 (one-line rows);
 *    the session NAME that shared that line (PEER-SESSIONS R4) moved into the
 *    row tooltip.
 *  - 🔁 adapted: the design source also drags SESSION rows to reorder them
 *    inside a project. That is not built. A manual per-project row order would
 *    fight the CC-2 float-to-top ruling (a row rises only when its session sends
 *    a message, `sidebarState.ts`), and the two orders cannot both win. Manual
 *    workspace headers and the separate Pinned list retain their own order.
 *  - 🔁 adapted: "New chat" opens a session in the ACTIVE workspace with no
 *    picker, or creates a chat without a project when no project is active.
 *  - Rows render NO visible status chip: the design source's rows are bare, and
 *    the operator ruled out per-row status labels (2026-07-20). Status TEXT
 *    stays in the `aria-label` only (the O1 dot below is unlabeled, and is the
 *    single exception). A browse-only history row still offers its actions.
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
 *    never reflows the title. Richer per-state status
 *    still surfaces on the TabBar.
 *  - Every nav destination is wired; none is mocked. The same destination set is
 *    directly visible in both rail states so hover expansion cannot replace the
 *    button a pointer is approaching with an intermediary toggle.
 *  - Every row offers a hover/focus-revealed ⋮ and right-click, keyed on the
 *    merged session id, including history rows. App owns the menu. Archived rows
 *    appear below the archive count toggle; opening one unarchives it first.
 *  - Pinned sessions are lifted from Chats or Projects into a manually ordered
 *    section. The versioned renderer preference keeps pin IDs not yet in the
 *    current roster and reconciles pre-ready app IDs when the engine ID arrives.
 *  - Per-workspace "+" (#10/#15): each group header carries a "+" that spawns a
 *    fresh session DIRECTLY in THAT workspace — no native picker. It calls
 *    `onNewSessionInWorkspace(repId)` with the group's active row id (else its
 *    first row) — a REGISTRY id, never a path. The host looks that id up, re-derives
 *    + re-validates the row's cwd from its OWN registry (exactly as restore does),
 *    and spawns there (HC1/T8 — the renderer authors no cwd). The whole-app ⌘T /
 *    TabBar "+" shares the project-aware New chat action.
 *  - Session-row drag-to-panel is omitted; the built split model is drag-tab-to-
 *    edge (P3-6), which stays intact.
 *  - ➕ real-added (operator, 2026-07-26): the workspace GROUP HEADERS are
 *    drag-reorderable, and the chosen order persists across restarts. The order
 *    is renderer-local (`sidebarWorkspaceOrder.ts`), keyed on `cwd` (never the
 *    derived label), applied on the SIDEBAR side of the shared
 *    `groupByWorkspace`, and it never consults `activeCwd` — CC-2 warp-freedom
 *    is intact.
 *  - Session ROWS inside a project group are NOT reorderable, deliberately. A
 *    group is an unbounded, auto-generated activity feed, so a manual order over
 *    it cannot be stored: persisting the whole sequence needs a cap, and a cap
 *    splits the list into remembered and forgotten halves. That shipped on
 *    2026-08-01 with a 64-id cap and inverted the rail on the first project to
 *    exceed it — 168 sessions meant the 64 newest were held in an arrangement
 *    below the 104 oldest, so the group read "22d" at the top while the real
 *    newest row sat far below. Raising the cap defers that; it cannot fix it.
 *    Inside a group, CC-2 activity order is the only rule. The separate Pinned
 *    section remains operator-ordered.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SessionId } from '../../shared/protocol.js'
import { formatAccountsNeedingSignIn } from './accountsPageModel.js'
import { usePopoverFocus } from './overlayFocus.js'
import {
  SESSION_ACTIONS_MENU_WIDTH,
  placeSessionActionsMenu,
  type SessionActionsAnchor,
} from './sessionActions.js'
import {
  createHiddenWorkspaces,
  readHiddenWorkspacesFromStorage,
  reduceHiddenWorkspacesShown,
  reduceWorkspaceHidden,
  selectVisibleWorkspaceGroups,
  writeHiddenWorkspacesToStorage,
  type HiddenWorkspaces,
} from './sidebarHiddenWorkspaces.js'
import {
  deriveMergedRowVisual,
  isSidebarVisibleRow,
  normalizeSidebarGroupExpansion,
  reorderDragHandlers,
  resolveNavSelection,
  selectSidebarFooterExpanded,
  selectSidebarNavFocusHandoff,
  selectSidebarOpen,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  sidebarActivityKey,
  sortSidebarSessionRows,
  type ReorderDrag,
} from './sidebarState.js'
import {
  selectArchivedSidebarRows,
  type ArchivedSessions,
} from './sidebarArchivedSessions.js'
import {
  createPinnedSessions,
  isSessionPinned,
  PINNED_SESSION_DRAG_MIME,
  readPinnedSessionsFromStorage,
  reducePinnedSessionsMoved,
  reducePinnedSessionsReconciled,
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
  clampSidebarWidth,
  readSidebarWidthFromStorage,
  SIDEBAR_DEFAULT_WIDTH,
  writeSidebarWidthToStorage,
} from './sidebarWidth.js'
import {
  defaultViewPreferenceStorage,
  type ViewPreferenceStorage,
} from './viewPreference.js'
import {
  groupByWorkspace,
  selectManagedChatRows,
  type MergedSessionRow,
  type WorkspaceGroup,
} from './sessionsCatalogState.js'

// Rail geometry + hover timing, matching the design source (RAIL_W/FULL_W/delays).
const HOVER_DELAY = 120
const HIDE_DELAY = 200
// Width bounds, the window-relative ceiling, and the persisted value live in
// `sidebarWidth.ts` — a `.ts` module, so the Fast Refresh boundary keeps holding
// for this file.

/**
 * Max session rows a workspace group shows before a "Show N more" toggle
 * (operator, 2026-07-14: one project's session list grew long enough to bury the
 * rest of the rail). The active session is always kept visible even when it
 * falls past the cap.
 */
const SIDEBAR_GROUP_ROW_LIMIT = 6

/** The window's inner width, or 0 under SSR — the "no window to measure" input
 * `clampSidebarWidth` reads as "fixed bounds only". */
function currentWindowWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth
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

export type RowDropEdge = 'before' | 'after'

/** Reorder handlers for the operator-owned pinned-session list. */
export type RowReorderHandlers = {
  mime: string
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDragLeave: (id: string) => void
  onDrop: (id: string) => void
  onDragEnd: () => void
  onStep: (id: string, direction: 'up' | 'down') => void
}

type NavItem = {
  id: 'goals' | 'accounts' | 'usage' | 'settings'
  label: string
  /** Wired to a built view. Unbuilt destinations render disabled + flagged. */
  enabled: boolean
  icon: ReactNode
}

// Chat is reached by opening a session from this roster, so repeating it as a
// destination only spends vertical space and competes with the primary path.
const NAV: NavItem[] = [
  { id: 'goals', label: 'Goals', enabled: true, icon: <GoalsIcon /> },
  { id: 'accounts', label: 'Accounts', enabled: true, icon: <AccountsIcon /> },
  { id: 'usage', label: 'Analytics', enabled: true, icon: <UsageBarsIcon className="size-4" strokeWidth="1.5" /> },
  { id: 'settings', label: 'Settings', enabled: true, icon: <SettingsIcon /> },
]

type SidebarView = 'chat' | 'sessions' | 'goals' | 'accounts' | 'usage' | 'settings'

export function Sidebar({
  rows,
  activeSessionId,
  activeView,
  onSelectView,
  onSelectLive,
  onRestore,
  onOpenHistory,
  onOpenRowActions,
  archivedSessions = [],
  onUnarchiveSession,
  onNewSessionInWorkspace,
  onNewChat,
  onNewManagedChat,
  onAddProject,
  accountAlias = null,
  accountsNeedingSignIn = 0,
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
   * App owns the target-bound menu. Every row, including history, raises its
   * merged identity and anchor (the kebab rect or right-click coordinates).
   */
  onOpenRowActions?: (
    sessionId: string,
    anchor: SessionActionsAnchor,
    archived?: boolean,
  ) => void
  archivedSessions?: ArchivedSessions
  onUnarchiveSession?: (row: MergedSessionRow) => void
  /**
   * #10/#15 — the per-workspace "+" (new session DIRECTLY in this workspace, no
   * picker). Called with a REGISTRY id representing the group (its active row if
   * present, else its first row); the host re-derives + re-validates that row's
   * cwd from its OWN registry and spawns a fresh session there (HC1/T8 — the
   * renderer never authors a cwd). Optional + additive: the "+" renders only when
   * wired.
   */
  onNewSessionInWorkspace?: (repId: SessionId) => void
  /** The existing project-aware New chat action; it uses the active project
   * or creates a chat without a project when there is no active project. */
  onNewChat?: () => void
  /** Create a managed chat without a project, independently of the active view. */
  onNewManagedChat?: () => void
  /** The Projects header's "+": choose a folder, and the session created there
   * makes the group appear. The native picker path (`onNewSession` in App), so
   * no cwd is authored here. Optional + additive. */
  onAddProject?: () => void
  /** The active account's alias for the footer row, or null when no account is
   * resolved yet — in which case the footer shows only the nav toggle rather
   * than an empty avatar. */
  accountAlias?: string | null
  /**
   * How many pool accounts need a fresh sign-in, marked passively on the
   * Accounts destination. Zero renders nothing.
   *
   * This is the whole treatment on purpose. A dead account among healthy ones
   * must not raise a bar over the transcript (`decisions/STARTUP-GATES.md`, the
   * P4-24 revision and #12), so the count waits where the user goes to act on
   * it rather than interrupting.
   */
  accountsNeedingSignIn?: number
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
  /** Where workspace order, session pins, and hidden projects are persisted.
   * Injectable for tests (`ReasoningLayoutProvider`'s `storage` prop idiom);
   * defaults to the renderer's own `localStorage`, and `null` disables
   * persistence entirely. */
  storage?: ViewPreferenceStorage | null
}) {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  )
  const orderStore =
    storage === undefined ? defaultViewPreferenceStorage() : storage
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(
      readSidebarWidthFromStorage(orderStore) ?? SIDEBAR_DEFAULT_WIDTH,
      currentWindowWidth(),
    ),
  )
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrder>(
    () => readWorkspaceOrderFromStorage(orderStore) ?? createWorkspaceOrder(),
  )
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSessions>(
    () => readPinnedSessionsFromStorage(orderStore) ?? createPinnedSessions(),
  )
  const [archivesExpanded, setArchivesExpanded] = useState(false)
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
  /** The in-flight workspace header drag. */
  const [headerDrag, setHeaderDrag] = useState<ReorderDrag>(null)
  const [pinDrag, setPinDrag] = useState<ReorderDrag>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The rail element, so the backdrop-close re-collapse can ask whether the
   * pointer is genuinely still over it. */
  const asideRef = useRef<HTMLElement | null>(null)
  /** Live workspace-header buttons by cwd, and the one a keyboard step just
   * moved — see the re-focus effect below `reorderHandlers`. */
  const headerRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocusCwd = useRef<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const refocusRowId = useRef<string | null>(null)
  /** Expanded nav buttons by destination, plus a collapsed rail destination
   * whose focus must survive the branch replacement. */
  const navRefs = useRef(new Map<NavItem['id'], HTMLButtonElement>())
  const refocusNavId = useRef<NavItem['id'] | null>(null)
  /** Footer form while open: the labelled list, or the one-line icon strip.
   * `selectSidebarFooterExpanded` decides it from the pointer's last y and the
   * height of the collapsed rail's icon column, measured while collapsed. */
  const [footerExpanded, setFooterExpanded] = useState(false)
  const pointerY = useRef<number | null>(null)
  const collapsedNavRef = useRef<HTMLElement | null>(null)
  const footerBandHeight = useRef(0)

  const open =
    !dismissed &&
    selectSidebarOpen({
      pinned,
      hovering,
      menuActive,
      focusWithin,
    })

  const readFooterExpanded = useCallback(() => {
    const aside = asideRef.current
    return (
      aside != null &&
      selectSidebarFooterExpanded(
        pointerY.current,
        aside.getBoundingClientRect().bottom,
        footerBandHeight.current,
      )
    )
  }, [])
  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setDismissed(false)
    showTimer.current = setTimeout(() => setHovering(true), HOVER_DELAY)
  }
  const onLeave = () => {
    if (showTimer.current) clearTimeout(showTimer.current)
    // Don't start the hide timer while a row's menu/rename is open. Reaching for
    // that menu means leaving the rail.
    if (menuActive) return
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY)
  }
  const collapseSidebar = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPinned(false)
    setHovering(false)
    setDismissed(true)
  }, [])
  const selectView = (view: SidebarView) => {
    onSelectView(view)
    // A hover/focus-open overlay otherwise obscures the destination it just
    // revealed. An explicit pin is the user's request to keep the rail open.
    if (!pinned) collapseSidebar()
  }
  const resizeSidebar = (clientX: number) => {
    setSidebarWidth(clampSidebarWidth(clientX, currentWindowWidth()))
  }
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (typeof document === 'undefined') return

    const onFocusIn = (event: FocusEvent) => {
      console.log('[Document] focusin', {
        target: event.target,
        relatedTarget: event.relatedTarget,
        activeElement: document.activeElement,
      })
    }
    const onFocusOut = (event: FocusEvent) => {
      console.log('[Document] focusout', {
        target: event.target,
        relatedTarget: event.relatedTarget,
        activeElement: document.activeElement,
      })
    }

    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
    }
  }, [])
  useEffect(() => {
    asideRef.current?.style.setProperty(
      '--sidebar-expanded-width',
      `${sidebarWidth}px`,
    )
  }, [sidebarWidth])

  /**
   * Shrinking the WINDOW lowers the ceiling under a width that was legal when it
   * was set, so the rail is re-clamped here as well as on drag. Widening the
   * window never restores the surrendered pixels: the clamped width becomes the
   * operator's width, exactly as if they had dragged it there, and the stored
   * value is left alone so a drag stays the only thing that rewrites it.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => {
      setSidebarWidth(width => clampSidebarWidth(width, window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (
      !open ||
      activeView === 'chat' ||
      menuActive ||
      typeof document === 'undefined'
    ) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || asideRef.current?.contains(target)) return
      collapseSidebar()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [activeView, collapseSidebar, menuActive, open])

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

  const query = search.trim().toLowerCase()
  // Sort (CC-2 warp-free activity order) → partition archives → filter → group.
  // Recomputes only when the roster, the query, archives or the active session
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
  // Archive membership is computed before display filters so the count does
  // not change under search or workspace hiding.
  const railRows = useMemo(
    () => sortSidebarSessionRows(rows),
    [rows],
  )

  const matchesQuery = (row: MergedSessionRow) =>
    !query ||
    row.displayLabel.toLowerCase().includes(query) ||
    (row.binding?.kind !== 'managed' && row.cwd.toLowerCase().includes(query))

  const { visible: unarchivedRows, archived: archivedRows } = useMemo(
    () => selectArchivedSidebarRows(railRows, archivedSessions),
    [railRows, archivedSessions],
  )
  const sidebarRows = useMemo(
    () => unarchivedRows.filter(isSidebarVisibleRow),
    [unarchivedRows],
  )
  const pinnedRows = useMemo(
    () => selectPinnedRows(sidebarRows, pinnedSessions).filter(matchesQuery),
    [sidebarRows, pinnedSessions, query],
  )
  const groupRows = useMemo(
    () => selectUnpinnedRows(sidebarRows, pinnedSessions),
    [sidebarRows, pinnedSessions],
  )
  const matchingArchivedRows = archivedRows.filter(matchesQuery)
  const managedRows = useMemo(
    () => selectManagedChatRows(groupRows).filter(row =>
      !query || row.displayLabel.toLowerCase().includes(query),
    ),
    [groupRows, query],
  )
  // Chats take the same "Show more" cap as a project group, so a long run of
  // chats cannot push Projects off the rail. The active chat stays visible.
  const [chatsExpanded, setChatsExpanded] = useState(false)
  const {
    visible: visibleManagedRows,
    hiddenCount: hiddenManagedCount,
    overLimit: managedOverLimit,
  } = selectVisibleSidebarRows(
    managedRows,
    row => row.appSessionId != null && row.appSessionId === activeSessionId,
    SIDEBAR_GROUP_ROW_LIMIT,
    chatsExpanded,
  )
  useEffect(() => {
    setChatsExpanded(value =>
      normalizeSidebarGroupExpansion(value, managedOverLimit),
    )
  }, [managedOverLimit])

  // The operator's custom WORKSPACE order is applied on the sidebar side
  // of the shared selector; `groupByWorkspace` stays frozen-alphabetical.
  //
  // The UNFILTERED group sequence. A reorder is expressed against what is on
  // screen, but it FREEZES this one, so groups the search box is hiding keep
  // their current position instead of falling behind the two that were dragged.
  //
  // A group's ROWS take no manual order at all: inside a project, CC-2 activity
  // order is the only rule (see the header note).
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
  const activityByWorkspace = useMemo(
    () =>
      new Map(
        allGroups.map(group => [
          group.cwd,
          group.rows.reduce(
            (newest, row) => Math.max(newest, sidebarActivityKey(row)),
            0,
          ),
        ]),
      ),
    [allGroups],
  )

  // ➕ Projects the operator has hidden are held back HERE, after ordering and
  // filtering, so unhiding one drops it straight back into its ranked slot
  // (`allGroups`, which feeds the reorder freeze list, deliberately still counts
  // it). A group reports the CC-2 warp-free activity of its newest row, which is
  // what lets a hidden project resurface on real work but not on a mere open.
  const { visible: visibleGroups, hidden: hiddenGroups } = useMemo(
    () =>
      selectVisibleWorkspaceGroups(groups, hiddenWorkspaces, group =>
        activityByWorkspace.get(group.cwd) ?? 0,
      ),
    [groups, hiddenWorkspaces, activityByWorkspace],
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
    ...reorderDragHandlers(setHeaderDrag),
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
    ...reorderDragHandlers(setPinDrag),
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

  useLayoutEffect(() => {
    commitPinnedSessions(
      reducePinnedSessionsReconciled(pinnedSessions, railRows),
    )
  }, [pinnedSessions, railRows])

  useLayoutEffect(() => {
    const id = refocusRowId.current
    if (id == null) return
    refocusRowId.current = null
    rowRefs.current.get(id)?.focus()
  }, [pinnedSessions])

  // The band the footer list answers to is the collapsed icon column, so it is
  // measured while that column is on screen.
  useLayoutEffect(() => {
    if (open) return
    const aside = asideRef.current
    const nav = collapsedNavRef.current
    if (aside == null || nav == null) return
    footerBandHeight.current =
      aside.getBoundingClientRect().bottom - nav.getBoundingClientRect().top
  }, [open, accountAlias])

  // Opening decides the footer form from where the pointer already is.
  useLayoutEffect(() => {
    setFooterExpanded(open && readFooterExpanded())
  }, [open, readFooterExpanded])

  useLayoutEffect(() => {
    const navId = refocusNavId.current
    if (navId == null || !open) return
    // Wait out a footer swap the open transition is about to make, or focus
    // would land on a button that unmounts one render later.
    if (footerExpanded !== readFooterExpanded()) return
    refocusNavId.current = null
    navRefs.current.get(navId)?.focus()
  }, [open, footerExpanded, readFooterExpanded])

  const accountButton = accountAlias ? (
    <button
      type="button"
      onClick={() => selectView('accounts')}
      title={`Active account: ${accountAlias}`}
      aria-label={`Active account: ${accountAlias}`}
      className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-text-subtle transition-colors hover:bg-shell-hover hover:text-text-muted"
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
  ) : null

  const rowProps = {
    activeSessionId,
    onSelectLive,
    onRestore,
    onOpenHistory,
    onOpenRowActions,
    onTogglePin: togglePin,
  }

  return (
    <>
      {/* Spacer reserves the collapsed rail's 48px footprint in the flex flow;
       * the rail itself floats (fixed) and expands OVER the content on hover. */}
      <div className="w-12 shrink-0" aria-hidden="true" />

      <aside
        ref={asideRef}
        onMouseEnter={event => {
          pointerY.current = event.clientY
          onEnter()
        }}
        onMouseMove={event => {
          pointerY.current = event.clientY
          if (open) setFooterExpanded(readFooterExpanded())
        }}
        onMouseLeave={() => {
          pointerY.current = null
          onLeave()
        }}
        onFocusCapture={event => {
          console.log('[Sidebar] focus capture', {
            target: event.target,
            relatedTarget: event.relatedTarget,
            activeElement: document.activeElement,
          })
          const target = event.target
          const focusedNavId =
            target instanceof HTMLElement
              ? (NAV.find(
                  item => item.id === target.dataset.sidebarNavId,
                )?.id ?? null)
              : null
          const handoffNavId = selectSidebarNavFocusHandoff(
            open,
            focusedNavId,
          )
          refocusNavId.current = handoffNavId
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
        /* An OVERLAY, not flow chrome: this expands over the transcript, so
         * glass has to blur what is behind it, not just thin it
         * (`theme.css`). */
        data-window-overlay
        className={
          /* `top-10`, not `inset-y-0`: the tab bar is the window's title bar now
           * (`App.tsx`), and the traffic lights macOS draws into it are painted
           * ABOVE the page. An expanded rail reaching y=0 would slide under
           * them, putting three OS buttons on top of its own header. */
          'fixed bottom-0 left-0 top-10 z-50 flex flex-col overflow-hidden border-r border-white/[0.05] bg-surface-panel transition-[width,box-shadow] duration-200 ease-out ' +
          (open
            ? 'sidebar-expanded shadow-[var(--elev-rail)]'
            : 'w-12') +
          (resizing ? ' transition-none' : '')
        }
      >
        {/* Name + pin. Nothing renders here while the rail is collapsed: the
         * paw that used to mark the corner is gone, and this row survives only
         * because the pin stays mounted so Tab has a stable first entry target;
         * focus capture expands the rail before it paints. */}
        <div
          className={
            'relative flex h-10 shrink-0 items-center ' +
            (open ? 'justify-between pl-3.5 pr-2.5' : 'justify-center')
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            {open ? (
              <>
                <span aria-hidden="true" className="flex shrink-0 text-accent">
                  <PawLogo />
                </span>
                <span className="truncate text-[12.5px] font-semibold tracking-tight text-text-primary">
                  Cat Code
                </span>
              </>
            ) : null}
          </div>
          <div
            className={
              open
                ? 'flex items-center gap-1'
                : 'pointer-events-none absolute inset-0 h-10 w-12 opacity-0'
            }
          >
            <button
              type="button"
              onClick={collapseSidebar}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              className="flex h-[22px] w-[22px] items-center justify-center rounded text-text-faint hover:text-text-muted"
            >
              <CollapseSidebarIcon />
            </button>
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
          </div>
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
                  className="w-full rounded-md border border-white/[0.07] bg-white/[0.04] py-1 pl-[26px] pr-2 text-[11.5px] text-[light-dark(#3f3f46,#d4d4d8)] outline-none placeholder:text-text-subtle focus:border-accent/35"
                />
              </div>
            </div>

            {/* Project-aware New chat stays above the session roster. */}
            {onNewChat ? (
              <button
                type="button"
                onClick={onNewChat}
                aria-keyshortcuts="Meta+T"
                className="mx-2 mb-1.5 flex shrink-0 items-center gap-[9px] rounded-md px-2 py-[5px] text-xs font-medium text-[light-dark(#3f3f46,#d4d4d8)] transition-colors hover:bg-accent/10 hover:text-accent-soft"
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  <ComposeIcon />
                </span>
                <span>New chat</span>
                <kbd
                  aria-hidden="true"
                  className="ml-auto font-mono text-[10px] tracking-[0.04em] text-text-ghost"
                >
                  ⌘T
                </kbd>
              </button>
            ) : null}

            {/* Chats, projects, and archived sessions */}
            <div
              aria-label="Sessions"
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {pinnedRows.length > 0 ? (
                <section className="mb-[18px]">
                  <div className="flex items-center gap-1 pb-[5px] pl-2 pr-1 pt-0.5">
                    <span className="shrink-0 truncate text-[11px] font-medium text-text-ghost">
                      Pinned
                    </span>
                    <span aria-hidden="true" className="ml-1.5 mr-1 h-px min-w-0 flex-1 bg-shell-seam" />
                  </div>
                  {pinnedRows.map(row => (
                    <SidebarRowItem
                      key={row.sessionId}
                      row={row}
                      isActive={
                        row.appSessionId != null &&
                        row.appSessionId === activeSessionId
                      }
                      pinned={isSessionPinned(pinnedSessions, row.sessionId)}
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

              <section className="mb-[18px]">
                <div className="flex items-center gap-1 pb-[5px] pl-2 pr-1 pt-0.5">
                  <span className="shrink-0 truncate text-[11px] font-medium text-text-ghost">
                    Chats
                  </span>
                  <span aria-hidden="true" className="ml-1.5 mr-1 h-px min-w-0 flex-1 bg-shell-seam" />
                  {onNewManagedChat ? (
                    <button
                      type="button"
                      onClick={onNewManagedChat}
                      title="New chat without a project"
                      aria-label="New chat without a project"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-transparent text-text-faint transition-colors hover:border-accent/40 hover:bg-accent/[0.08] hover:text-accent"
                    >
                      <PlusIcon />
                    </button>
                  ) : null}
                </div>
                {visibleManagedRows.map(row => (
                  <SidebarRowItem
                    key={row.sessionId}
                    row={row}
                    isActive={row.appSessionId != null && row.appSessionId === activeSessionId}
                    {...rowProps}
                  />
                ))}
                {shouldShowSidebarGroupExpansionToggle(
                  chatsExpanded,
                  hiddenManagedCount,
                  managedOverLimit,
                ) ? (
                  <button
                    type="button"
                    onClick={() => setChatsExpanded(value => !value)}
                    aria-expanded={chatsExpanded}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-[3px] pl-[18px] text-[11px] font-medium text-text-faint transition-colors hover:bg-shell-hover hover:text-text-muted"
                  >
                    {chatsExpanded ? 'Show less' : `Show ${hiddenManagedCount} more`}
                  </button>
                ) : null}
              </section>

              {/* "Add project" lives on this header: pick a folder, a session is
               * created there, and the group appears with that row. No empty
               * group is ever persisted, because the model has no
               * empty-workspace record to persist. */}
              <section className="mb-[18px]">
                <div className="flex items-center gap-1 pb-[5px] pl-2 pr-1 pt-0.5">
                  <span className="shrink-0 truncate text-[11px] font-medium text-text-ghost">
                    Projects
                  </span>
                  <span aria-hidden="true" className="ml-1.5 mr-1 h-px min-w-0 flex-1 bg-shell-seam" />
                  {onAddProject ? (
                    <button
                      type="button"
                      onClick={onAddProject}
                      title="Add project: choose a folder"
                      aria-label="Add project"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-transparent text-text-faint transition-colors hover:border-accent/40 hover:bg-accent/[0.08] hover:text-accent"
                    >
                      <PlusIcon />
                    </button>
                  ) : null}
                </div>

                {/* Empty search results need a line; collapsed or hidden groups do not. */}
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
                 * holding and brings back exactly the ones it named in one
                 * click — never the whole persisted hidden list, which a
                 * search filter can leave holding MORE than this button
                 * counts. */}
                {hiddenGroups.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      commitHiddenWorkspaces(
                        reduceHiddenWorkspacesShown(
                          hiddenWorkspaces,
                          hiddenGroups,
                        ),
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
              {archivedRows.length > 0 ? (
                <section className="mb-[18px]">
                  <button
                    type="button"
                    onClick={() => setArchivesExpanded(value => !value)}
                    aria-expanded={archivesExpanded}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-faint transition-colors hover:bg-shell-hover hover:text-text-muted"
                  >
                    {archivedRows.length} archived
                  </button>
                  {archivesExpanded ? matchingArchivedRows.map(row => (
                    <SidebarRowItem
                      key={row.sessionId}
                      row={row}
                      isActive={false}
                      pinned={isSessionPinned(pinnedSessions, row.sessionId)}
                      archived
                      onUnarchiveSession={onUnarchiveSession}
                      {...rowProps}
                    />
                  )) : null}
                </section>
              ) : null}
            </div>

            {/* Footer: direct destinations and the active account. At rest it
             * is one strip of icons; it grows into the labelled list only while
             * the pointer is in the collapsed icon column's band
             * (`selectSidebarFooterExpanded`), so opening the rail to reach a
             * session never spends rows on destinations. Both forms keep every
             * destination directly clickable. */}
            <nav
              aria-label="Views"
              className="flex shrink-0 flex-col items-stretch border-t border-shell-seam px-2 pb-[7px] pt-[5px]"
            >
              {footerExpanded ? (
                <>
                  <div className="flex flex-col pb-1">
                    {NAV.map(item => (
                      <NavItemExpanded
                        activeView={activeView}
                        buttonRef={element => {
                          if (element) navRefs.current.set(item.id, element)
                          else navRefs.current.delete(item.id)
                        }}
                        item={item}
                        key={item.id}
                        needsSignIn={
                          item.id === 'accounts' ? accountsNeedingSignIn : 0
                        }
                        onSelectView={selectView}
                      />
                    ))}
                  </div>
                  {accountButton}
                </>
              ) : (
                <div className="flex items-center gap-0.5">
                  <div className="flex min-w-0 flex-1">{accountButton}</div>
                  {NAV.map(item => (
                    <NavItemRail
                      activeView={activeView}
                      buttonRef={element => {
                        if (element) navRefs.current.set(item.id, element)
                        else navRefs.current.delete(item.id)
                      }}
                      item={item}
                      key={item.id}
                      needsSignIn={
                        item.id === 'accounts' ? accountsNeedingSignIn : 0
                      }
                      onSelectView={selectView}
                    />
                  ))}
                </div>
              )}
            </nav>
          </>
        ) : (
          /* Collapsed rail: destinations above the bottom-anchored account,
           * matching the expanded footer so neither changes sides on hover. */
          <nav
            ref={collapsedNavRef}
            aria-label="Views"
            className="mt-auto flex flex-col items-center gap-1 pb-3 pt-2"
          >
            {NAV.map(item => (
              <NavItemRail
                activeView={activeView}
                item={item}
                key={item.id}
                needsSignIn={item.id === 'accounts' ? accountsNeedingSignIn : 0}
                onSelectView={selectView}
              />
            ))}
            {accountAlias ? (
              <span
                title={`Active account: ${accountAlias}`}
                className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/[0.16] text-[10px] font-semibold tracking-[0.02em] text-accent-soft"
              >
                {accountAlias.slice(0, 1).toUpperCase()}
              </span>
            ) : null}
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
        {open ? (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            title="Drag to resize sidebar"
            onPointerDown={event => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizing(true)
              resizeSidebar(event.clientX)
            }}
            onPointerMove={event => {
              if (resizing) resizeSidebar(event.clientX)
            }}
            onPointerUp={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              setResizing(false)
              // Persist on RELEASE, not per move: a drag is hundreds of
              // pointermove events and only the width it settles on is a choice.
              writeSidebarWidthToStorage(orderStore, sidebarWidth)
            }}
            onPointerCancel={() => setResizing(false)}
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none"
          />
        ) : null}
      </aside>
    </>
  )
}

// Workspace grouping (frozen-alphabetical by the rendered label; empty-cwd in one
// "Unknown workspace" bucket) is the shared `groupByWorkspace` from
// `sessionsCatalogState`; no local duplicate selector.

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
        className="animate-sa-pop fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
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
  onTogglePin,
  onNewSessionInWorkspace,
  onOpenWorkspaceActions,
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
    sessionId: string,
    anchor: SessionActionsAnchor,
    archived?: boolean,
  ) => void
  onTogglePin?: (sessionId: string) => void
  onNewSessionInWorkspace?: (repId: SessionId) => void
  /** ➕ Project menu (operator, 2026-08-02: the Projects header could add a
   * project but nothing could remove one). Optional + additive: without it the
   * header carries no ⋮. The caller withholds it for the "Unknown workspace"
   * bucket, which is not a project and cannot be hidden. */
  onOpenWorkspaceActions?: (anchor: SessionActionsAnchor) => void
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
      className="relative mb-2.5"
      onDragOver={
        reorderable
          ? event => {
              // Only a workspace drag is accepted — a tab dragged for a split
              // carries `text/sessionId`, and
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
          'group/head relative flex select-none items-center gap-[5px] pb-1 pl-[7px] pr-1 pt-[5px] ' +
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
          className="flex min-w-0 flex-1 items-center gap-1.5"
        >
          {group.cwd.trim().length > 0 ? (
            <span className="flex h-3 w-3 shrink-0 items-center justify-center text-text-subtle group-hover/head:text-accent-soft [&_svg]:size-3">
              {collapsed ? <FolderClosedIcon /> : <FolderOpenIcon />}
            </span>
          ) : null}
          <span className="truncate text-xs font-medium text-text-muted group-hover/head:text-[light-dark(#3f3f46,#d4d4d8)]">
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
        {/* The project's session count sits where the hover-revealed "+" and ⋮
         * appear, and yields that slot to them under the pointer or focus. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-text-ghost transition-opacity group-hover/head:opacity-0 group-focus-within/head:opacity-0"
        >
          {group.rows.length}
        </span>
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
              onTogglePin={onTogglePin}
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
              className="flex w-full items-center gap-1 rounded-md px-2 py-[3px] pl-[18px] text-[11px] font-medium text-text-faint transition-colors hover:bg-shell-hover hover:text-text-muted"
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
  pinned = false,
  onTogglePin,
  reorder,
  rowRef,
  dragging = false,
  dropEdge = null,
  archived = false,
  onUnarchiveSession,
}: {
  row: MergedSessionRow
  isActive: boolean
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
  onOpenHistory: (engineSessionId: string) => void
  onOpenRowActions?: (
    sessionId: string,
    anchor: SessionActionsAnchor,
    archived?: boolean,
  ) => void
  pinned?: boolean
  onTogglePin?: (sessionId: string) => void
  reorder?: RowReorderHandlers
  rowRef?: (element: HTMLDivElement | null) => void
  dragging?: boolean
  dropEdge?: RowDropEdge | null
  archived?: boolean
  onUnarchiveSession?: (row: MergedSessionRow) => void
}) {
  const visual = deriveMergedRowVisual(row)
  const title = row.displayLabel
  const appSessionId = row.appSessionId
  // The session name (PEER-SESSIONS R4) leads the tooltip: the one-line row
  // (operator, 2026-09-27) has no subtitle to carry it. A registry field, so it
  // reads the same live, parked or closed; a row with no name (a history row, or
  // a registry row that predates the field) omits it.
  const name = row.name

  const openable = visual.openable
  const showKebab = onOpenRowActions != null
  const showPin = openable && onTogglePin != null
  const showActions = showKebab || showPin
  const reorderable = reorder != null
  const actionable = openable || (archived && onUnarchiveSession != null)

  // A live registry row focuses its tab; a restorable row re-spawns via restore;
  // a resolvable history row opens by its ENGINE id (Part-A host path); a
  // browse-only row cannot open, but an archived one can still be unarchived.
  const activate = () => {
    if (archived) onUnarchiveSession?.(row)
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
        'group relative flex select-none items-center gap-[7px] rounded-[5px] border py-[5.5px] pl-[5px] pr-1.5 transition-colors ' +
        // Exactly one cursor class: two of them in the same attribute would be
        // resolved by Tailwind's own emit order, not by the order written here.
        (reorderable
          ? 'cursor-grab '
          : actionable
            ? 'cursor-pointer '
            : 'cursor-default ') +
        (dragging ? 'opacity-50 ' : '') +
        (isActive
          ? 'border-accent/[0.18] bg-accent/[0.09]'
          : openable || showActions
            ? 'border-transparent hover:border-accent/[0.22] hover:bg-accent/[0.07]'
            : 'border-transparent')
      }
      role="button"
      tabIndex={actionable ? 0 : -1}
      aria-current={isActive ? 'true' : undefined}
      aria-disabled={actionable || showActions ? undefined : 'true'}
      aria-label={`session ${title}, ${visual.label}${openable ? '' : ', open from terminal'}`}
      aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      title={
        openable
          ? `${name ? `${name} · ` : ''}${row.binding?.kind === 'managed' ? title : row.cwd || title}${
              visual.kind === 'restorable'
                ? ' · restore'
                : visual.kind === 'history'
                  ? ' · open'
                  : ''
            }${reorderable ? '. Drag to reorder, or ⌥↑/⌥↓' : ''}`
          : 'This session has no recorded workspace. Open it from the terminal.'
      }
      draggable={reorderable ? true : undefined}
      onDragStart={
        reorderable
          ? event => {
              event.dataTransfer.setData(reorder!.mime, row.sessionId)
              event.dataTransfer.effectAllowed = 'move'
              reorder?.onDragStart(row.sessionId)
              event.stopPropagation()
            }
          : undefined
      }
      onDragOver={
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
              event.stopPropagation()
              reorder?.onDrop(row.sessionId)
            }
          : undefined
      }
      onDragEnd={reorderable ? () => reorder?.onDragEnd() : undefined}
      onClick={actionable ? activate : undefined}
      onContextMenu={
        showKebab
          ? event => {
              // #11 — right-click opens the row's actions menu at the pointer;
              // suppress the native context menu.
              event.preventDefault()
              event.stopPropagation()
              if (onOpenRowActions) {
                // P4-39 — a pointer is a zero-height trigger. The menu clamps it
                // into the viewport and flips it above the pointer near the
                // bottom edge; before, these coordinates were applied raw.
                onOpenRowActions(row.sessionId, {
                  top: event.clientY,
                  bottom: event.clientY,
                  left: event.clientX,
                }, archived || undefined)
              }
            }
          : undefined
      }
      onKeyDown={
        actionable || reorderable
          ? event => {
              if (
                reorderable &&
                event.altKey &&
                (event.key === 'ArrowUp' || event.key === 'ArrowDown')
              ) {
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
       * neither reflows. The lane is exactly as tall as the title's line box, so
       * the dot centres on the title. The soft ring around it is the "live halo"
       * the operator picked on 2026-09-27. Static classes: an interpolated
       * arbitrary value silently no-ops in this Tailwind v4 setup. */}
      <span
        aria-hidden="true"
        className="pointer-events-none flex h-[17px] w-1.5 shrink-0 items-center self-start"
      >
        {row.live && !archived ? (
          <span className="h-1.5 w-1.5 rounded-full bg-tone-good ring-[2.5px] ring-tone-good/[0.18]" />
        ) : null}
      </span>

      {/* Resting titles take the muted ink so a long roster does not read as one
       * block of bright text; the pointer and the open session brighten it. */}
      <span
        className={
          'min-w-0 flex-1 truncate text-[12.5px] leading-[17px] ' +
          (pinned && showActions ? 'pr-5 ' : '') +
          (archived
            ? 'text-text-faint'
            : isActive
              ? 'font-medium text-[light-dark(#9d174d,#fce7f3)]'
              : openable
                ? 'text-text-muted group-hover:text-text-primary'
                : 'text-text-faint')
        }
      >
        {title}
      </span>

      {/* Actions OVERLAY the row's right edge rather than sitting in flow, so a
       * title gets the rail's full width at rest and only gives it up under the
       * pointer. The backing is the row's own tint flattened onto the panel
       * (`.sidebar-row-actions` in `theme.css`, accent-derived so it tracks the
       * theme, and painted only under hover/focus). */}
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
                if (onOpenRowActions) {
                  // P4-39 — the trigger's rect, right-aligned to the kebab; the
                  // menu owns the gap, the clamp and the bottom-flip.
                  onOpenRowActions(row.sessionId, {
                    top: rect.top,
                    bottom: rect.bottom,
                    left: rect.right - SESSION_ACTIONS_MENU_WIDTH,
                  }, archived || undefined)
                }
              }}
              onKeyDown={event => event.stopPropagation()}
              title="Session actions"
              aria-label={`Session actions for ${title}`}
            >
              <KebabIcon />
            </button>
          ) : null}
          {showPin ? (
            <button
              type="button"
              className={
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded transition-[background-color,color] hover:bg-accent/[0.16] hover:text-accent-soft ' +
                (pinned ? 'text-accent' : 'text-text-faint')
              }
              aria-pressed={pinned}
              onClick={event => {
                event.stopPropagation()
                onTogglePin?.(row.sessionId)
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
  needsSignIn = 0,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  buttonRef: (element: HTMLButtonElement | null) => void
  /** Accounts needing a fresh sign-in; 0 renders no mark. */
  needsSignIn?: number
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  const signInLabel = formatAccountsNeedingSignIn(needsSignIn)
  if (!item.enabled) {
    return (
      <button
        ref={buttonRef}
        type="button"
        disabled
        aria-disabled="true"
        data-sidebar-nav-id={item.id}
        title={`${item.label} is not available yet`}
        className="flex w-full cursor-not-allowed items-center gap-1 rounded-[5px] py-[3px] text-text-subtle/55"
      >
        <span className="flex h-[18px] w-[26px] shrink-0 items-center justify-center [&_svg]:size-3.5">
          {item.icon}
        </span>
        <span className="text-xs">{item.label}</span>
      </button>
    )
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={signInLabel ? `${item.label}, ${signInLabel}` : undefined}
      data-sidebar-nav-id={item.id}
      onClick={() => {
        const view = resolveNavSelection(item)
        if (view) onSelectView(view)
      }}
      className={
        'flex w-full items-center gap-1 rounded-[5px] border py-[3px] transition-colors ' +
        (active
          ? ' border-accent/[0.18] bg-accent/[0.09] text-accent-soft'
          : ' border-transparent text-text-subtle hover:border-accent/[0.22] hover:bg-accent/[0.07] hover:text-[light-dark(#3f3f46,#d4d4d8)]')
      }
    >
      <span className="flex h-[18px] w-[26px] shrink-0 items-center justify-center [&_svg]:size-3.5">
        {item.icon}
      </span>
      <span className={'text-xs ' + (active ? 'font-medium' : '')}>
        {item.label}
      </span>
      {signInLabel ? (
        <span
          aria-hidden="true"
          title={signInLabel}
          data-sidebar-nav-badge={item.id}
          className="ml-auto mr-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-tone-warn/[0.16] px-1 text-[9.5px] font-semibold tabular-nums text-tone-warn"
        >
          {needsSignIn}
        </span>
      ) : null}
    </button>
  )
}

function NavItemRail({
  item,
  activeView,
  buttonRef,
  needsSignIn = 0,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  /** Registered by the open rail's footer strip for focus handoff. */
  buttonRef?: (element: HTMLButtonElement | null) => void
  /** Accounts needing a fresh sign-in; 0 renders no mark. */
  needsSignIn?: number
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  const signInLabel = formatAccountsNeedingSignIn(needsSignIn)
  if (!item.enabled) {
    return (
      <button
        ref={buttonRef}
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
      ref={buttonRef}
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={signInLabel ? `${item.label}, ${signInLabel}` : item.label}
      data-sidebar-nav-id={item.id}
      title={signInLabel ? `${item.label}, ${signInLabel}` : item.label}
      onClick={() => {
        const view = resolveNavSelection(item)
        if (view) onSelectView(view)
      }}
      className={
        'relative flex h-8 w-8 items-center justify-center rounded-md ' +
        (active
          ? 'bg-accent/[0.12] text-accent-soft'
          : 'text-text-subtle hover:text-[light-dark(#3f3f46,#d4d4d8)]')
      }
    >
      {item.icon}
      {/* A dot, not the count: the rail is 8 units wide and the number would not
       * read at that size. The count stays in the label and the tooltip. */}
      {signInLabel ? (
        <span
          aria-hidden="true"
          data-sidebar-nav-badge={item.id}
          className="absolute right-[5px] top-[5px] h-[6px] w-[6px] rounded-full bg-tone-warn"
        />
      ) : null}
    </button>
  )
}

/* ── Icons (ported from the design source's inline SVGs; attribute-only, no CSS) ── */

/** The brand paw beside "Cat Code" in the open rail's header (operator,
 * 2026-09-27; the collapsed rail stays bare). */
function PawLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <ellipse cx="6.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="11.5" cy="4" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="16.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="4" cy="9.5" rx="1.4" ry="2" opacity=".45" />
      <path d="M12 21.5c-4.2 0-7.5-2.3-7.5-6 0-1.9 1.1-3.6 2.8-4.6.75-.45 1.6-.65 2.3-.65h.8c.7 0 1.55.2 2.3.65 1.7.95 2.8 2.7 2.8 4.6 0 3.7-3.3 6-7.5 6z" />
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
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
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

function CollapseSidebarIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m14 7-5 5 5 5" />
      <path d="M20 5v14" />
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
