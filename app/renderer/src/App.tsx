import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { getBridge } from './bridge.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'
import { permissionActionForKey } from './PermissionPrompt.js'
import { PermissionQueue } from './PermissionQueue.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectAdditionalWorkingDirectories,
  selectPendingPermissionCount,
  selectPermissionContext,
  selectPermissionQueue,
  selectVisiblePermission,
} from './permissionState.js'
import {
  selectNonPlanPermissionQueue,
  selectPlanReview,
  type PlanApprovalMode,
  type PlanReview,
} from './planState.js'
import { PlanBar, PlanPanel } from './PlanPanel.js'
import { useToast } from './ToastHost.js'
import {
  activeAfterLiveChange,
  createShellState,
  reduceShellState,
  selectLiveSessions,
  sessionAtSlot,
  type ShellState,
} from './shellState.js'
import { deriveTabVisualState } from './tabStatus.js'
import { TabBar, tabLabel, type TabModel } from './TabBar.js'
import { Sidebar } from './Sidebar.js'
import { selectSidebarRows } from './sidebarState.js'
import { CommandPalette } from './CommandPalette.js'
import { buildPaletteItems, type PaletteItem } from './commandPaletteModel.js'
import { applyServerFrameBatch, withBatch } from './serverFrameBatch.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectSlashCommands,
  selectTranscriptRows,
  type TranscriptRow,
  type TranscriptState,
} from './transcriptProjector.js'
import { TranscriptView } from './TranscriptView.js'
import {
  completeSlashDraft,
  filterSlashCommands,
  nextSlashIndex,
  parseSlashDraft,
  SlashCommandPicker,
} from './SlashCommandPicker.js'
import {
  filterMentionItems,
  MentionPicker,
  type MentionItem,
} from './MentionPicker.js'
import {
  applyMention,
  createHistoryState,
  createPasteState,
  EMPTY_HISTORY_NAV,
  expandPasteRefs,
  formatPasteRef,
  navigateHistory,
  parseMentionQuery,
  reduceHistoryPushed,
  reducePasteAdded,
  reducePasteRemoved,
  reducePasteStateForDraftWrite,
  reduceSessionPastesCleared,
  selectAgentMentionItems,
  selectHistory,
  selectSessionPasteList,
  selectSessionPasteState,
  shouldCollapsePaste,
  type DraftWriteReason,
  type HistoryNav,
  type HistoryState,
  type PasteEntry,
  type PasteState,
} from './composerState.js'
import {
  WorkspaceLayout,
  type WorkspacePanelView,
} from './WorkspacePanels.js'
import {
  assignWorkspacePanelSession,
  closeWorkspacePanel,
  createWorkspaceLayout,
  focusOrAssignWorkspaceSession,
  focusWorkspacePanel,
  MAX_WORKSPACE_PANELS,
  readWorkspaceLayoutFromStorage,
  readyToRestoreLayout,
  reconcileWorkspaceLayout,
  setWorkspaceWidths,
  splitWorkspacePanel,
  workspaceLayoutsEqual,
  writeWorkspaceLayoutToStorage,
  type WorkspaceLayoutState,
  type WorkspaceSplitEdge,
} from './workspaceLayout.js'
import {
  createConnectionState,
  reduceConnectionState,
  selectConnection,
  type ConnectionSnapshot,
} from './connectionState.js'
import {
  createSettingsState,
  reduceSettingsState,
  selectSettingsSnapshot,
} from './settingsState.js'
import {
  createAgentConfigState,
  reduceAgentConfigState,
  selectAgentConfigSnapshot,
} from './agentConfigState.js'
import {
  createExtensionsState,
  reduceExtensionsState,
  selectExtensionsSnapshot,
} from './extensionsState.js'
import {
  createGoalMemoryState,
  reduceGoalMemoryState,
  selectMemorySnapshot,
  selectThreadGoalSnapshot,
} from './goalMemoryState.js'
import {
  createAccountsState,
  reduceAccountsState,
  selectAccountsSnapshot,
} from './accountsState.js'
import {
  createWorkspaceTrustState,
  reduceWorkspaceTrustState,
  selectWorkspaceTrustSnapshot,
} from './workspaceTrustState.js'
import {
  createDiagnosticsState,
  reduceDiagnosticsState,
  selectDiagnosticsSnapshot,
} from './diagnosticsState.js'
import {
  createRemoteSettingsState,
  reduceRemoteSettingsState,
  selectRemoteSettingsSnapshot,
} from './remoteSettingsState.js'
import {
  createTasksState,
  groupTaskItems,
  reduceTasksState,
  selectTasksSnapshot,
} from './tasksState.js'
import {
  createSessionsCatalogState,
  reduceSessionsCatalogState,
  selectMergedSessionRows,
  selectSessionsCatalog,
} from './sessionsCatalogState.js'
import { TasksDialog } from './TasksDialog.js'
import { GoalsPage } from './GoalsPage.js'
import { AccountsPage } from './AccountsPage.js'
import { SessionsPage } from './SessionsPage.js'
import { SettingsShell } from './SettingsShell.js'
import type {
  AccountVerbMessage,
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  RemoteVerbMessage,
  SessionId,
} from '../../shared/protocol.js'
import type {
  HostError,
  HostEvent,
  SessionDescriptor,
} from '../../shared/hostApi.js'

// Perf F3 (2026-07-08): batch-folding reducer variants, defined at module scope
// so their identity is stable across renders. A batched server-frame delivery is
// folded into each store in ONE dispatch (`applyServerFrameBatch`); single
// actions still pass straight through, so every other dispatch site is unchanged.
const reduceServerFrameBatched = withBatch(reduceServerFrame)
const projectServerFrameBatched = withBatch(projectServerFrame)
const reducePermissionStateBatched = withBatch(reducePermissionState)
const reduceConnectionStateBatched = withBatch(reduceConnectionState)
const reduceSettingsStateBatched = withBatch(reduceSettingsState)
const reduceAgentConfigStateBatched = withBatch(reduceAgentConfigState)
const reduceExtensionsStateBatched = withBatch(reduceExtensionsState)
const reduceGoalMemoryStateBatched = withBatch(reduceGoalMemoryState)
const reduceTasksStateBatched = withBatch(reduceTasksState)
const reduceAccountsStateBatched = withBatch(reduceAccountsState)
const reduceWorkspaceTrustStateBatched = withBatch(reduceWorkspaceTrustState)
const reduceDiagnosticsStateBatched = withBatch(reduceDiagnosticsState)
const reduceRemoteSettingsStateBatched = withBatch(reduceRemoteSettingsState)
const reduceSessionsCatalogStateBatched = withBatch(reduceSessionsCatalogState)

export function App() {
  const [state, dispatch] = useReducer(
    reduceServerFrameBatched,
    undefined,
    createRawMessageLogState,
  )
  const [transcript, dispatchSessionEvent] = useReducer(
    projectServerFrameBatched,
    undefined,
    createTranscriptState,
  )
  const [permissions, dispatchPermission] = useReducer(
    reducePermissionStateBatched,
    undefined,
    createPermissionState,
  )
  const toast = useToast()
  const [promptDrafts, setPromptDrafts] = useState<PromptDraftState>({})
  // P4-0 composer state, per-session-keyed exactly like `promptDrafts` so a
  // background session's collapsed pastes and input history survive a focus
  // switch (SessionPane unmounts for off-screen sessions). Renderer-local; never
  // crosses the wire.
  const [pasteState, setPasteState] = useState<PasteState>(createPasteState)
  const [historyState, setHistoryState] = useState<HistoryState>(createHistoryState)
  const [transportError, setTransportError] = useState<string | null>(null)
  const [shellError, setShellError] = useState<string | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  const [hostSnapshotReady, setHostSnapshotReady] = useState(false)
  const [workspaceLayout, setWorkspaceLayoutState] =
    useState<WorkspaceLayoutState>(
      () =>
        readWorkspaceLayoutFromStorage(getWorkspaceStorage()) ??
        createWorkspaceLayout(null),
    )
  // A persisted MULTI-panel split loaded at startup that must re-form once its
  // sessions are restored (P3-6 relaunch). Held here so the active layout can
  // degrade normally (the live startup session stays visible) while we wait to
  // snap the split back atomically. `null` for a fresh/single-panel layout.
  const [pendingRestore, setPendingRestore] =
    useState<WorkspaceLayoutState | null>(() => {
      const saved = readWorkspaceLayoutFromStorage(getWorkspaceStorage())
      return saved && saved.panels.length > 1 ? saved : null
    })
  const [connection, dispatchConnection] = useReducer(
    reduceConnectionStateBatched,
    undefined,
    createConnectionState,
  )
  const [settings, dispatchSettings] = useReducer(
    reduceSettingsStateBatched,
    undefined,
    createSettingsState,
  )
  const [agentConfig, dispatchAgentConfig] = useReducer(
    reduceAgentConfigStateBatched,
    undefined,
    createAgentConfigState,
  )
  const [extensions, dispatchExtensions] = useReducer(
    reduceExtensionsStateBatched,
    undefined,
    createExtensionsState,
  )
  const [goalMemory, dispatchGoalMemory] = useReducer(
    reduceGoalMemoryStateBatched,
    undefined,
    createGoalMemoryState,
  )
  const [accounts, dispatchAccounts] = useReducer(
    reduceAccountsStateBatched,
    undefined,
    createAccountsState,
  )
  const [workspaceTrust, dispatchWorkspaceTrust] = useReducer(
    reduceWorkspaceTrustStateBatched,
    undefined,
    createWorkspaceTrustState,
  )
  const [diagnostics, dispatchDiagnostics] = useReducer(
    reduceDiagnosticsStateBatched,
    undefined,
    createDiagnosticsState,
  )
  const [remoteSettings, dispatchRemoteSettings] = useReducer(
    reduceRemoteSettingsStateBatched,
    undefined,
    createRemoteSettingsState,
  )
  const [tasks, dispatchTasks] = useReducer(
    reduceTasksStateBatched,
    undefined,
    createTasksState,
  )
  const [sessionsCatalog, dispatchSessionsCatalog] = useReducer(
    reduceSessionsCatalogStateBatched,
    undefined,
    createSessionsCatalogState,
  )
  const [tasksOpen, setTasksOpen] = useState(false)
  const [activeView, setActiveView] = useState<
    'chat' | 'sessions' | 'goals' | 'accounts' | 'settings'
  >('chat')
  // The app-level session roster — a projection of the host control plane's
  // HostEvent stream (REGISTRY §6.1), not a poll loop. Seeded once from
  // listSessions() below, then kept live off subscribeHost.
  const [shell, dispatchShell] = useReducer(
    reduceShell,
    undefined,
    createShellState,
  )
  // Mirror the roster so the host-event handler (subscribed once) can read the
  // live order without re-subscribing — used to compute the neighbour tab when
  // the active tab is removed.
  const shellRef = useRef(shell)
  shellRef.current = shell
  // Ids a live `session-removed` dropped before the initial snapshot folded in —
  // so the baseline hydrate never resurrects a row the host already reaped (F3).
  const removedIdsRef = useRef<Set<SessionId>>(new Set())

  useEffect(() => {
    const bridge = getBridge()
    // Main delivers a batch of frames per IPC message (perf F3). Fold the whole
    // batch into every store with ONE dispatch each — so a restore replay is 9
    // dispatches, not 9 per frame. Focus semantics are unchanged: a background
    // frame never steals focus from another live tab. See serverFrameBatch.ts.
    const unsubscribe = bridge.subscribe(frames => {
      applyServerFrameBatch(frames, {
        getRosterById: () => shellRef.current.byId,
        setActiveSessionId,
        dispatchRawLog: dispatch,
        dispatchPermission,
        dispatchConnection,
        dispatchSettings,
        dispatchAgentConfig,
        dispatchExtensions,
        dispatchGoalMemory,
        dispatchTasks,
        dispatchAccounts,
        dispatchWorkspaceTrust,
        dispatchDiagnostics,
        dispatchRemoteSettings,
        dispatchSessionsCatalog,
        dispatchTranscript: dispatchSessionEvent,
      })
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  // Host control plane: hydrate the roster once, then stay live off the event
  // stream. Switching tabs never unsubscribes anything (the P2 frame stream and
  // the P3-4 stores are keyed by sessionId and stay resident); this projection
  // is purely additive UI state layered over them.
  //
  // Active-selection follows the roster ONLY on the two events that change which
  // tabs exist, never on the reducer snapshot: this way a frame-driven active
  // session (one whose ready frame led its session-added, or the headless probe
  // that emits no host event) is never clobbered by a stale roster.
  useEffect(() => {
    const bridge = getBridge()
    let cancelled = false
    // Subscribe-before-snapshot (F3): install the live stream FIRST so no
    // session-added/status/removed can slip through the gap between the snapshot
    // read and the subscription. The snapshot is then folded as a BASELINE that
    // never clobbers a newer live event already applied (reduceShell hydrate).
    const unsubscribe = bridge.subscribeHost(event => {
      // A new/restored tab appears in the bar but does NOT steal the pane — a
      // spawning session has nothing to show; it becomes active when it starts
      // streaming (the frame path above), when the user clicks it, or via the
      // "nothing active" fallback below. Focus corrections (moving OFF a
      // now-non-live active tab) run in the post-commit effect below, which
      // reads the RECONCILED roster — reading shellRef here would see the
      // pre-event state (the reducer commits on the next render).
      if (event.type === 'session-removed') {
        removedIdsRef.current.add(event.appSessionId)
      }
      dispatchShell({ type: 'event', event })
    })
    void bridge
      .listSessions()
      .then(sessions => {
        if (!cancelled) {
          dispatchShell({
            type: 'hydrate',
            sessions,
            removed: removedIdsRef.current,
          })
        }
      })
      .catch(() => {
        /* a failed initial list degrades to a live-only roster */
      })
      .finally(() => {
        if (!cancelled) setHostSnapshotReady(true)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Focus correction (F1) — runs AFTER the roster commits, so it sees the
  // reconciled live-tab set. Two cases, both against the LIVE projection (the
  // TabBar's view), so a closed→restorable active session (which left the bar
  // but stayed in the roster) is handled just like a removal:
  //  1. the active session is no longer a LIVE tab → move focus to the first
  //     remaining live tab, or null (empty shell);
  //  2. nothing is active but live tabs exist (e.g. relaunch with only
  //     restorable rows that just went live) → show the first live tab.
  // A frame arriving for any session still wins the pane first (it sets active
  // before this runs). Restorable-only rows never auto-focus — they're the
  // Sidebar's restore-offer, not tabs.
  useEffect(() => {
    const liveOrder = selectLiveSessions(shell).map(
      descriptor => descriptor.appSessionId,
    )
    setActiveSessionId(current => {
      if (current !== null) return activeAfterLiveChange(current, liveOrder)
      return liveOrder[0] ?? null
    })
  }, [shell])

  const activeConnection = selectConnection(connection, activeSessionId)

  // Build one tab model per live session, fusing the host descriptor with the
  // per-session connection view + pending-permission count (the background
  // attention badge). Every tab is computed from its OWN sessionId slice, so a
  // background tab's status/badge is correct without it being active.
  const tabs: TabModel[] = useMemo(
    () =>
      selectLiveSessions(shell).map(descriptor => ({
        descriptor,
        visual: deriveTabVisualState({
          descriptor,
          connection: selectConnection(connection, descriptor.appSessionId),
          pendingPermissionCount: selectPendingPermissionCount(
            permissions,
            descriptor.appSessionId,
          ),
          isActive: descriptor.appSessionId === activeSessionId,
        }),
      })),
    [shell, connection, permissions, activeSessionId],
  )
  const liveSessionIds = useMemo(
    () => tabs.map(tab => tab.descriptor.appSessionId),
    [tabs],
  )
  const liveSessionKey = liveSessionIds.join('\u0000')
  const tabDescriptorsById = useMemo(
    () =>
      new Map(
        tabs.map(tab => [tab.descriptor.appSessionId, tab.descriptor] as const),
      ),
    [tabs],
  )

  // The Sidebar's own projection of the SAME roster (live ∪ restorable), in
  // stable arrival order (same order the TabBar uses — see sidebarState.ts) —
  // not a second data source, and not a poll loop: it reads the
  // HostEvent-driven `shell` state the TabBar reads (App seeded it once from
  // listSessions, then keeps it live off subscribeHost).
  const sidebarRows = useMemo(() => selectSidebarRows(shell), [shell])

  // P4-6a — the merged Sessions catalog: the host registry rows (openable) ∪
  // the sidecar engine-history snapshot (rich metadata), via the shared
  // selector (reused by P4-17 Welcome recents, D5).
  const sessionCatalogSnapshot = selectSessionsCatalog(sessionsCatalog, activeSessionId)
  const sessionCatalogRows = useMemo(
    () =>
      selectMergedSessionRows(
        sidebarRows.map(row => row.descriptor),
        sessionCatalogSnapshot,
      ),
    [sidebarRows, sessionCatalogSnapshot],
  )

  useEffect(() => {
    if (!hostSnapshotReady && liveSessionIds.length === 0) return
    setWorkspaceLayoutState(current => {
      const next = reconcileWorkspaceLayout(
        current,
        liveSessionIds,
        activeSessionId,
      )
      return workspaceLayoutsEqual(current, next) ? current : next
    })
    // liveSessionKey is the stable content signature of liveSessionIds; keying
    // the effect on the key (not the array identity, which churns every tabs
    // recompute) is the whole point of computing it.
  }, [activeSessionId, hostSnapshotReady, liveSessionKey])

  // Re-apply-on-restore (P3-6): the held `pendingRestore` split snaps back once
  // EVERY session it references is live again — order-independent, overriding
  // whatever the operator clicked while restoring. Abandoned if a referenced
  // session is unrecoverable (neither live nor restorable), which unblocks the
  // disk write below so the operator's actual layout can persist instead.
  const restorableIds = useMemo(
    () =>
      sidebarRows
        .filter(row => row.visual.restorable)
        .map(row => row.descriptor.appSessionId),
    [sidebarRows],
  )
  const rosterKey = [...liveSessionIds, ...restorableIds].join(' ')
  useEffect(() => {
    if (!pendingRestore || !hostSnapshotReady) return
    const ready = readyToRestoreLayout(pendingRestore, liveSessionIds)
    if (ready) {
      setWorkspaceLayoutState(ready)
      setPendingRestore(null)
      return
    }
    const known = new Set<SessionId>([...liveSessionIds, ...restorableIds])
    if (pendingRestore.panels.some(panel => !known.has(panel.sessionId))) {
      setPendingRestore(null) // a referenced session is gone; stop waiting
    }
    // rosterKey is the stable signature of live ∪ restorable ids.
  }, [pendingRestore, hostSnapshotReady, rosterKey])

  useEffect(() => {
    // Don't let a startup-transient degrade overwrite the saved split while it
    // is still awaiting restore (pendingRestore) — that was the relaunch bug.
    if (!hostSnapshotReady || pendingRestore) return
    writeWorkspaceLayoutToStorage(getWorkspaceStorage(), workspaceLayout)
  }, [hostSnapshotReady, pendingRestore, workspaceLayout])

  const newSession = useCallback(async () => {
    const bridge = getBridge()
    try {
      // HC1 — the renderer never authors a path: pick → one-time token → create.
      const token = await bridge.pickDirectory(activeSessionId)
      if (!token) return // cancelled
      const result = await bridge.createSession({ cwdToken: token })
      if (result.ok) {
        setActiveSessionId(result.value.appSessionId)
        setActiveView('chat')
        setShellError(null)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [activeSessionId])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const bridge = getBridge()
    if (!bridge.reportDebugShellState) return
    const timer = window.setTimeout(() => {
      bridge.reportDebugShellState?.(
        buildDebugShellStateSnapshot({
          shell,
          connection,
          permissions,
          activeSessionId,
        }),
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [shell, connection, permissions, activeSessionId])

  const selectTab = useCallback((sessionId: SessionId) => {
    // Pure UI focus — never touches the frame stream or the P3-4 stores, so no
    // in-flight streaming into a background session is lost on switch.
    const result = focusOrAssignWorkspaceSession(workspaceLayout, sessionId)
    setWorkspaceLayoutState(result.state)
    setLayoutNotice(null)
    setActiveSessionId(sessionId)
    setActiveView('chat')
  }, [workspaceLayout])

  // P4-5 — dispatch an account lifecycle verb to the active session's sidecar.
  // The renderer only NAMES a target; the sidecar re-resolves + re-validates it
  // (T6). The verb rides the HC3 fixed `accountVerb` channel. The outcome returns
  // as an `account.result` frame (→ accountsState.lastResult).
  const sendAccountVerb = useCallback(
    (verb: AccountVerbMessage) => {
      if (!activeSessionId) return
      getBridge().accountVerb(activeSessionId, verb)
    },
    [activeSessionId],
  )

  // P4-13 — dispatch a RemoteSettings verb (bridge toggle / direct-connect) to
  // the active session's sidecar. The outcome returns as a
  // `remoteSettings.result` frame (→ remoteSettings.lastResult).
  const sendRemoteSettingsVerb = useCallback(
    (verb: RemoteVerbMessage) => {
      if (!activeSessionId) return
      getBridge().remoteSettingsVerb(activeSessionId, verb)
    },
    [activeSessionId],
  )

  const focusWorkspacePanelSession = useCallback(
    (index: number, sessionId: SessionId) => {
      setWorkspaceLayoutState(current => focusWorkspacePanel(current, index))
      setActiveSessionId(sessionId)
    },
    [],
  )

  const selectWorkspacePanelSession = useCallback(
    (index: number, sessionId: SessionId) => {
      const result = assignWorkspacePanelSession(
        workspaceLayout,
        index,
        sessionId,
      )
      setWorkspaceLayoutState(result.state)
      // Deliberately building a layout abandons any awaited saved-split restore
      // so it can't later clobber what the operator is constructing now.
      setPendingRestore(null)
      setActiveSessionId(
        result.state.panels[result.focusedIndex]?.sessionId ?? sessionId,
      )
      setLayoutNotice(
        result.blocked === 'duplicate'
          ? `${sessionDisplayName(sessionId, tabDescriptorsById)} is already open in panel ${result.focusedIndex + 1}; focused that panel instead.`
          : null,
      )
    },
    [tabDescriptorsById, workspaceLayout],
  )

  const splitWorkspacePanelWithSession = useCallback(
    (index: number, edge: WorkspaceSplitEdge, sessionId: SessionId) => {
      const result = splitWorkspacePanel(workspaceLayout, index, edge, sessionId)
      setWorkspaceLayoutState(result.state)
      setPendingRestore(null)
      setActiveSessionId(
        result.state.panels[result.focusedIndex]?.sessionId ?? sessionId,
      )
      setLayoutNotice(
        result.blocked === 'duplicate'
          ? `${sessionDisplayName(sessionId, tabDescriptorsById)} is already open in panel ${result.focusedIndex + 1}; focused that panel instead.`
          : result.blocked === 'max-panels'
            ? 'Workspace layout supports up to three panels.'
            : null,
      )
    },
    [tabDescriptorsById, workspaceLayout],
  )

  const closeWorkspacePanelAt = useCallback(
    (index: number) => {
      const next = closeWorkspacePanel(workspaceLayout, index)
      setWorkspaceLayoutState(next)
      setPendingRestore(null)
      setActiveSessionId(
        next.panels[next.activeIndex]?.sessionId ?? activeSessionId,
      )
      setLayoutNotice(null)
    },
    [activeSessionId, workspaceLayout],
  )

  const updateWorkspaceWidths = useCallback((widths: number[]) => {
    setWorkspaceLayoutState(current => setWorkspaceWidths(current, widths))
  }, [])

  // TabBar Split (P4-4): open the next un-panelled live session as a new panel,
  // split off the active panel's right edge. Reuses the SAME split reducer the
  // drag-tab-to-edge path uses (P3-6) — no new wiring. The layout model forbids
  // the same session in two panels, so "split" adds a DIFFERENT session (the
  // prototype duplicates the active one; §0 flag on TabBar).
  const addWorkspacePanel = useCallback(() => {
    if (workspaceLayout.panels.length >= MAX_WORKSPACE_PANELS) return
    const shown = new Set(workspaceLayout.panels.map(panel => panel.sessionId))
    const next = liveSessionIds.find(id => !shown.has(id))
    if (!next) {
      setLayoutNotice(
        'No other session to open in a split — create or select another session first.',
      )
      return
    }
    splitWorkspacePanelWithSession(workspaceLayout.activeIndex, 'right', next)
  }, [liveSessionIds, splitWorkspacePanelWithSession, workspaceLayout])

  // TabBar Unsplit (P4-4): drop the last panel — the existing close-panel path.
  const removeWorkspacePanel = useCallback(() => {
    if (workspaceLayout.panels.length <= 1) return
    closeWorkspacePanelAt(workspaceLayout.panels.length - 1)
  }, [closeWorkspacePanelAt, workspaceLayout])

  const closeTab = useCallback(async (sessionId: SessionId) => {
    // Non-destructive: closeSession keeps the registry row and emits
    // session-status(exited, restorable) — NOT session-removed (the row stays in
    // the live∪restorable roster). The tab leaves the TabBar because that clean
    // -close descriptor revokes tab membership in the shell reducer (a CRASH —
    // restorable + disconnected — would keep it); the row then surfaces in the
    // Sidebar as a restorable restore-offer. No optimistic local delete — the
    // projection follows the HostEvent.
    const bridge = getBridge()
    try {
      const result = await bridge.closeSession(sessionId)
      if (!result.ok) setShellError(hostErrorMessage(result.error))
      else setShellError(null)
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  const restartTab = useCallback((sessionId: SessionId) => {
    // The dead-tab affordance: re-spawn over the existing CH_RESTART channel.
    try {
      getBridge().restart(sessionId)
      setShellError(null)
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  // The ONE real restore call (host.restoreSession via the bridge). Picking a
  // restorable row (Sidebar restore-offer / ⌘K palette) fires this directly —
  // no confirm dialog, no hydration overlay: the row re-spawns its engine and
  // becomes a live tab off the resulting session-added/status HostEvents (not
  // an optimistic local add), and its transcript replays into the pane as
  // replay:true event frames (F1 seed + F2 replay — RESTORE-HISTORY.md).
  // Restore failures surface in the existing shell-error banner.
  const performRestore = useCallback(async (sessionId: SessionId) => {
    const bridge = getBridge()
    try {
      const result = await bridge.restoreSession(sessionId)
      if (result.ok) {
        setActiveSessionId(result.value.appSessionId)
        setActiveView('chat')
        setShellError(null)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  function submitSession(
    sessionId: SessionId,
    event: FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault()
    const sessionLog = selectRawMessageLog(state, sessionId)
    const sessionConnection = selectConnection(connection, sessionId)
    const sessionPrompt = selectPromptDraft(promptDrafts, sessionId)
    // Expand collapsed-paste tokens back to their full text before submit — the
    // engine receives plain prompt text, never a `[Pasted text #N]` ref (parity
    // with `expandPastedTextRefs`, src/history.ts:81 / handlePromptSubmit.ts:216).
    const pasteEntries = selectSessionPasteState(pasteState, sessionId).entries
    const text = expandPasteRefs(sessionPrompt, pasteEntries).trim()
    if (
      !sessionLog.inputEnabled ||
      !sessionConnection.inputEnabled ||
      text.length === 0
    ) return

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    try {
      getBridge().submit(sessionId, text)
      setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, ''))
      setPasteState(prev => reduceSessionPastesCleared(prev, sessionId))
      setHistoryState(prev => reduceHistoryPushed(prev, sessionId, text))
      setTransportError(null)
    } catch (error) {
      setTransportError(errorMessage(error))
    }
  }

  const setSessionPrompt = useCallback(
    (
      sessionId: SessionId,
      value: string,
      reason: DraftWriteReason = 'edit',
    ) => {
      setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, value))
      // Prune only on a genuine edit; a transient ↑/↓ history-nav write must NOT
      // drop a live, uncommitted paste that ↓ is about to restore.
      setPasteState(prev =>
        reducePasteStateForDraftWrite(prev, sessionId, value, reason),
      )
    },
    [],
  )

  const addSessionPaste = useCallback(
    (sessionId: SessionId, currentDraft: string, content: string): void => {
      const { state: nextPasteState, token } = reducePasteAdded(
        pasteState,
        sessionId,
        content,
      )
      setPasteState(nextPasteState)
      setSessionPrompt(sessionId, currentDraft + token)
    },
    [pasteState, setSessionPrompt],
  )

  const removeSessionPaste = useCallback(
    (sessionId: SessionId, currentDraft: string, entry: PasteEntry): void => {
      setPasteState(prev => reducePasteRemoved(prev, sessionId, entry.id))
      const token = formatPasteRef(entry.id, entry.numLines)
      setSessionPrompt(sessionId, currentDraft.replace(token, ''))
    },
    [setSessionPrompt],
  )

  const permissionQueue =
    activeConnection.status === 'ready'
      ? selectPermissionQueue(permissions, activeSessionId)
      : []
  // The card the keyboard shortcuts act on: first un-answered, un-snoozed.
  const pendingPermission =
    activeConnection.status === 'ready'
      ? selectVisiblePermission(permissions, activeSessionId)
      : null

  const respondToPermission = useCallback(
    (
      sessionId: SessionId,
      requestId: string,
      response: PermissionResponseInput,
    ) => {
      dispatchPermission({ type: 'submitted', sessionId, requestId })
      const error = sendPermissionResponse(
        getBridge(),
        sessionId,
        requestId,
        response,
      )
      if (error) {
        dispatchPermission({ type: 'submissionFailed', sessionId, requestId })
        setTransportError(error)
      } else {
        setTransportError(null)
      }
    },
    [],
  )

  const allowPermission = useCallback(
    (requestId: string, applySuggestions: number[] = []) => {
      const sessionId = activeSessionId
      if (!sessionId) return
      const item = permissionQueue.find(
        candidate => candidate.request.requestId === requestId,
      )
      if (!item) return
      respondToPermission(
        sessionId,
        requestId,
        buildAllowResponse(item.request, applySuggestions),
      )
    },
    [activeSessionId, permissionQueue, respondToPermission],
  )

  const denyPermission = useCallback(
    (requestId: string, message?: string) => {
      if (!activeSessionId) return
      respondToPermission(activeSessionId, requestId, buildDenyResponse(message))
    },
	    [activeSessionId, respondToPermission],
  )

  useEffect(() => {
    if (!pendingPermission || !activeSessionId) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Never hijack keys while the user is typing (e.g. deny feedback).
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return
      }
      const action = permissionActionForKey(event)
      if (!action) return

      event.preventDefault()
      if (action === 'allow') {
        allowPermission(pendingPermission.requestId, [])
      } else if (action === 'deny') {
        denyPermission(pendingPermission.requestId)
      } else {
        dispatchPermission({
          type: 'dismissed',
          sessionId: activeSessionId,
          requestId: pendingPermission.requestId,
        })
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    allowPermission,
    denyPermission,
    pendingPermission,
    activeSessionId,
  ])

  // Shell keyboard: keyboard-first tab switching + create/close, matching the
  // prototype's chords (⌘T new · ⌘W close · ⌘1..9 jump-to-tab). Only fires on a
  // meta/ctrl chord, so it never collides with the plain-key permission
  // shortcuts above (permissionActionForKey ignores modified keys).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key === 'k' || event.key === 'K') {
        // ⌘K toggles the command palette. Palette-internal keys (↑↓/↵/Esc) are
        // handled on its own focused input, so this only owns the open chord.
        event.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        void newSession()
        return
      }
      if (event.key === 'w' || event.key === 'W') {
        if (!activeSessionId) return
        event.preventDefault()
        void closeTab(activeSessionId)
        return
      }
      if (event.key >= '1' && event.key <= '9') {
        const target = sessionAtSlot(shell, Number(event.key))
        if (!target) return
        event.preventDefault()
        selectTab(target)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [shell, activeSessionId, newSession, closeTab, selectTab])

  function copyForLlm(sessionId: SessionId): void {
    const text = buildDebugExport(
      selectTranscriptRows(transcript, sessionId),
      selectRawMessageLog(state, sessionId),
    )
    void navigator.clipboard.writeText(text)
  }

  const workspacePanels: WorkspacePanelView[] = workspaceLayout.panels
    .map(panel => {
	      const sessionId = panel.sessionId
	      const sessionLog = selectRawMessageLog(state, sessionId)
	      const sessionConnection = selectConnection(connection, sessionId)
	      const sessionPermissionQueue =
	        sessionConnection.status === 'ready'
	          ? selectPermissionQueue(permissions, sessionId)
	          : []
	      // P4-11: PlanBar/PlanPanel own the ExitPlanMode request exclusively
	      // (TUI parity — it has its own dedicated renderer, not the generic
	      // per-tool card); the generic queue below is shown minus that request.
	      const sessionPlanReview =
	        sessionConnection.status === 'ready'
	          ? selectPlanReview(permissions, sessionId)
	          : null
	      const sessionDisplayQueue =
	        sessionConnection.status === 'ready'
	          ? selectNonPlanPermissionQueue(permissions, sessionId)
	          : []
	      const descriptor = tabDescriptorsById.get(sessionId)
	      const panelPartialCount = sessionLog.messages.filter(
	        message => message.type === 'stream_event',
	      ).length
	      return {
	        sessionId,
	        descriptor,
	        connection: sessionConnection,
	        content: (
	          <SessionPane
	            activeConnection={sessionConnection}
	            activeDescriptor={descriptor}
	            activeLog={sessionLog}
	            activeSessionId={sessionId}
	            allowPermission={(requestId, applySuggestions = []) => {
	              const item = sessionPermissionQueue.find(
	                candidate => candidate.request.requestId === requestId,
	              )
	              if (!item) return
	              respondToPermission(
	                sessionId,
	                requestId,
	                buildAllowResponse(item.request, applySuggestions),
	              )
	            }}
	            copyForLlm={() => copyForLlm(sessionId)}
	            denyPermission={(requestId, message) =>
	              respondToPermission(
	                sessionId,
	                requestId,
	                buildDenyResponse(message),
	              )
	            }
	            onApprovePlan={mode => {
	              if (!sessionPlanReview) return
	              try {
	                getBridge().setPermissionMode(sessionId, mode)
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	                return
	              }
	              const requestId = sessionPlanReview.request.requestId
	              const item = sessionPermissionQueue.find(
	                candidate => candidate.request.requestId === requestId,
	              )
	              if (!item) return
	              respondToPermission(
	                sessionId,
	                requestId,
	                buildAllowResponse(item.request, []),
	              )
	              toast(
	                `Plan approved · ${mode === 'acceptEdits' ? 'auto-accept edits' : 'ask per edit'}`,
	                { tone: 'success' },
	              )
	            }}
	            onRevisePlan={message => {
	              if (!sessionPlanReview) return
	              respondToPermission(
	                sessionId,
	                sessionPlanReview.request.requestId,
	                buildDenyResponse(message),
	              )
	              toast('Sent. The agent will revise the plan.', { tone: 'info' })
	            }}
	            partialCount={panelPartialCount}
	            permissionContext={selectPermissionContext(permissions, sessionId)}
	            permissionQueue={sessionDisplayQueue}
	            planReview={sessionPlanReview}
	            prompt={selectPromptDraft(promptDrafts, sessionId)}
	            restorePermission={requestId => {
	              dispatchPermission({
	                type: 'restored',
	                sessionId,
	                requestId,
	              })
	            }}
	            setPermissionMode={mode => {
	              try {
	                getBridge().setPermissionMode(sessionId, mode)
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	              }
	            }}
	            setPrompt={(value, reason) =>
	              setSessionPrompt(sessionId, value, reason)
	            }
	            submit={event => submitSession(sessionId, event)}
	            mentionItems={selectAgentMentionItems(
	              selectAgentConfigSnapshot(agentConfig, sessionId),
	            )}
	            pastes={selectSessionPasteList(pasteState, sessionId)}
	            history={selectHistory(historyState, sessionId)}
	            onPaste={content =>
	              addSessionPaste(
	                sessionId,
	                selectPromptDraft(promptDrafts, sessionId),
	                content,
	              )
	            }
	            onRemovePaste={entry =>
	              removeSessionPaste(
	                sessionId,
	                selectPromptDraft(promptDrafts, sessionId),
	                entry,
	              )
	            }
	            transcript={transcript}
	            transportError={transportError}
	          />
	        ),
	      }
	    })
	    .filter(panel => panel.descriptor)

  // The ⌘K palette inventory — every entry is a real action wired to an existing
  // App handler (no mocked rows). Actions needing an active session / open panel
  // are omitted when unavailable, and the session rows ARE the search corpus
  // (the same live ∪ restorable roster the Sidebar renders). Built only while the
  // palette is open: the palette owns its own query state, so App re-renders come
  // only from streaming frames / composer keystrokes — rebuilding the inventory
  // (and its closures) on those while the palette is closed is pure waste.
  const paletteItems = paletteOpen
    ? buildPaletteItems({
        rows: sidebarRows,
        activeSessionId,
        hasPanels: workspacePanels.length > 0,
        handlers: {
          newSession: () => void newSession(),
          closeActiveSession: () => {
            if (activeSessionId) void closeTab(activeSessionId)
          },
          restartActiveSession: () => {
            if (activeSessionId) restartTab(activeSessionId)
          },
          copyActiveTranscript: () => {
            if (activeSessionId) copyForLlm(activeSessionId)
          },
          closeCurrentPanel: () =>
            closeWorkspacePanelAt(workspaceLayout.activeIndex),
          selectLiveSession: selectTab,
          restoreSession: sessionId => void performRestore(sessionId),
          openTasks: () => setTasksOpen(true),
        },
      })
    : EMPTY_PALETTE_ITEMS

  return (
    <div className="flex h-screen bg-app-bg font-sans text-text-primary">
      {/* Sidebar rail (P3-5b): the full roster (live ∪ restorable) + the
       * restore-offer, alongside the TabBar's live-only view. */}
      <Sidebar
        rows={sidebarRows}
        activeSessionId={activeSessionId}
        activeView={activeView}
        onSelectView={view => setActiveView(view)}
        onSelectLive={selectTab}
        onRestore={sessionId => void performRestore(sessionId)}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabs}
          activeSessionId={activeSessionId}
          onSelect={selectTab}
          onClose={closeTab}
          onRestart={restartTab}
          onNewTab={newSession}
          panelCount={workspaceLayout.panels.length}
          canAddPanel={liveSessionIds.length > workspaceLayout.panels.length}
          onAddPanel={addWorkspacePanel}
          onRemovePanel={removeWorkspacePanel}
        />

        {shellError ? (
          <div className="border-b border-shell-seam bg-shell-chrome px-6 py-1.5 text-xs text-tone-danger">
            {shellError}
          </div>
        ) : null}

        {/* The workspace panels are renderer-owned layout over the P3-4
         * session-keyed stores. Each panel reads its own session slice, so visible
         * background sessions keep rendering without becoming the active tab. */}
        {activeView === 'settings' ? (
          <SettingsShell
            additionalWorkingDirectories={selectAdditionalWorkingDirectories(
              permissions,
              activeSessionId,
            )}
            agentsSnapshot={selectAgentConfigSnapshot(agentConfig, activeSessionId)}
            cwd={activeSessionId ? tabDescriptorsById.get(activeSessionId)?.cwd ?? null : null}
            diagnosticsSnapshot={selectDiagnosticsSnapshot(diagnostics, activeSessionId)}
            extensionsSnapshot={selectExtensionsSnapshot(extensions, activeSessionId)}
            initialCategory="agents"
            memorySnapshot={selectMemorySnapshot(goalMemory, activeSessionId)}
            onRemoteVerb={sendRemoteSettingsVerb}
            remoteLastResult={remoteSettings.lastResult}
            remoteSnapshot={selectRemoteSettingsSnapshot(remoteSettings, activeSessionId)}
            snapshot={selectSettingsSnapshot(settings, activeSessionId)}
            workspaceTrustSnapshot={selectWorkspaceTrustSnapshot(
              workspaceTrust,
              activeSessionId,
            )}
          />
        ) : activeView === 'goals' ? (
          <GoalsPage
            sessionLabel={
              activeSessionId
                ? tabDescriptorsById.get(activeSessionId)?.cwd ?? activeSessionId
                : undefined
            }
            snapshot={selectThreadGoalSnapshot(goalMemory, activeSessionId)}
          />
        ) : activeView === 'accounts' ? (
          <AccountsPage
            snapshot={selectAccountsSnapshot(accounts, activeSessionId)}
            lastResult={accounts.lastResult}
            onVerb={sendAccountVerb}
          />
        ) : activeView === 'sessions' ? (
          <SessionsPage
            rows={sessionCatalogRows}
            activeCwd={
              activeSessionId
                ? tabDescriptorsById.get(activeSessionId)?.cwd ?? null
                : null
            }
            truncated={sessionCatalogSnapshot?.truncated ?? false}
            catalogLoaded={sessionCatalogSnapshot !== null}
            onOpenRow={row => {
              if (row.appSessionId == null) return
              if (row.live) selectTab(row.appSessionId)
              else void performRestore(row.appSessionId)
            }}
            onNewSession={() => void newSession()}
          />
        ) : workspacePanels.length === 0 || !activeSessionId ? (
          <EmptyShell onNewTab={newSession} />
        ) : (
	          <WorkspaceLayout
	            layout={workspaceLayout}
	            panels={workspacePanels}
	            sessions={tabs.map(tab => tab.descriptor)}
	            notice={layoutNotice}
	            onClosePanel={closeWorkspacePanelAt}
	            onFocusPanel={focusWorkspacePanelSession}
	            onSelectSession={selectWorkspacePanelSession}
	            onSplitPanel={splitWorkspacePanelWithSession}
	            onWidthsChange={updateWorkspaceWidths}
          />
        )}

        {/* In-session background-task strip (P4-9). The prototype's `TasksPanel`
         * (OrchestratorMode.jsx) is unanchored GUI (⚓0, INVENTORY §W4) — it's
         * really P4-8's unbuilt orchestrator worker/lease roster, not this
         * dialog's entry point. This pill is the grounded analog: the real
         * footer summary pill (`BackgroundTaskStatus.tsx`, `getPillLabel`),
         * scoped to the active session, opening the same TasksDialog ⌘K does. */}
        {activeView === 'chat' && activeSessionId ? (
          <TasksStrip
            snapshot={selectTasksSnapshot(tasks, activeSessionId)}
            onOpen={() => setTasksOpen(true)}
          />
        ) : null}
      </div>

      {/* ⌘K command palette (P3-7): a fixed overlay above the whole shell. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />

      {/* Background tasks dialog (P4-9): ⌘K → "Background tasks" or the strip pill. */}
      <TasksDialog
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        snapshot={selectTasksSnapshot(tasks, activeSessionId)}
        hasActiveSession={activeSessionId !== null}
      />
    </div>
  )
}

/**
 * The real `BackgroundTaskStatus.tsx` footer pill, adapted: a compact count of
 * active background tasks for the current session, opening `TasksDialog` on
 * click. Renders nothing when there are no active tasks (same as the source
 * component returning `null`, `BackgroundTaskStatus.tsx:195-197`).
 */
function TasksStrip({
  snapshot,
  onOpen,
}: {
  snapshot: ReturnType<typeof selectTasksSnapshot>
  onOpen: () => void
}) {
  const active = groupTaskItems(snapshot).active
  if (active.length === 0) return null
  return (
    <button
      className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-shell-seam bg-shell-chrome px-3 py-1.5 text-xs text-text-muted shadow-[0_10px_30px_rgba(0,0,0,0.5)] hover:text-text-primary"
      onClick={onOpen}
      type="button"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {active.length} background {active.length === 1 ? 'task' : 'tasks'}
    </button>
  )
}

/** The shell with no live sessions — invites creating the first one (HC1). */
function EmptyShell({ onNewTab }: { onNewTab: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="text-sm text-text-muted">No sessions open.</p>
      <button
        className="rounded bg-accent px-4 py-2 text-sm text-app-bg"
        onClick={onNewTab}
        type="button"
      >
        New session
      </button>
      <p className="text-xs text-text-subtle">or press ⌘T</p>
    </div>
  )
}

/**
 * One session pane — the P2 transcript spine + prompt + permission surfaces.
 * App supplies one instance per visible workspace panel, scoped to that panel's
 * session id; switching focus never tears down a background session's state.
 */
export function SessionPane({
  activeConnection,
  activeDescriptor,
  activeLog,
  activeSessionId,
  allowPermission,
  copyForLlm,
  denyPermission,
  history,
  mentionItems,
  onApprovePlan,
  onPaste,
  onRemovePaste,
  onRevisePlan,
  partialCount,
  pastes,
  permissionContext,
  permissionQueue,
  planReview,
  prompt,
  restorePermission,
  setPermissionMode,
  setPrompt,
  submit,
  transcript,
  transportError,
}: SessionPaneProps) {
  // SlashCommandPicker (P3-7): typeahead over THIS session's real slash catalog
  // (the `slash_commands` the sidecar's `getCommands(cwd)` produced, captured
  // from the init frame). Picking inserts `/name ` into the draft; the user
  // submits it verbatim through the existing app.submit — no command-execution
  // capability is added to the renderer.
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // P1-2 raw-frame debug view (F2, 2026-07-08): collapsed by default and its
  // body rendered ONLY when opened. Stringifying + wrapping the whole retained
  // log (up to 8 MiB) was the dominant DOM reflow on every switch/frame/keystroke;
  // gated + capped to the last 20 messages, it costs nothing until asked for.
  const [rawDebugOpen, setRawDebugOpen] = useState(false)
  const slashCommands = selectSlashCommands(transcript, activeSessionId)
  const slashQuery = parseSlashDraft(prompt)
  const slashMatches =
    slashQuery === null ? [] : filterSlashCommands(slashCommands, slashQuery)
  const slashOpen =
    !slashDismissed && slashQuery !== null && slashMatches.length > 0
  const slashIndex =
    slashMatches.length === 0
      ? 0
      : Math.min(slashActiveIndex, slashMatches.length - 1)

  // Reset selection (and re-open after an Escape) whenever the query text
  // changes — i.e. the user typed. Keyed on the query so an Escape (which does
  // not change the draft) leaves the picker dismissed until they type again.
  useEffect(() => {
    setSlashActiveIndex(0)
    setSlashDismissed(false)
  }, [slashQuery])

  const pickSlashCommand = (name: string): void => {
    setPrompt(completeSlashDraft(name))
    setSlashDismissed(false)
    setSlashActiveIndex(0)
  }

  // @-mention typeahead (P4-0): same trigger discipline as the slash picker but
  // fired by a trailing `@token`. `parseSlashDraft` only matches a whole-draft
  // `/token`, so slash and mention are mutually exclusive by construction; the
  // `slashQuery === null` guard makes that explicit. Items are this session's
  // real AVAILABLE agents (`selectAgentMentionItems`, App→SessionPane prop);
  // a pick inserts PLAIN `@label ` text — no wire vocabulary.
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const mentionQuery = slashQuery === null ? parseMentionQuery(prompt) : null
  const mentionMatches =
    mentionQuery === null ? [] : filterMentionItems(mentionItems, mentionQuery)
  const mentionOpen =
    !mentionDismissed && mentionQuery !== null && mentionMatches.length > 0
  const mentionIndex =
    mentionMatches.length === 0
      ? 0
      : Math.min(mentionActiveIndex, mentionMatches.length - 1)

  useEffect(() => {
    setMentionActiveIndex(0)
    setMentionDismissed(false)
  }, [mentionQuery])

  const pickMention = (item: MentionItem): void => {
    setPrompt(applyMention(prompt, item.label))
    setMentionDismissed(false)
    setMentionActiveIndex(0)
  }

  // ↑/↓ input-history recall (P4-0). Renderer-local, per-session (`history` prop
  // keyed by activeSessionId upstream); `historyNav` is the ephemeral editor
  // cursor and resets when the pane rebinds to a different session.
  const [historyNav, setHistoryNav] = useState<HistoryNav>(EMPTY_HISTORY_NAV)
  useEffect(() => {
    setHistoryNav(EMPTY_HISTORY_NAV)
  }, [activeSessionId])

  // PlanPanel open/close (P4-11): renderer-local, resets when the pane
  // rebinds to a different session and when the review resolves (approve or
  // deny removes the ExitPlanMode request — there is nothing left to show).
  const [planPanelOpen, setPlanPanelOpen] = useState(false)
  useEffect(() => {
    setPlanPanelOpen(false)
  }, [activeSessionId])
  useEffect(() => {
    if (!planReview) setPlanPanelOpen(false)
  }, [planReview])

  // A large paste collapses to a chip (App holds the full text aside and inserts
  // the `[Pasted text #N]` token); a small paste falls through to the browser's
  // default plain-text insert. Adapted for the single-line `<input>`: the token
  // is appended at the END of the draft, not the caret (see §0 flag).
  const handlePaste = (
    event: ReactClipboardEvent<HTMLInputElement>,
  ): void => {
    const text = event.clipboardData.getData('text')
    if (!text || !shouldCollapsePaste(text)) return
    event.preventDefault()
    onPaste(text)
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (slashOpen) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setSlashActiveIndex(index =>
            nextSlashIndex(index, slashMatches.length, 1),
          )
          return
        case 'ArrowUp':
          event.preventDefault()
          setSlashActiveIndex(index =>
            nextSlashIndex(index, slashMatches.length, -1),
          )
          return
        case 'Enter':
        case 'Tab':
          // Enter completes the command instead of submitting the form; Tab is
          // the usual typeahead-accept key. Both keep the draft in the composer
          // so the user can add arguments before submitting.
          event.preventDefault()
          pickSlashCommand(slashMatches[slashIndex])
          return
        case 'Escape':
          event.preventDefault()
          setSlashDismissed(true)
          return
        default:
          return
      }
    }
    if (mentionOpen) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setMentionActiveIndex(index =>
            nextSlashIndex(index, mentionMatches.length, 1),
          )
          return
        case 'ArrowUp':
          event.preventDefault()
          setMentionActiveIndex(index =>
            nextSlashIndex(index, mentionMatches.length, -1),
          )
          return
        case 'Enter':
        case 'Tab':
          event.preventDefault()
          pickMention(mentionMatches[mentionIndex])
          return
        case 'Escape':
          event.preventDefault()
          setMentionDismissed(true)
          return
        default:
          return
      }
    }
    // No typeahead open — ↑/↓ walk the submitted-prompt history for this session.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const result = navigateHistory(
        history,
        historyNav,
        event.key === 'ArrowUp' ? 'up' : 'down',
        prompt,
      )
      if (result) {
        event.preventDefault()
        setHistoryNav(result.nav)
        // history-nav: this draft swap must not prune the live paste held aside.
        setPrompt(result.value, 'history-nav')
      }
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-8">
      <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
        <span>
          {activeDescriptor ? (
            <span className="mr-2 font-mono text-xs text-text-subtle">
              {activeDescriptor.cwd}
            </span>
          ) : null}
          {activeConnection.status} · {activeLog.messages.length} messages · {partialCount}{' '}
          partial frames
        </span>
        <button
          className="rounded border border-text-subtle px-3 py-1 text-xs text-text-primary"
          onClick={copyForLlm}
          type="button"
        >
          Copy for LLM
        </button>
      </div>

      <ConnectionRecovery
        connection={activeConnection}
        sessionId={activeSessionId}
      />

      {pastes.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Collapsed pastes">
          {pastes.map(entry => (
            // Collapsed-paste chip: <details> gives the expand affordance (the
            // full text held aside), the × removes it (strips the token + drops
            // the stored content). On submit the token expands back inline.
            <details
              key={entry.id}
              className="min-w-0 rounded-md border border-shell-seam bg-surface-raised text-[11px]"
            >
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-text-muted">
                <span className="truncate font-mono text-[10.5px]">
                  {formatPasteRef(entry.id, entry.numLines)}
                </span>
                <button
                  type="button"
                  aria-label="Remove paste"
                  title="Remove"
                  className="shrink-0 text-text-subtle transition-colors hover:text-tone-danger"
                  onClick={event => {
                    event.preventDefault()
                    onRemovePaste(entry)
                  }}
                >
                  ×
                </button>
              </summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-shell-seam px-2 py-1.5 font-mono text-[10.5px] text-text-subtle">
                {entry.content}
              </pre>
            </details>
          ))}
        </div>
      ) : null}

      {planPanelOpen ? null : (
        <PlanBar onOpen={() => setPlanPanelOpen(true)} review={planReview} />
      )}
      <PlanPanel
        onApprove={onApprovePlan}
        onClose={() => setPlanPanelOpen(false)}
        onRevise={onRevisePlan}
        open={planPanelOpen}
        review={planReview}
      />

      <form
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-label="Composer"
        className="flex gap-3"
        onKeyDown={onComposerKeyDown}
        onSubmit={submit}
      >
        <div className="relative min-w-0 flex-1">
          <SlashCommandPicker
            open={slashOpen}
            query={slashQuery ?? ''}
            commands={slashMatches}
            activeIndex={slashIndex}
            onPick={pickSlashCommand}
          />
          <MentionPicker
            open={mentionOpen}
            query={mentionQuery ?? ''}
            items={mentionItems}
            activeIndex={mentionIndex}
            onPick={pickMention}
          />
          <input
            aria-label="Prompt"
            className="w-full rounded border border-text-subtle bg-app-bg px-3 py-2 font-mono"
            disabled={
              !activeSessionId ||
              !activeLog.inputEnabled ||
              !activeConnection.inputEnabled
            }
            onChange={event => {
              // A genuine keystroke abandons any active ↑/↓ recall cursor
              // (parity with the prototype resetting historyIdx on input) and
              // prunes pastes whose token was actually deleted (reason 'edit').
              setHistoryNav(EMPTY_HISTORY_NAV)
              setPrompt(event.target.value)
            }}
            onPaste={handlePaste}
            placeholder="Send a prompt to the live engine"
            value={prompt}
          />
        </div>
        {/* Add-attachment control (§10 ❓). Parity stub, matching the prototype's
         * own stub (Chat.jsx:1435 fires a placeholder toast): a real file picker
         * would need an engine attachment capability that is NOT on the wire —
         * inventing one is out of scope (no new vocabulary). The working attach
         * path today is a large paste, which the title spells out. */}
        <button
          aria-label="Add attachment"
          title="Add attachment — paste a large block to attach it as a collapsed chip"
          className="rounded border border-text-subtle px-3 py-2 text-lg leading-none text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
          disabled={
            !activeSessionId ||
            !activeLog.inputEnabled ||
            !activeConnection.inputEnabled
          }
          onClick={() => {}}
          type="button"
        >
          +
        </button>
        <button
          className="rounded bg-accent px-4 py-2 text-app-bg disabled:opacity-50"
          disabled={
            !activeSessionId ||
            !activeLog.inputEnabled ||
            !activeConnection.inputEnabled ||
            prompt.trim().length === 0
          }
          type="submit"
        >
          Send
        </button>
      </form>

      <PermissionQueue
        items={permissionQueue}
        onAllow={allowPermission}
        onDeny={denyPermission}
        onRestore={restorePermission}
      />

      <details className="rounded border border-text-subtle/50 px-3 py-2">
        <summary className="cursor-pointer text-sm text-text-muted">
          Permissions
          {permissionContext ? (
            <span className="ml-2 font-mono text-xs text-accent">
              {permissionContext.mode}
            </span>
          ) : null}
        </summary>
        <div className="mt-2">
          <PermissionRulesEditor
            context={permissionContext}
            onSetMode={setPermissionMode}
          />
        </div>
      </details>

      {activeLog.error ? (
        <div className="text-sm text-tone-danger">{activeLog.error}</div>
      ) : null}

      {transportError ? (
        <div className="text-sm text-tone-danger">{transportError}</div>
      ) : null}

      {activeLog.truncated ? (
        <div className="text-sm text-tone-warning">
          Raw message history was truncated to the renderer retention budget.
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col">
        <h1 className="mb-2 text-sm text-text-muted">Transcript (projected)</h1>
        <div className="min-h-0 flex-1 overflow-auto rounded border border-text-subtle p-4">
          <TranscriptView
            activeSessionId={activeSessionId}
            state={transcript}
          />
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <details
          className="min-h-0 flex-1 overflow-auto"
          onToggle={e => setRawDebugOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm text-text-muted">
            Raw SDKMessage events{' '}
            <span className="text-text-subtle">(last 20)</span>
          </summary>
          {rawDebugOpen ? (
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded border border-text-subtle p-4 font-mono text-xs">
              {JSON.stringify(activeLog.messages.slice(-20), null, 2)}
            </pre>
          ) : null}
        </details>
      </section>
    </main>
  )
}

export function ConnectionRecovery({
  connection,
  sessionId,
}: {
  connection: ConnectionSnapshot
  sessionId: SessionId | null
}) {
  const [restartError, setRestartError] = useState<string | null>(null)
  if (
    !sessionId ||
    connection.status === 'connecting' ||
    connection.status === 'ready'
  ) {
    return null
  }

  return (
    <div className="flex items-center gap-3 text-sm text-tone-danger">
      <span>Session {connection.status}.</span>
      <button
        className="rounded border border-tone-danger px-3 py-1 text-xs"
        onClick={() => {
          try {
            getBridge().restart(sessionId)
            setRestartError(null)
          } catch (error) {
            setRestartError(errorMessage(error))
          }
        }}
        type="button"
      >
        Restart
      </button>
      {restartError ? <span>{restartError}</span> : null}
    </div>
  )
}

export function sendPermissionResponse(
  bridge: Pick<CatCodeBridge, 'respondPermission'>,
  sessionId: SessionId,
  requestId: string,
  response: PermissionResponseInput,
): string | null {
  try {
    bridge.respondPermission(sessionId, requestId, response)
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/** Stable empty inventory for the closed palette — a fresh `[]` each render would
 * bust the palette's `useMemo(filter)` identity check for no reason. */
const EMPTY_PALETTE_ITEMS: PaletteItem[] = []

export type PromptDraftState = Record<SessionId, string>

export function selectPromptDraft(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
): string {
  if (!sessionId) return ''
  return drafts[sessionId] ?? ''
}

export function reducePromptDrafts(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
  value: string,
): PromptDraftState {
  if (!sessionId) return drafts
  if (value.length === 0) {
    if (!(sessionId in drafts)) return drafts
    const next = { ...drafts }
    delete next[sessionId]
    return next
  }
  if (drafts[sessionId] === value) return drafts
  return { ...drafts, [sessionId]: value }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getWorkspaceStorage(): Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function sessionDisplayName(
  sessionId: SessionId,
  descriptors: ReadonlyMap<SessionId, SessionDescriptor>,
): string {
  const descriptor = descriptors.get(sessionId)
  return descriptor ? tabLabel(descriptor) : sessionId
}

function hostErrorMessage(error: HostError): string {
  return `${error.code}: ${error.message}`
}

/**
 * Local reducer that folds the two shell inputs — the one-shot `listSessions()`
 * hydrate and the live `HostEvent` stream — into the roster projection. Keeping
 * the pure roster fold (`reduceShellState`) separate lets the state module stay
 * event-only and unit-testable without React.
 */
type ShellAction =
  | {
      type: 'hydrate'
      sessions: readonly SessionDescriptor[]
      /** Ids a live `session-removed` already dropped — never resurrect them. */
      removed: ReadonlySet<SessionId>
    }
  | { type: 'event'; event: HostEvent }

function reduceShell(state: ShellState, action: ShellAction): ShellState {
  if (action.type === 'hydrate') {
    // The snapshot is a BASELINE, folded AFTER the live subscription is already
    // installed (F3 subscribe-before-snapshot). It fills gaps only and never
    // clobbers a fresher live event that already landed:
    //  - an id a live `session-removed` already dropped is skipped (no
    //    resurrection from the stale snapshot);
    //  - an id already present keeps whichever descriptor is NEWER by
    //    `lastAttachedAt` (a live status that superseded the snapshot wins; a
    //    snapshot row never rolls a live update backwards);
    //  - a genuinely new id (only in the snapshot) is added.
    let next = state
    for (const session of action.sessions) {
      const id = session.appSessionId
      if (action.removed.has(id)) continue
      const existing = next.byId[id]
      if (existing && existing.lastAttachedAt >= session.lastAttachedAt) {
        continue // live descriptor is at least as fresh — don't roll back
      }
      next = reduceShellState(next, { type: 'session-added', session })
    }
    return next
  }
  return reduceShellState(state, action.event)
}

type SessionPaneProps = {
  activeConnection: ConnectionSnapshot
  activeDescriptor: SessionDescriptor | undefined
  activeLog: RawMessageSessionLog
  activeSessionId: SessionId | null
  allowPermission: (requestId: string, applySuggestions?: number[]) => void
  copyForLlm: () => void
  denyPermission: (requestId: string, message?: string) => void
  partialCount: number
  permissionContext: ReturnType<typeof selectPermissionContext>
  permissionQueue: ReturnType<typeof selectPermissionQueue>
  /** P4-11 — the pending ExitPlanMode review, or `null`; drives PlanBar/PlanPanel. */
  planReview: PlanReview | null
  /** Composes `setPermissionMode` + a C1 allow on the plan-review request. */
  onApprovePlan: (mode: PlanApprovalMode) => void
  /** Denies the plan-review request with feedback (real "keep planning"). */
  onRevisePlan: (message: string) => void
  prompt: string
  restorePermission: (requestId: string) => void
  setPermissionMode: (mode: PermissionSetModeMode) => void
  setPrompt: (value: string, reason?: DraftWriteReason) => void
  submit: (event: FormEvent<HTMLFormElement>) => void
  /** Real @-mention sources for this session (agents; files need a read-seam). */
  mentionItems: MentionItem[]
  /** Collapsed pastes held aside for this session, oldest first. */
  pastes: PasteEntry[]
  /** Prior submitted prompts for ↑/↓ recall (per session, newest last). */
  history: string[]
  /** Store a large paste as a collapsed chip and insert its token. */
  onPaste: (content: string) => void
  /** Remove a collapsed paste (strip its token + drop the stored content). */
  onRemovePaste: (entry: PasteEntry) => void
  transcript: TranscriptState
  transportError: string | null
}

export function buildDebugExport(
  transcriptRows: TranscriptRow[],
  rawLog: RawMessageSessionLog,
): string {
  return `# CatCode debug export

> ⚠️ [!WARNING]
> **POTENTIALLY SENSITIVE:** The raw transcript and debug clipboard output may contain
> sensitive file contents, command inputs/outputs, or credential material that passed
> the outbound key-name secret guard. Handle this export with care.

## Transcript (projected)

\`\`\`json
${JSON.stringify(transcriptRows, null, 2)}
\`\`\`

## Raw SDKMessage events

Raw retention: ${rawLog.truncated ? 'TRUNCATED' : 'complete'} (${rawLog.retainedBytes} UTF-8 JSON bytes retained)

\`\`\`json
${JSON.stringify(rawLog.messages, null, 2)}
\`\`\`
`
}
