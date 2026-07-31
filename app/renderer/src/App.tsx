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
import { permissionActionForKey } from './permissionPromptModel.js'
import { PermissionQueue } from './PermissionQueue.js'
import { selectContextUsage } from './contextUsage.js'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import { focusFirstComposerFace } from './composerActionsBarModel.js'
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
import {
  selectAskQuestion,
  selectGenericPermissionQueue,
  type AskQuestionReview,
} from './askQuestionState.js'
import { AskQuestionFlow } from './AskQuestionFlow.js'
import { PlanBar, PlanPanel } from './PlanPanel.js'
import { useToast } from './toastContext.js'
import {
  activeAfterPaneChange,
  createShellState,
  reduceShellState,
  selectPaneSessions,
  sessionAtSlot,
  type ShellState,
} from './shellState.js'
import { deriveTabVisualState } from './tabStatus.js'
import { TabBar, type TabModel } from './TabBar.js'
import { tabLabel } from './tabBarModel.js'
import { Sidebar } from './Sidebar.js'
import { selectShellDescriptors } from './sidebarState.js'
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
  selectNestedTranscriptRows,
  selectSlashCommands,
  selectTranscriptRows,
  type NestedTranscriptRow,
  type TranscriptRow,
  type TranscriptState,
} from './transcriptProjector.js'
import {
  claimLazyRestore,
  createPreviewTranscriptState,
  hasPreviewTranscript,
  openPreloadedPreview,
  previewClosePlan,
  reduceLiveTranscriptState,
  reducePreviewTranscriptState,
  selectPreviewSwapSessions,
  selectPreviewRunFactsFor,
  selectPreviewTranscript,
  selectPreviewTruncationMessage,
  type PreviewRunFacts,
} from './previewTranscriptState.js'
import {
  STARTUP_PRELOAD_MAX_SESSIONS,
  calculateStartupPreloadCapacity,
  estimateProjectedPreviewBytes,
  runStartupTranscriptPreload,
  selectStartupPreloadCandidates,
} from './sessionPreload.js'
import { TranscriptView, type RestorePhase } from './TranscriptView.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import {
  completeSlashDraft,
  filterSlashCommands,
  nextSlashIndex,
  parseSlashDraft,
} from './slashCommandPickerModel.js'
import { MentionPicker, type MentionItem } from './MentionPicker.js'
import { filterMentionItems } from './mentionPickerModel.js'
import {
  applyMention,
  caretAtHistoryEdge,
  createHistoryState,
  createPasteState,
  createPendingSubmitState,
  EMPTY_HISTORY_NAV,
  formatPasteRef,
  navigateHistory,
  parseMentionQuery,
  pasteTokenBeforeCaret,
  PENDING_SUBMIT_RELEASED_MESSAGE,
  planSessionSubmit,
  reduceHistoryPushed,
  reducePasteAdded,
  reducePasteRemoved,
  reducePasteStateForDraftWrite,
  reducePendingSubmitCleared,
  reducePendingSubmitHeld,
  reduceSessionPastesCleared,
  resolvePendingSubmit,
  restoreDraftWithPending,
  selectAgentMentionItems,
  selectComposerGate,
  selectHistory,
  selectPendingSubmit,
  selectSessionPasteList,
  selectSessionPasteState,
  shouldCollapsePaste,
  type DraftWriteReason,
  type HistoryNav,
  type HistoryState,
  type PasteEntry,
  type PasteState,
  type PendingSubmitState,
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
  isTerminalConnectionStatus,
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
  selectActiveAccount,
  selectActiveAnthropicAccount,
  selectFirstAccountsSnapshot,
  selectGlobalAccountsSnapshot,
  selectOAuthProgress,
} from './accountsState.js'
import {
  createWorkspaceTrustState,
  reduceWorkspaceTrustState,
  selectWorkspaceTrustError,
  selectWorkspaceTrustSnapshot,
} from './workspaceTrustState.js'
import {
  createDiagnosticsState,
  reduceDiagnosticsState,
  selectDiagnosticsSnapshot,
} from './diagnosticsState.js'
import {
  createRunControlsState,
  reduceRunControlsState,
  selectRunControlsSnapshot,
} from './runControlsState.js'
import {
  createSlashCatalogState,
  reduceSlashCatalogState,
  selectSlashCatalog,
} from './slashCatalogState.js'
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
  resolveSessionOpenRoute,
  selectMergedSessionRows,
  selectRecentWorkspaces,
  selectSessionsCatalog,
  withResolvedTitle,
  type MergedSessionRow,
} from './sessionsCatalogState.js'
import { WelcomeScreen } from './WelcomeScreen.js'
import { TasksDialog } from './TasksDialog.js'
import {
  createOrchestratorState,
  reduceOrchestratorState,
  selectAgentModeSnapshot,
} from './orchestratorState.js'
import { GoalsPage } from './GoalsPage.js'
import { AccountsPage } from './AccountsPage.js'
import {
  loginVerb,
  oauthAliasVerb,
  oauthCancelVerb,
  oauthPasteCodeVerb,
  resultToastTone,
  switchVerb,
} from './accountsPageModel.js'
import {
  StartupOAuth,
  WorkspaceTrustGate,
  type StartupOAuthView,
} from './StartupSurfaces.js'
import { SessionsPage } from './SessionsPage.js'
import { MetadataInspector } from './MetadataInspector.js'
import { buildSessionInspectorState } from './sessionInspectorState.js'
import { buildSessionMetadataView } from './messageMetadata.js'
import {
  SessionActionsMenu,
  SessionRenamePopover,
  type SessionActionsAnchor,
} from './SessionActionsMenu.js'
import { resolveSessionActions } from './sessionActions.js'
import {
  BranchDialog,
  ExportDialog,
} from './SessionActionDialogs.js'
import {
  exportFileName,
  selectExportPreview,
  selectLatchedExportPreview,
  type LatchedExportPreview,
} from './sessionActionDialogState.js'
import {
  createSessionActionRuntimeState,
  reduceSessionActionRuntimeState,
  selectLatestSessionActionResult,
} from './sessionActionRuntimeState.js'
import {
  createVerbAckResultState,
  reduceVerbAckResultState,
  selectLatestVerbAckResult,
  verbAckErrorToast,
} from './verbAckResultState.js'
import { SettingsShell } from './SettingsShell.js'
import type { SettingWriteInput } from './SettingsEditors.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import type {
  AccountResultFrame,
  AccountStatus,
  AccountsSnapshot,
  AnthropicAccountStatus,
  AccountSwitchMessage,
  AccountVerbMessage,
  AskUserQuestionAnswer,
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  RemoteVerbMessage,
  RunControlsSnapshot,
  SessionActionVerbMessage,
  SessionId,
  SlashCatalogEntry,
} from '../../shared/protocol.js'
import type {
  HostError,
  HostEvent,
  SessionDescriptor,
} from '../../shared/hostApi.js'
import {
  buildDebugExport,
  claimOAuthContextForAccountLogin,
  deriveActivity,
  fmtElapsed,
  fmtTok,
  reducePromptDrafts,
  selectLiveTokenEstimate,
  selectPromptDraft,
  sendPermissionResponse,
  shouldShowAnthropicPoolAccount,
  shouldShowFirstRunOAuth,
  type OAuthContext,
  type PromptDraftState,
} from './appModel.js'

// Perf F3 (2026-07-08): batch-folding reducer variants, defined at module scope
// so their identity is stable across renders. A batched server-frame delivery is
// folded into each store in ONE dispatch (`applyServerFrameBatch`); single
// actions still pass straight through, so every other dispatch site is unchanged.
const reduceServerFrameBatched = withBatch(reduceServerFrame)
const reducePermissionStateBatched = withBatch(reducePermissionState)
const reduceConnectionStateBatched = withBatch(reduceConnectionState)
const reduceSettingsStateBatched = withBatch(reduceSettingsState)
const reduceAgentConfigStateBatched = withBatch(reduceAgentConfigState)
const reduceExtensionsStateBatched = withBatch(reduceExtensionsState)
const reduceGoalMemoryStateBatched = withBatch(reduceGoalMemoryState)
const reduceTasksStateBatched = withBatch(reduceTasksState)
const reduceOrchestratorStateBatched = withBatch(reduceOrchestratorState)
const reduceAccountsStateBatched = withBatch(reduceAccountsState)
const reduceWorkspaceTrustStateBatched = withBatch(reduceWorkspaceTrustState)
const reduceDiagnosticsStateBatched = withBatch(reduceDiagnosticsState)
const reduceRunControlsStateBatched = withBatch(reduceRunControlsState)
const reduceSlashCatalogStateBatched = withBatch(reduceSlashCatalogState)
/** Stable empty catalog so an omitted `slashCatalog` prop keeps one identity. */
const EMPTY_SLASH_CATALOG: readonly SlashCatalogEntry[] = []

/**
 * Elements that already act on Enter/Escape themselves. The plain-key permission
 * shortcuts are a shortcut for "focus is on nothing"; whenever focus sits inside
 * one of these the focused control decides, so Enter on the card's own Deny
 * button denies instead of being swallowed and answered as an allow.
 *
 * A tag-name test is not enough: buttons, menu items and dialog contents all
 * carry their own Enter semantics, and `preventDefault()` here suppresses the
 * browser's Enter → click.
 */
const FOCUSED_KEY_OWNER_SELECTOR =
  'a[href], button, input, select, textarea, [contenteditable], ' +
  '[role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], ' +
  '[role="menuitemcheckbox"], [role="option"], [role="listbox"], ' +
  '[role="dialog"], [role="alertdialog"]'

/** Renderer-minted correlation id for a run-control verb (T5a-analog; echoed on
 * `run-control.result`). A UX field, not a security one — the sidecar bounds it. */
const newRequestId = (): string => crypto.randomUUID()
const reduceRemoteSettingsStateBatched = withBatch(reduceRemoteSettingsState)
const reduceSessionsCatalogStateBatched = withBatch(reduceSessionsCatalogState)
const reduceSessionActionRuntimeStateBatched = withBatch(
  reduceSessionActionRuntimeState,
)
const reduceVerbAckResultStateBatched = withBatch(reduceVerbAckResultState)

/** Which surface raised the session-actions overlay. The TabBar ⋯, a sidebar
 * row ⋮ and the Sessions page's row ⋯ share one piece of state, and only the
 * sidebar-anchored case may hold the sidebar open (P4-33). `sessions-page` is a
 * third entry point (P4-29) and deliberately does not pin the rail: the menu is
 * anchored on the page, not on the sidebar. */
type SessionActionsOrigin = 'sidebar' | 'tab' | 'sessions-page'

export function App() {
  const [state, dispatch] = useReducer(
    reduceServerFrameBatched,
    undefined,
    createRawMessageLogState,
  )
  const [transcript, dispatchSessionEvent] = useReducer(
    reduceLiveTranscriptState,
    undefined,
    createTranscriptState,
  )
  const [previewTranscript, dispatchPreviewTranscript] = useReducer(
    reducePreviewTranscriptState,
    undefined,
    createPreviewTranscriptState,
  )
  const previewTranscriptRef = useRef(previewTranscript)
  previewTranscriptRef.current = previewTranscript
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
  // CC-16 — a prompt submitted while the session was still spawning. Parked
  // per-session (same keying as `promptDrafts`) and drained through the SAME
  // `app.submit` once the engine accepts input; released back into the composer
  // if the spawn dies. Renderer-local, never on the wire.
  const [pendingSubmits, setPendingSubmits] = useState<PendingSubmitState>(
    createPendingSubmitState,
  )
  const pendingSubmitsRef = useRef(pendingSubmits)
  pendingSubmitsRef.current = pendingSubmits
  const [transportError, setTransportError] = useState<string | null>(null)
  const [shellError, setShellError] = useState<string | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  // P4-6b — the tab ⋯ actions overflow (SessionActionsMenu) + its MetadataInspector
  // drawer + the inline rename editor. The menu is bound to the session it was
  // OPENED for (the clicked tab's `sessionId`, NOT `activeSessionId`), so it never
  // retargets if the active tab changes while the overlay is open.
  //
  // P4-33 — `origin` records which surface RAISED the overlay. Both the TabBar ⋯
  // and a sidebar row ⋮ set this same state, but only a sidebar-anchored overlay
  // should hold the sidebar open (see `sidebarOverlayOpen`): pinning it for a tab
  // menu would slide the rail out over the transcript for no reason.
  const [sessionActionsTarget, setSessionActionsTarget] = useState<{
    sessionId: SessionId
    anchor: SessionActionsAnchor
    /**
     * P4-29 — opened from a Sessions-page row, whose Rename affordance is the
     * INLINE row editor (the prototype's), not the anchored rename popover the
     * tab/sidebar entry points use. Absent for those two, so they are unchanged.
     */
    fromSessionsPage?: boolean
    /**
     * P4-33 — which surface raised the menu. The ⋯ state is SHARED with the
     * TabBar, so only a sidebar-anchored overlay may pin the rail open.
     */
    origin: SessionActionsOrigin
  } | null>(null)
  // P4-29 — the Sessions page's inline rename request + the confirmed-tag echo.
  const [sessionsRenameRequest, setSessionsRenameRequest] = useState<{
    sessionId: string
  } | null>(null)
  const [sessionsTagEcho, setSessionsTagEcho] = useState<{
    entries: readonly { sessionIds: readonly string[]; tag: string | null }[]
  } | null>(null)
  const [renamingSession, setRenamingSession] = useState<{
    sessionId: SessionId
    anchor: SessionActionsAnchor
    initial: string
    origin: SessionActionsOrigin
  } | null>(null)
  const [metadataOpen, setMetadataOpen] = useState(false)
  // P4-30 — the two SAModal dialogs the ⋯ menu opens (PARITY-LEDGER §17). Both
  // are bound to the row the menu was opened for, like the menu itself.
  //
  // Branch is a CONFIRMATION gate: `session.branch` writes a real fork on disk
  // (`createFork`), and before this it fired straight off the menu click. Nothing
  // is dispatched until the dialog's primary button.
  //
  // Export is the reverse shape: the verb is dispatched WHEN the dialog opens,
  // because the dialog's whole job is to show the transcript the sidecar renders.
  // The dialog holds the `requestId` it minted so it displays its OWN result and
  // never another action's (T5a-analog).
  const [branchConfirm, setBranchConfirm] = useState<{
    sessionId: SessionId
    title: string | null
  } | null>(null)
  const [exportDialog, setExportDialog] = useState<{
    sessionId: SessionId
    requestId: string
    title: string | null
  } | null>(null)
  // The export result, LATCHED against the request that asked for it. The
  // runtime state keeps only the latest result per session, so without this an
  // unrelated rename/branch result arriving while the dialog is open would blank
  // the transcript back to pending (`selectLatchedExportPreview`).
  const [latchedExport, setLatchedExport] =
    useState<LatchedExportPreview | null>(null)
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
  const [runControls, dispatchRunControls] = useReducer(
    reduceRunControlsStateBatched,
    undefined,
    createRunControlsState,
  )
  const [slashCatalog, dispatchSlashCatalog] = useReducer(
    reduceSlashCatalogStateBatched,
    undefined,
    createSlashCatalogState,
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
  // P4-6b — the WRITE half of the ⋯ menu: the sidecar's `session-action.result`
  // per session (A's reducer, previously unwired). Read by the outcome toast below.
  const [sessionActionRuntime, dispatchSessionActionRuntime] = useReducer(
    reduceSessionActionRuntimeStateBatched,
    undefined,
    createSessionActionRuntimeState,
  )
  // Decision #5 (audit §I.4) — the four verb-ack `.result` frames that had no
  // renderer consumer. A verb's SUCCESS re-broadcasts a snapshot (the UI already
  // updates); a FAILURE mutates nothing, so this reducer records the ack and the
  // outcome toast below surfaces the sidecar's real error — previously silent.
  const [verbAckResult, dispatchVerbAckResult] = useReducer(
    reduceVerbAckResultStateBatched,
    undefined,
    createVerbAckResultState,
  )
  const [orchestrator, dispatchOrchestrator] = useReducer(
    reduceOrchestratorStateBatched,
    undefined,
    createOrchestratorState,
  )
  const [tasksOpen, setTasksOpen] = useState(false)
  // P4-34 — cosmetic palette recents are derived from real invocations in this
  // renderer lifetime. No disk store: the prompt explicitly forbids inventing
  // persistence for this convenience list.
  const [recentPaletteItemIds, setRecentPaletteItemIds] = useState<string[]>([])
  // P4-15 OAuth flow-local state. The sub-states themselves are DRIVEN by the
  // `oauth.login.progress` back-channel (`accountsState.oauthProgress`); these two
  // are the renderer-local framing: `oauthContext` distinguishes the first-run
  // full-screen surface from the add-account overlay (both begin the SAME
  // `account.login` flow), and `oauthStarting` is the optimistic gap between the
  // begin click and the first progress frame.
  const [oauthContext, setOauthContext] = useState<OAuthContext>(null)
  const [oauthStarting, setOauthStarting] = useState(false)
  const [oauthProvider, setOauthProvider] = useState<'anthropic' | 'openai'>(
    'anthropic',
  )
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
  const lazyRestoreClaimsRef = useRef<Set<SessionId>>(new Set())
  const cancelledRestoresRef = useRef<Set<SessionId>>(new Set())
  const startupPreloadStartedRef = useRef(false)
  const preloadCandidateIdsRef = useRef<Set<SessionId>>(new Set())
  const preloadQueuedIdsRef = useRef<Set<SessionId>>(new Set())
  const preloadReservedBytesRef = useRef<Map<SessionId, number>>(new Map())
  const preloadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const preloadCancelledRef = useRef(false)
  // Ids a live `session-removed` dropped before the initial snapshot folded in —
  // so the baseline hydrate never resurrects a row the host already reaped (F3).
  const removedIdsRef = useRef<Set<SessionId>>(new Set())

  /**
   * One admission queue + one reservation ledger for startup and same-launch
   * backfill. React dispatches commit asynchronously, so the byte reservations
   * close the window where two serialized jobs could otherwise both observe a
   * stale store and independently spend the full 12-session / 64 MiB budget.
   */
  const queueTranscriptPreload = useCallback(
    (
      descriptors: readonly SessionDescriptor[],
      options: { throttleMs?: number; quiet?: boolean } = {},
    ) => {
      const selected: SessionDescriptor[] = []
      for (const descriptor of selectStartupPreloadCandidates(
        descriptors,
        STARTUP_PRELOAD_MAX_SESSIONS,
      )) {
        const sessionId = descriptor.appSessionId
        if (
          preloadCandidateIdsRef.current.has(sessionId) ||
          preloadCandidateIdsRef.current.size < STARTUP_PRELOAD_MAX_SESSIONS
        ) {
          preloadCandidateIdsRef.current.add(sessionId)
          if (!preloadQueuedIdsRef.current.has(sessionId)) {
            preloadQueuedIdsRef.current.add(sessionId)
            selected.push(descriptor)
          }
        }
      }
      if (selected.length === 0) return

      preloadQueueRef.current = preloadQueueRef.current.then(async () => {
        try {
          const current = previewTranscriptRef.current
          const { remainingSessions, remainingBytes } =
            calculateStartupPreloadCapacity(
              current,
              preloadReservedBytesRef.current,
            )
          if (remainingSessions <= 0 || remainingBytes <= 0) return

          const selectedById = new Map(
            selected.map(descriptor => [descriptor.appSessionId, descriptor]),
          )
          await runStartupTranscriptPreload({
            descriptors: selected,
            previewSession: id => getBridge().previewSession(id),
            onLoad: (cache, projected) => {
              preloadReservedBytesRef.current.set(
                cache.header.appSessionId,
                estimateProjectedPreviewBytes(projected),
              )
              dispatchPreviewTranscript({
                type: 'preview-load',
                cache,
                projected,
              })
            },
            isEligible: id => {
              const currentDescriptor = shellRef.current.byId[id]
              return (
                !removedIdsRef.current.has(id) &&
                (currentDescriptor?.restorable === true ||
                  (currentDescriptor === undefined &&
                    selectedById.get(id)?.restorable === true))
              )
            },
            isAlreadyLoaded: id =>
              hasPreviewTranscript(previewTranscriptRef.current, id) ||
              preloadReservedBytesRef.current.has(id),
            isCancelled: () => preloadCancelledRef.current,
            maxSessions: remainingSessions,
            maxProjectedBytes: remainingBytes,
            throttleMs: options.throttleMs,
            log: options.quiet ? () => {} : undefined,
          })
        } finally {
          for (const descriptor of selected) {
            preloadQueuedIdsRef.current.delete(descriptor.appSessionId)
          }
        }
      })
    },
    [],
  )

  useEffect(() => {
    const bridge = getBridge()
    preloadCancelledRef.current = false
    // Main delivers a batch of frames per IPC message (perf F3). Fold the whole
    // batch into every store with ONE dispatch each — so a restore replay is 9
    // dispatches, not 9 per frame. Focus semantics are unchanged: a background
    // frame never steals focus from another live tab. See serverFrameBatch.ts.
    const unsubscribe = bridge.subscribe(frames => {
      const previewing = new Set<SessionId>()
      for (const sessionId in shellRef.current.previews) {
        previewing.add(sessionId)
      }
      const swapSessions = selectPreviewSwapSessions(frames, previewing)
      for (const sessionId of swapSessions) {
        dispatchSessionEvent({ type: 'preview-live-reset', sessionId })
      }
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
        dispatchOrchestrator,
        dispatchAccounts,
        dispatchWorkspaceTrust,
        dispatchDiagnostics,
        dispatchRunControls,
        dispatchSlashCatalog,
        dispatchRemoteSettings,
        dispatchSessionActionRuntime,
        dispatchVerbAckResult,
        dispatchTranscript: dispatchSessionEvent,
      })
      for (const sessionId of swapSessions) {
        dispatchPreviewTranscript({ type: 'preview-reset', sessionId })
        preloadReservedBytesRef.current.delete(sessionId)
      }
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
      // Catalog owner (decision #4): the global sessions catalog now arrives as a
      // read-only `sessions-catalog` host event (was the per-sidecar
      // `sessions.snapshot` frame). It is NOT a roster row — fold it into the
      // catalog store and return BEFORE the roster logic reads `event.session`.
      if (event.type === 'sessions-catalog') {
        dispatchSessionsCatalog({ type: 'catalog', snapshot: event.catalog })
        return
      }
      // Accounts owner (decisions/ACCOUNTS-OWNERSHIP.md): the global account pool
      // arrives the same way, on main's timer, independent of any session. Also
      // NOT a roster row — fold it and return before the roster logic runs.
      if (event.type === 'accounts-pool') {
        dispatchAccounts({ type: 'pool', pool: event.pool })
        return
      }
      // A new/restored tab appears in the bar but does NOT steal the pane — a
      // spawning session has nothing to show; it becomes active when it starts
      // streaming (the frame path above), when the user clicks it, or via the
      // "nothing active" fallback below. Focus corrections (moving OFF a
      // now-non-live active tab) run in the post-commit effect below, which
      // reads the RECONCILED roster — reading shellRef here would see the
      // pre-event state (the reducer commits on the next render).
      if (
        event.type !== 'session-removed' &&
        event.session.restorable
      ) {
        const descriptor = event.session
        const sessionId = descriptor.appSessionId
        lazyRestoreClaimsRef.current.delete(sessionId)
        cancelledRestoresRef.current.delete(sessionId)

        // PL-A + PL-B composition: main re-emits a stable session-status after
        // writing a backfilled cache. Admit that cache through the existing
        // previewSession read path, serialized and under the same count/RAM
        // bounds as startup. This adds no IPC method or inbound frame kind.
        if (!hasPreviewTranscript(previewTranscriptRef.current, sessionId)) {
          queueTranscriptPreload([descriptor], { throttleMs: 0, quiet: true })
        }
      }
      if (event.type === 'session-removed') {
        removedIdsRef.current.add(event.appSessionId)
        lazyRestoreClaimsRef.current.delete(event.appSessionId)
        cancelledRestoresRef.current.delete(event.appSessionId)
        dispatchPreviewTranscript({
          type: 'preview-reset',
          sessionId: event.appSessionId,
        })
        preloadReservedBytesRef.current.delete(event.appSessionId)
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
      preloadCancelledRef.current = true
      unsubscribe()
    }
  }, [queueTranscriptPreload])

  // F2 — fold the cold-launch sessions-catalog baseline (the global engine-history
  // enumeration a sidecar last persisted to disk) as the lowest-precedence catalog
  // source, so the Sessions page shows the operator's real terminal history at
  // startup even when every registry row is merely restorable and no live sidecar
  // has emitted a `sessions.snapshot` frame yet. Read-only host-API call, once on
  // mount; a null result (no cache) is a no-op, and any live snapshot supersedes it
  // (reduceSessionsCatalogState keeps the baseline strictly lowest-precedence).
  useEffect(() => {
    let cancelled = false
    void getBridge()
      .readSessionsCatalog()
      .then(snapshot => {
        if (!cancelled && snapshot) {
          dispatchSessionsCatalog({ type: 'baseline', snapshot })
        }
      })
      .catch(() => {
        /* no cache / read failed — the live frame path still delivers */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Focus correction runs after the roster commits against pane membership:
  // live tabs union cached previews. A preview remains a valid owner until it is
  // closed, reaped, or swapped to the same-id live projection.
  // A frame arriving for any session still wins the pane first (it sets active
  // before this runs). Restorable-only rows still do not auto-focus until their
  // cache has actually opened a preview pane.
  useEffect(() => {
    const paneOrder = selectPaneSessions(shell).map(
      descriptor => descriptor.appSessionId,
    )
    setActiveSessionId(current => {
      if (current !== null) return activeAfterPaneChange(current, paneOrder)
      return paneOrder[0] ?? null
    })
  }, [shell])

  useEffect(() => {
    for (const sessionId in shell.previews) {
      if (
        shell.tabs[sessionId] &&
        !hasPreviewTranscript(previewTranscript, sessionId)
      ) {
        dispatchShell({ type: 'preview-close', sessionId })
        lazyRestoreClaimsRef.current.delete(sessionId)
      }
    }
  }, [previewTranscript, shell])

  const activeConnection = selectConnection(connection, activeSessionId)

  // P4-6a — the freshest sessions catalog. Read BEFORE the tab models because the
  // tab label resolves its title against it too (`withResolvedTitle`), so the tab,
  // the sidebar and the Sessions page all apply one title-precedence rule.
  const sessionCatalogSnapshot = selectSessionsCatalog(sessionsCatalog)

  // Build one tab model per pane session, fusing the host descriptor with the
  // per-session connection view + pending-permission count (the background
  // attention badge). Every tab is computed from its OWN sessionId slice, so a
  // background tab's status/badge is correct without it being active.
  const tabs: TabModel[] = useMemo(
    () =>
      selectPaneSessions(shell).map(rawDescriptor => {
        // A terminal `/rename` writes only the engine transcript, so the registry
        // title the descriptor carries can be stale — resolve it the same way the
        // merged sidebar rows do (`sessionsCatalogState.ts` `pickTitle`).
        const descriptor = withResolvedTitle(rawDescriptor, sessionCatalogSnapshot)
        const sessionId = descriptor.appSessionId
        const previewOnly =
          shell.previews[sessionId] === true && shell.tabs[sessionId] !== true
        return {
          descriptor,
          visual: previewOnly
            ? {
                label: 'preview',
                tone: 'busy' as const,
                restartable: false,
                needsAttention: false,
              }
            : deriveTabVisualState({
                descriptor,
                connection: selectConnection(connection, sessionId),
                pendingPermissionCount: selectPendingPermissionCount(
                  permissions,
                  sessionId,
                ),
                isActive: sessionId === activeSessionId,
              }),
        }
      }),
    [shell, connection, permissions, activeSessionId, sessionCatalogSnapshot],
  )
  const paneSessionIds = useMemo(
    () => tabs.map(tab => tab.descriptor.appSessionId),
    [tabs],
  )
  const paneSessionKey = paneSessionIds.join('\u0000')
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
  const shellDescriptors = useMemo(() => selectShellDescriptors(shell), [shell])

  // P4-6a — the merged Sessions catalog: the host registry rows (openable) ∪
  // the sidecar engine-history snapshot (rich metadata), via the shared
  // selector (reused by P4-17 Welcome recents, D5).
  const sessionCatalogRows = useMemo(
    () => selectMergedSessionRows(shellDescriptors, sessionCatalogSnapshot),
    [shellDescriptors, sessionCatalogSnapshot],
  )

  // The active session's merged catalog row — feeds the tab ⋯ actions menu and
  // the MetadataInspector. Matched by `appSessionId` (the live address that equals
  // `activeSessionId`); `row.sessionId` is the engineSessionId once assigned
  // (sessionsCatalogState.ts:143), so matching on it would miss a resumed session.
  const activeSessionRow =
    activeSessionId != null
      ? sessionCatalogRows.find(row => row.appSessionId === activeSessionId) ??
        null
      : null

  // P4-17 Welcome launcher — derived inputs, read from the SAME domain seams as
  // the other surfaces (no new feed, D5/WELCOME-LAUNCHER §6). Recents = a
  // distinct-workspace projection over the shared merged rows; trust = best-
  // effort per-cwd flags joined from live sessions' `workspace-trust.snapshot`
  // (only reporting sessions expose trust — a global projects-trust feed is out
  // of scope). The launcher renders at empty-state (no ACTIVE session), so the
  // account table reads the first available pool snapshot (the pool is global).
  const welcomeTrustByCwd = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const descriptor of shellDescriptors) {
      const snap = selectWorkspaceTrustSnapshot(
        workspaceTrust,
        descriptor.appSessionId,
      )
      if (snap) map.set(descriptor.cwd, snap.trusted)
    }
    return map
  }, [shellDescriptors, workspaceTrust])
  const welcomeRecents = useMemo(
    () => selectRecentWorkspaces(sessionCatalogRows, welcomeTrustByCwd),
    [sessionCatalogRows, welcomeTrustByCwd],
  )

  useEffect(() => {
    if (!hostSnapshotReady && paneSessionIds.length === 0) return
    setWorkspaceLayoutState(current => {
      const next = reconcileWorkspaceLayout(
        current,
        paneSessionIds,
        activeSessionId,
      )
      return workspaceLayoutsEqual(current, next) ? current : next
    })
    // paneSessionKey is the stable content signature of live ∪ preview ids; keying
    // the effect on the key (not the array identity, which churns every tabs
    // recompute) is the whole point of computing it.
  }, [activeSessionId, hostSnapshotReady, paneSessionKey])

  // Re-apply-on-restore (P3-6): the held `pendingRestore` split snaps back once
  // EVERY session it references owns a live or preview pane — order-independent,
  // overriding
  // whatever the operator clicked while restoring. Abandoned if a referenced
  // session is unrecoverable (neither live nor restorable), which unblocks the
  // disk write below so the operator's actual layout can persist instead.
  const restorableIds = useMemo(
    () =>
      shellDescriptors
        .filter(descriptor => descriptor.restorable)
        .map(descriptor => descriptor.appSessionId),
    [shellDescriptors],
  )

  // PL-A: roster hydration unlocks a store-only preload after the first paint.
  // A requestAnimationFrame followed by a timer yields one painted renderer
  // frame before sequential cache reads begin. The scheduler independently caps
  // main-thread scans and projected renderer heap, and never opens a pane.
  useEffect(() => {
    if (!hostSnapshotReady || startupPreloadStartedRef.current) return
    let cancelled = false
    let timer: number | null = null
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        startupPreloadStartedRef.current = true
        const descriptors = selectShellDescriptors(shellRef.current).filter(
          descriptor => descriptor.restorable,
        )
        if (!cancelled) queueTranscriptPreload(descriptors)
      }, 0)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [hostSnapshotReady, queueTranscriptPreload])

  // The two lists are joined with a SEPARATOR, never flattened into one: a bare
  // concatenation makes pane=[X]/restorable=[Y] and pane=[X,Y]/restorable=[]
  // produce the identical key, so the restore effect below never re-runs as
  // sessions move from restorable to live — the saved split never re-forms and
  // the persist effect stays blocked behind `pendingRestore` for the whole run.
  const rosterKey = `${paneSessionIds.join(' ')}|${restorableIds.join(' ')}`
  useEffect(() => {
    if (!pendingRestore || !hostSnapshotReady) return
    const ready = readyToRestoreLayout(pendingRestore, paneSessionIds)
    if (ready) {
      setWorkspaceLayoutState(ready)
      setPendingRestore(null)
      return
    }
    const known = new Set<SessionId>([...paneSessionIds, ...restorableIds])
    if (pendingRestore.panels.some(panel => !known.has(panel.sessionId))) {
      setPendingRestore(null) // a referenced session is gone; stop waiting
    }
    // rosterKey is the stable signature of pane ∪ restorable ids.
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

  const newSessionInWorkspace = useCallback(async (repId: SessionId) => {
    const bridge = getBridge()
    try {
      // #15 — the per-workspace "+": the renderer names an EXISTING registry id
      // (a representative session in that workspace), NEVER a path. The host
      // re-derives + re-validates the cwd from its own registry (HC1) and spawns
      // a fresh session — no native picker, no renderer-authored cwd.
      const result = await bridge.createSessionInWorkspace(repId)
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
      if (!activeSessionId) {
        // The Accounts page is reachable with no session open, but a verb needs
        // an engine process to carry it. Answer with a real outcome instead of
        // dropping the click: the page waits for one before it closes its
        // confirmation dialog, so returning silently leaves that dialog up
        // forever. Renderer-local — this result never crosses the wire.
        dispatchAccounts({
          type: 'frame',
          frame: {
            kind: 'account.result',
            protocolVersion: PROTOCOL_VERSION,
            sessionId: '',
            requestId: verb.requestId,
            verb: verb.type,
            ok: false,
            message: 'Open a session first, then change accounts from there.',
          },
        })
        return
      }
      if (verb.type === 'account.login') {
        setOauthProvider(verb.provider ?? 'openai')
        // AccountsPage starts login through this generic verb callback rather
        // than `beginOAuth`. Claim the attempt here so waiting/manual-code/
        // alias/error/retry/success all keep an owning surface. A first-run
        // caller sets its more specific context immediately beforehand, and this
        // functional update preserves it.
        setOauthContext(claimOAuthContextForAccountLogin)
        setOauthStarting(true)
      }
      getBridge().accountVerb(activeSessionId, verb)
    },
    [activeSessionId],
  )

  // The Accounts page reads the polled global pool, which only refreshes on the
  // accounts owner's timer — so a rename toasts success while the row keeps the
  // old alias for up to a minute. The sidecar re-broadcasts its own snapshot with
  // the change already applied straight after a pool-mutating verb, so adopt that
  // as the pool view the moment it lands. It arrives AFTER the result frame
  // (sidecarServer.ts sends the result, then re-broadcasts), which is why this
  // tracks the promoted snapshot's identity rather than firing once on the result.
  const promotedAccountsSnapshotRef = useRef<AccountsSnapshot | null>(null)
  useEffect(() => {
    const result = accounts.lastResult
    if (!result || !result.ok) return
    const snapshot = selectAccountsSnapshot(accounts, result.sessionId)
    if (!snapshot || snapshot === promotedAccountsSnapshotRef.current) return
    promotedAccountsSnapshotRef.current = snapshot
    if (snapshot !== accounts.pool) {
      dispatchAccounts({ type: 'pool', pool: snapshot })
    }
  }, [accounts])

  // P4-15 — the first-run surface and the add-account dialog both begin the SAME
  // engine OAuth flow (the `account.login` verb; browser handoff, the engine owns
  // the token write). Progress flows back on the `oauth.login.progress` frame,
  // driving the sub-states below; the account lands on the `accounts.snapshot`
  // re-broadcast the sidecar fires on `success` — no renderer token path.
  // `context` tags which surface owns the flow.
  const beginOAuth = useCallback(
    (
      context: Exclude<OAuthContext, null>,
      provider: 'anthropic' | 'openai' = 'openai',
    ) => {
      setOauthContext(context)
      setOauthStarting(true)
      setOauthProvider(provider)
      if (activeSessionId) {
        dispatchAccounts({ type: 'oauthReset', sessionId: activeSessionId })
      }
      sendAccountVerb(loginVerb(provider))
    },
    [sendAccountVerb, activeSessionId],
  )

  // Clear the OAuth surface locally (cancel / back / dwell timeout) AND tell the
  // sidecar to abandon the in-flight attempt (drops its late progress).
  const clearOAuth = useCallback(() => {
    setOauthStarting(false)
    setOauthContext(null)
    if (activeSessionId) {
      dispatchAccounts({ type: 'oauthReset', sessionId: activeSessionId })
    }
    sendAccountVerb(oauthCancelVerb())
  }, [sendAccountVerb, activeSessionId])

  const submitOAuthPasteCode = useCallback(
    (code: string) => sendAccountVerb(oauthPasteCodeVerb(code)),
    [sendAccountVerb],
  )
  const submitOAuthAlias = useCallback(
    (alias: string) => sendAccountVerb(oauthAliasVerb(alias)),
    [sendAccountVerb],
  )

  // P4-15 — accept trust for the active session's cwd (the trust-gate's primary
  // action). The renderer NAMES no path (HC1): the sidecar persists trust for
  // its OWN spawn cwd via the engine's `saveCurrentProjectConfig` and
  // re-broadcasts `workspace-trust.snapshot`, which clears the gate. Decline is
  // NOT a verb — it closes the tab (Q1 TUI parity: no read-only).
  const sendWorkspaceTrust = useCallback(() => {
    if (!activeSessionId) return
    getBridge().workspaceTrustVerb(activeSessionId, {
      type: 'workspace.trust',
      requestId: crypto.randomUUID(),
    })
  }, [activeSessionId])

  // P4-8b — stop/kill a running task in the active session (the deferred worker
  // Stop/kill action; primary case: an orchestrator `local_agent` worker). The
  // renderer NAMES only the target taskId; the sidecar re-resolves it against the
  // live store and dispatches the engine's own `stopTask`. The kill's store
  // mutation drives the `tasks.snapshot` re-broadcast, which re-renders the row as
  // stopped; the `task-control.result` frame is the (redacted) ack.
  const sendStopTask = useCallback(
    (taskId: string) => {
      if (!activeSessionId) return
      getBridge().taskControlVerb(activeSessionId, {
        type: 'task.stop',
        requestId: crypto.randomUUID(),
        taskId,
      })
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

  const sendSettingWrite = useCallback(
    (input: SettingWriteInput) => {
      if (!activeSessionId) return
      // P4-19 — the renderer names {source,key,value}; the sidecar re-validates
      // and applies it under the cross-process settings lock. requestId is a
      // UX correlation field only (the sidecar bounds it structurally).
      getBridge().settingsVerb(activeSessionId, {
        type: 'settings.setValue',
        requestId: crypto.randomUUID(),
        source: input.source,
        key: input.key,
        value: input.value,
      })
    },
    [activeSessionId],
  )

  // P4-6b — dispatch a session-action WRITE verb (rename / export / branch) to the
  // TARGET session's sidecar. The renderer names only intent (a session id + a
  // rename title); the sidecar re-validates and runs the engine's own machinery.
  // The outcome returns as a `session-action.result` frame (→ the toast effect).
  const sendSessionActionVerb = useCallback(
    (sessionId: SessionId, verb: SessionActionVerbMessage) => {
      getBridge().sessionActionVerb(sessionId, verb)
    },
    [],
  )

  // P4-6b — surface the sidecar's real outcome (never an optimistic guess): toast
  // the redacted `message`. Deduped by `requestId` so a re-render never
  // re-toasts. (rename's live relabel rides the existing `session-title` outbound
  // frame — no extra renderer work.)
  // Deduped by requestId across ALL sessions (a globally-unique id toasts once,
  // ever) so switching back to a tab that already ran an action never re-surfaces
  // its stale outcome.
  //
  // P4-30 — an export result belonging to an OPEN ExportDialog is that dialog's
  // to render, so this effect stays silent for it (and marks it seen, so closing
  // the dialog can never make a stale outcome pop as a toast later). Read through
  // a ref, not a dep: the effect must fire on the RESULT, not on the dialog
  // opening or closing.
  const openExportRequestIdRef = useRef<string | null>(null)
  openExportRequestIdRef.current = exportDialog?.requestId ?? null
  const toastedActionRequestsRef = useRef<Set<string>>(new Set())

  // P4-29 — tag results, which the effect below cannot handle: a Sessions-page
  // tag targets any LIVE row, not necessarily the active tab, so its result never
  // lands in `selectLatestSessionActionResult(…, activeSessionId)`. This scans
  // every session's latest result for the ids THIS renderer minted, toasts the
  // sidecar's own message, and — only on `ok` — echoes the write to the Sessions
  // page so the row does not visibly revert until the catalog re-enumerates
  // (up to `SESSIONS_CATALOG_REFRESH_INTERVAL_MS`). It runs BEFORE the general
  // effect and claims the requestId, so a tag on the active tab toasts once.
  const pendingTagWritesRef = useRef<
    Map<string, { sessionIds: readonly string[]; tag: string | null }>
  >(new Map())
  useEffect(() => {
    // A bulk tag writes one verb per row, so a single pass can settle SEVERAL
    // results at once. Collect them and set the echo ONCE: calling the setter per
    // result would keep only the last, while every result was already marked
    // consumed, so the other rows would show no tag until the next refresh.
    const entries: { sessionIds: readonly string[]; tag: string | null }[] = []
    for (const result of Object.values(sessionActionRuntime.lastBySession)) {
      if (!result || result.verb !== 'tag') continue
      if (toastedActionRequestsRef.current.has(result.requestId)) continue
      const pending = pendingTagWritesRef.current.get(result.requestId)
      if (!pending) continue
      toastedActionRequestsRef.current.add(result.requestId)
      pendingTagWritesRef.current.delete(result.requestId)
      if (result.ok) entries.push(pending)
      toast(result.message, { tone: result.ok ? 'success' : 'danger' })
    }
    if (entries.length > 0) setSessionsTagEcho({ entries })
  }, [sessionActionRuntime, toast])

  // P4-29 — DISARM both Sessions-page one-shots when the page goes away.
  //
  // `sessionsRenameRequest` and `sessionsTagEcho` are COMMANDS, delivered once.
  // The page de-dupes them by object identity in a ref, and that ref dies with
  // the page, which unmounts whenever the user leaves this view. A command left
  // set is therefore re-delivered on the next visit: dismiss a rename with
  // Escape, open a session, come back, and the editor reopens by itself; a tag
  // echo likewise re-applies a value the catalog may since have changed. The
  // guard has to outlive the consumer, so it lives here.
  useEffect(() => {
    if (activeView === 'sessions') return
    setSessionsRenameRequest(null)
    setSessionsTagEcho(null)
  }, [activeView])

  const latestSessionActionResult = selectLatestSessionActionResult(
    sessionActionRuntime,
    activeSessionId,
  )
  useEffect(() => {
    const result = latestSessionActionResult
    if (!result) return
    if (toastedActionRequestsRef.current.has(result.requestId)) return
    toastedActionRequestsRef.current.add(result.requestId)
    if (result.requestId === openExportRequestIdRef.current) return
    toast(result.message, { tone: result.ok ? 'success' : 'danger' })
  }, [latestSessionActionResult, toast])

  // P4-30 — latch the open Export dialog's OWN result the first time it lands.
  // It reads the target session's latest result rather than the active session's,
  // because the dialog can target any row the menu was opened for. A pending
  // projection never overwrites a latched one, which is what keeps a later
  // unrelated result from blanking the rendered transcript.
  useEffect(() => {
    if (!exportDialog) return
    const projected = selectExportPreview(
      selectLatestSessionActionResult(
        sessionActionRuntime,
        exportDialog.sessionId,
      ),
      exportDialog.requestId,
    )
    if (projected.status === 'pending') return
    setLatchedExport(current =>
      current?.requestId === exportDialog.requestId
        ? current
        : { requestId: exportDialog.requestId, state: projected },
    )
  }, [exportDialog, sessionActionRuntime])

  // Decision #5 (audit §I.4) — surface a FAILED verb ack that would otherwise be
  // silent (a success re-broadcasts a snapshot and the UI already updates; a
  // failure mutates nothing). Same dedup-by-requestId discipline as the
  // session-action toast above: a re-render or tab-switch never re-toasts a stale
  // outcome. The message is the sidecar's real, redacted reason — never invented.
  const toastedVerbAckRequestsRef = useRef<Set<string>>(new Set())
  const latestVerbAckResult = selectLatestVerbAckResult(
    verbAckResult,
    activeSessionId,
  )
  useEffect(() => {
    const result = latestVerbAckResult
    if (!result) return
    if (toastedVerbAckRequestsRef.current.has(result.requestId)) return
    toastedVerbAckRequestsRef.current.add(result.requestId)
    const errorToast = verbAckErrorToast(result)
    if (errorToast) toast(errorToast.message, { tone: errorToast.tone })
  }, [latestVerbAckResult, toast])

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

  // TabBar Split (P4-4): open the next un-panelled pane session as a new panel,
  // split off the active panel's right edge. Reuses the SAME split reducer the
  // drag-tab-to-edge path uses (P3-6) — no new wiring. The layout model forbids
  // the same session in two panels, so "split" adds a DIFFERENT session (the
  // prototype duplicates the active one; §0 flag on TabBar).
  const addWorkspacePanel = useCallback(() => {
    if (workspaceLayout.panels.length >= MAX_WORKSPACE_PANELS) return
    const shown = new Set(workspaceLayout.panels.map(panel => panel.sessionId))
    const next = paneSessionIds.find(id => !shown.has(id))
    if (!next) {
      setLayoutNotice(
        'No other session to open in a split. Create or select another session first.',
      )
      return
    }
    splitWorkspacePanelWithSession(workspaceLayout.activeIndex, 'right', next)
  }, [paneSessionIds, splitWorkspacePanelWithSession, workspaceLayout])

  // TabBar Unsplit (P4-4): drop the last panel — the existing close-panel path.
  const removeWorkspacePanel = useCallback(() => {
    if (workspaceLayout.panels.length <= 1) return
    closeWorkspacePanelAt(workspaceLayout.panels.length - 1)
  }, [closeWorkspacePanelAt, workspaceLayout])

  const closeTab = useCallback(async (sessionId: SessionId) => {
    if (shellRef.current.previews[sessionId]) {
      const plan = previewClosePlan(
        shellRef.current.tabs[sessionId] === true,
        lazyRestoreClaimsRef.current.has(sessionId),
      )
      dispatchPreviewTranscript({ type: 'preview-reset', sessionId })
      dispatchShell({ type: 'preview-close', sessionId })
      if (plan.cancelRestore) {
        cancelledRestoresRef.current.add(sessionId)
      } else {
        lazyRestoreClaimsRef.current.delete(sessionId)
      }
      if (!plan.closeLive) return
    }
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

  // CC-16 — hand a parked prompt back to the composer. Called on every terminal
  // outcome of the spawn the user's keystroke started (a rejected/thrown
  // restore here, a terminal connection status in the drain effect below), so a
  // failed reconnect surfaces the text plus an error instead of eating it.
  const releasePendingSubmit = useCallback((sessionId: SessionId) => {
    const parked = selectPendingSubmit(pendingSubmitsRef.current, sessionId)
    if (parked === null) return
    setPendingSubmits(prev => reducePendingSubmitCleared(prev, sessionId))
    setPromptDrafts(drafts =>
      reducePromptDrafts(
        drafts,
        sessionId,
        restoreDraftWithPending(selectPromptDraft(drafts, sessionId), parked),
      ),
    )
    setTransportError(PENDING_SUBMIT_RELEASED_MESSAGE)
  }, [])

  const restoreLiveSession = useCallback(
    async (sessionId: SessionId) => {
      const bridge = getBridge()
      try {
        const result = await bridge.restoreSession(sessionId)
        if (result.ok) {
          if (cancelledRestoresRef.current.delete(sessionId)) {
            lazyRestoreClaimsRef.current.delete(sessionId)
            releasePendingSubmit(sessionId)
            const closeResult = await bridge.closeSession(sessionId)
            if (!closeResult.ok) {
              setShellError(hostErrorMessage(closeResult.error))
            } else {
              setShellError(null)
            }
            return
          }
          setActiveSessionId(result.value.appSessionId)
          setActiveView('chat')
          setShellError(null)
        } else {
          lazyRestoreClaimsRef.current.delete(sessionId)
          cancelledRestoresRef.current.delete(sessionId)
          releasePendingSubmit(sessionId)
          setShellError(hostErrorMessage(result.error))
        }
      } catch (error) {
        lazyRestoreClaimsRef.current.delete(sessionId)
        cancelledRestoresRef.current.delete(sessionId)
        releasePendingSubmit(sessionId)
        setShellError(errorMessage(error))
      }
    },
    [releasePendingSubmit],
  )

  const engagePreview = useCallback(
    (sessionId: SessionId) => {
      if (!claimLazyRestore(lazyRestoreClaimsRef.current, sessionId)) return
      void restoreLiveSession(sessionId)
    },
    [restoreLiveSession],
  )

  const openPreviewPane = useCallback((sessionId: SessionId) => {
    dispatchShell({ type: 'preview-open', sessionId })
    setWorkspaceLayoutState(current =>
      focusOrAssignWorkspaceSession(current, sessionId).state,
    )
    setActiveSessionId(sessionId)
    setActiveView('chat')
    setShellError(null)
  }, [])

  // PL-A store-first path: a startup-preloaded transcript opens synchronously
  // with zero click-time IPC. A not-preloaded/cache-miss row retains IS-B's
  // existing fetch then eager-restore fallback.
  const performRestore = useCallback(
    (sessionId: SessionId) => {
      const descriptor = shellRef.current.byId[sessionId]
      if (removedIdsRef.current.has(sessionId) || !descriptor?.restorable) return
      if (
        openPreloadedPreview(
          previewTranscriptRef.current,
          sessionId,
          () => openPreviewPane(sessionId),
        )
      ) {
        return
      }

      const bridge = getBridge()
      void (async () => {
        try {
          const cache = await bridge.previewSession(sessionId)
          const currentDescriptor = shellRef.current.byId[sessionId]
          if (
            removedIdsRef.current.has(sessionId) ||
            !currentDescriptor?.restorable
          ) {
            return
          }
          if (cache) {
            dispatchPreviewTranscript({ type: 'preview-load', cache })
            openPreviewPane(sessionId)
            return
          }
          if (claimLazyRestore(lazyRestoreClaimsRef.current, sessionId)) {
            await restoreLiveSession(sessionId)
          }
        } catch (error) {
          setShellError(errorMessage(error))
        }
      })()
    },
    [openPreviewPane, restoreLiveSession],
  )

  // SESSIONS-UNIFICATION (operator ruling 2026-07-20) — open a terminal-created
  // session (a history row with no desktop registry row) as a real desktop
  // session, by its ENGINE session id. HC1: the renderer authors NO cwd — it
  // passes only the engine id; main resolves the workspace from the engine-written
  // baseline cache and spawns a resume through the same machinery as restore.
  //
  // Main dedups: if the id is ALREADY a desktop registry row (a stale-snapshot
  // race — a genuine history row is by definition not in the registry), the
  // returned descriptor is that existing row. Route it like a row click: a
  // restorable existing row goes through `performRestore` (spawn), not a bare
  // focus of an empty pane; a live/fresh-spawned one is focused directly. An
  // unresolvable id returns a typed error rendered honestly.
  const openHistorySession = useCallback(
    async (engineSessionId: string) => {
      const bridge = getBridge()
      try {
        const result = await bridge.openHistorySession(engineSessionId)
        if (!result.ok) {
          setShellError(hostErrorMessage(result.error))
          return
        }
        const descriptor = result.value
        setShellError(null)
        if (descriptor.restorable) {
          performRestore(descriptor.appSessionId)
          return
        }
        setActiveSessionId(descriptor.appSessionId)
        setActiveView('chat')
      } catch (error) {
        setShellError(errorMessage(error))
      }
    },
    [performRestore],
  )

  // P4-29 — the ONE way a catalog row is opened, shared by the Sessions-page row
  // click and the ⋯ menu's Open/Restore verb. Those two had each re-derived the
  // routing, and the menu's copy was wrong: it ran a bare `selectTab` for a
  // restorable row, so a row whose own menu said "Restore" only re-focused a dead
  // pane. `resolveSessionOpenRoute` is now the single decision
  // (`sessionsCatalogState.ts`), so a new caller cannot reintroduce the split.
  const openCatalogRow = useCallback(
    (row: MergedSessionRow) => {
      const route = resolveSessionOpenRoute(row)
      if (route.kind === 'focus') selectTab(route.appSessionId)
      else if (route.kind === 'restore') void performRestore(route.appSessionId)
      else if (route.kind === 'history') void openHistorySession(route.engineSessionId)
    },
    [selectTab, performRestore, openHistorySession],
  )

  function submitSession(
    sessionId: SessionId,
    event: FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault()
    const sessionLog = selectRawMessageLog(state, sessionId)
    const sessionConnection = selectConnection(connection, sessionId)
    // Collapsed-paste tokens are expanded back to their full text before submit
    // — the engine receives plain prompt text, never a `[Pasted text #N]` ref
    // (parity `expandPastedTextRefs`, src/history.ts:81 / handlePromptSubmit.ts:216).
    // CC-16 — `engineInputEnabled` (mid-turn) still refuses the submit exactly
    // as before; `connectPending` (a preview pane or an in-flight spawn) parks
    // it instead of dropping it. The two are never collapsed back into one flag.
    const action = planSessionSubmit({
      draft: selectPromptDraft(promptDrafts, sessionId),
      pasteEntries: selectSessionPasteState(pasteState, sessionId).entries,
      preview: hasPreviewTranscript(previewTranscript, sessionId),
      connectionStatus: sessionConnection.status,
      connectionInputEnabled: sessionConnection.inputEnabled,
      logInputEnabled: sessionLog.inputEnabled,
      alreadyParked: selectPendingSubmit(pendingSubmits, sessionId) !== null,
    })
    if (action.type === 'ignore') return
    const text = action.text
    // Both paths retire the draft the same way: the prompt has left the
    // composer, so the pastes it expanded are spent and it joins ↑/↓ history.
    // A parked prompt that is later released comes back as its expanded text
    // (`restoreDraftWithPending`) — the pills are gone, the content is not.
    const retireDraft = (): void => {
      setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, ''))
      setPasteState(prev => reduceSessionPastesCleared(prev, sessionId))
      setHistoryState(prev => reduceHistoryPushed(prev, sessionId, text))
    }
    if (action.type === 'hold') {
      setPendingSubmits(prev => reducePendingSubmitHeld(prev, sessionId, text))
      retireDraft()
      setTransportError(null)
      return
    }

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    try {
      getBridge().submit(sessionId, text)
      retireDraft()
      setTransportError(null)
    } catch (error) {
      setTransportError(errorMessage(error))
    }
  }

  // CC-16 drain — the parked prompt rides the SAME `app.submit` the moment the
  // session accepts input, so the ~0.6 s spawn is hidden behind the typing the
  // user was already doing. A terminal status releases it back into the
  // composer instead: a queued prompt must never disappear on a failed spawn.
  useEffect(() => {
    for (const sessionId of Object.keys(pendingSubmits)) {
      const parked = pendingSubmits[sessionId]
      if (parked === undefined) continue
      const outcome = resolvePendingSubmit(selectConnection(connection, sessionId))
      if (outcome === 'wait') continue
      if (outcome === 'release') {
        releasePendingSubmit(sessionId)
        continue
      }
      try {
        getBridge().submit(sessionId, parked)
        setPendingSubmits(prev => reducePendingSubmitCleared(prev, sessionId))
        setTransportError(null)
      } catch (error) {
        releasePendingSubmit(sessionId)
        setTransportError(errorMessage(error))
      }
    }
  }, [connection, pendingSubmits, releasePendingSubmit])

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
    (
      sessionId: SessionId,
      currentDraft: string,
      content: string,
      // P4-24: splice the `[Pasted text #N]` token in at the CARET (the textarea
      // selection the paste replaced), not blindly at the end of the draft (the
      // old single-line adaptation's §0 flag). Absent selection → append.
      selectionStart?: number,
      selectionEnd?: number,
    ): void => {
      const { state: nextPasteState, token } = reducePasteAdded(
        pasteState,
        sessionId,
        content,
      )
      setPasteState(nextPasteState)
      const start = selectionStart ?? currentDraft.length
      const end = selectionEnd ?? currentDraft.length
      setSessionPrompt(
        sessionId,
        currentDraft.slice(0, start) + token + currentDraft.slice(end),
      )
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
      // One answer per request. A second response for the same id is rejected by
      // the sidecar as unknown, and that rejection un-marks the card as answered,
      // re-enabling Allow/Deny on a request that is already decided.
      const answered = selectPermissionQueue(permissions, sessionId).some(
        item => item.request.requestId === requestId && item.submitted,
      )
      if (answered) return
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
    [permissions],
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

  // A request with its OWN dedicated renderer owns the keyboard while it is up:
  // AskQuestionFlow and PlanPanel each register a `window` keydown listener, and
  // a key event reaches `document` BEFORE `window`. Leaving this listener
  // attached alongside one of them makes a single Enter resolve two unrelated
  // requests — answering a question would also allow a parallel Bash call.
  const dedicatedFlowOwnsKeyboard =
    selectAskQuestion(permissions, activeSessionId) !== null ||
    selectPlanReview(permissions, activeSessionId) !== null

  useEffect(() => {
    if (!pendingPermission || !activeSessionId) return
    if (dedicatedFlowOwnsKeyboard) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Never hijack a key the focused element already acts on: the deny
      // feedback field, and every button/menu item whose own Enter this would
      // otherwise suppress.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(FOCUSED_KEY_OWNER_SELECTOR)
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
    dedicatedFlowOwnsKeyboard,
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
	      // P4-20: AskQuestionFlow owns the AskUserQuestion request exclusively,
	      // the same way (its own dedicated renderer + keyboard handler).
	      const sessionAskQuestion =
	        sessionConnection.status === 'ready'
	          ? selectAskQuestion(permissions, sessionId)
	          : null
	      // The generic per-tool card queue = the pending queue minus both
	      // dedicated-renderer families (plan + ask).
	      const sessionDisplayQueue =
	        sessionConnection.status === 'ready'
	          ? selectGenericPermissionQueue(
	              selectNonPlanPermissionQueue(permissions, sessionId),
	            )
	          : []
	      const descriptor = tabDescriptorsById.get(sessionId)
          const panelPreviewTranscript = selectPreviewTranscript(
            previewTranscript,
            sessionId,
          )
          const panelIsPreview = panelPreviewTranscript !== null
	      const panelPartialCount = sessionLog.messages.filter(
	        message => message.type === 'stream_event',
	      ).length
	      // In-session empty-state Welcome context (read-only): THIS session's
	      // Codex pool snapshot (the pool is process-global, so the first-reported
	      // snapshot is a valid fallback before this session's own frame lands —
	      // the launcher precedent) + its agent-mode active flag. Both are the SAME
	      // domain seams the reauth banner / WelcomeScreen already read.
	      const panelAccounts =
	        selectAccountsSnapshot(accounts, sessionId) ??
	        selectFirstAccountsSnapshot(accounts)
	      const panelOrchestratorActive =
	        selectAgentModeSnapshot(orchestrator, sessionId)?.active ?? false
	      // Read-only git branch for the empty-state meta strip — from the session
	      // log's `gitBranch` (shared catalog seam), keyed by this panel's session.
	      // Matched on `appSessionId` for the same reason `activeSessionRow` is
	      // (:911): `row.sessionId` holds the engineSessionId once one is assigned,
	      // so matching on it misses every session that has reached ready.
	      const panelBranch =
	        sessionCatalogRows.find(r => r.appSessionId === sessionId)?.gitBranch ??
	        null
	      // P4-24c — the LIVE composer run-controls seam (Model/effort/fast + the
	      // real picker options), re-broadcast on every change so the faces reflect
	      // this session's current state with no respawn. Supersedes the P4-24 read
	      // from the spawn-frozen diagnostics snapshot for the composer faces.
	      const panelRunControls = selectRunControlsSnapshot(runControls, sessionId)
	      const panelProvider = panelRunControls?.model.provider ?? null
	      const panelActiveCodexAccount =
	        panelProvider === 'openai' ? selectActiveAccount(panelAccounts) : null
	      const panelActiveAnthropicAccount =
	        shouldShowAnthropicPoolAccount(panelProvider, panelAccounts)
	          ? selectActiveAnthropicAccount(panelAccounts)
	          : null
      // The composer slash picker's rich catalog (name + arg-hint + description)
      // for THIS pane's session, from the `slash-catalog.snapshot` read seam.
      const panelSlashCatalog = selectSlashCatalog(slashCatalog, sessionId)
	      return {
	        sessionId,
	        descriptor,
	        connection: sessionConnection,
	        content: (
	          <SessionPane
	            accountsSnapshot={panelAccounts}
	            activeAccount={panelActiveCodexAccount}
	            activeAnthropicAccount={panelActiveAnthropicAccount}
	            accountsLastResult={accounts.lastResult}
            onSwitchAccount={panelProvider === 'openai' ? verb => {
              // The composer profile popover's switch — the engine's own
              // `account.switch` verb to THIS pane's sidecar (its sessionId, not
              // the globally-active one), mirroring the run-control verbs. The
              // renderer only NAMES the id; the sidecar re-resolves it (T6).
              // The verb (with its correlation requestId) is minted by
              // SessionPane itself (ACCT-5) so it can track the same id it
              // dispatches here against `accounts.lastResult`.
              try {
                getBridge().accountVerb(sessionId, verb)
                setTransportError(null)
              } catch (error) {
                setTransportError(errorMessage(error))
              }
            } : undefined}
            onManageAccounts={() => setActiveView('accounts')}
	            activeConnection={sessionConnection}
	            activeDescriptor={descriptor}
	            activeLog={sessionLog}
	            activeSessionId={sessionId}
                isActivePane={sessionId === activeSessionId}
                preview={panelIsPreview}
                previewTruncationMessage={selectPreviewTruncationMessage(
                  previewTranscript,
                  sessionId,
                )}
                onPreviewEngage={() => engagePreview(sessionId)}
                previewRunFacts={selectPreviewRunFactsFor(
                  previewTranscript,
                  sessionId,
                )}
	            branch={panelBranch}
	            model={panelRunControls?.model.current ?? null}
	            reasoningEffort={panelRunControls?.effort.current ?? null}
	            fastMode={panelRunControls?.fast.active ?? false}
	            runControls={panelRunControls}
            slashCatalog={panelSlashCatalog}
	            onSetModel={model => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'model.set',
	                  requestId: newRequestId(),
	                  model,
	                })
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	              }
	            }}
	            onSetEffort={effort => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'effort.set',
	                  requestId: newRequestId(),
	                  effort,
	                })
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	              }
	            }}
	            onSetFast={active => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'fast.set',
	                  requestId: newRequestId(),
	                  active,
	                })
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	              }
	            }}
	            orchestratorActive={panelOrchestratorActive}
		            onToggleOrchestrator={next => {
		              // P4-8b — toggle THIS panel's session (its own sessionId, not
		              // the globally-active one), mirroring setPermissionMode's
		              // per-panel dispatch. The sidecar re-broadcasts
		              // agent-mode.snapshot, which flips the reflected `active`.
		              try {
		                getBridge().setAgentMode(sessionId, next)
		                setTransportError(null)
		              } catch (error) {
		                setTransportError(errorMessage(error))
		              }
		            }}
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
	            askQuestion={sessionAskQuestion}
	            onAnswerQuestions={answers => {
	              // P4-20 — the answer round-trips via the dedicated
	              // `answerQuestions` verb (NOT respondPermission): the renderer
	              // sends option indices + freeform; the sidecar re-attaches the
	              // engine's own labels and resolves the pending request as an allow
	              // (decisions/ASK-USER-QUESTION-ANSWER.md). Track submit like a
	              // permission response so the flow can show its in-flight state.
	              if (!sessionAskQuestion) return
	              const requestId = sessionAskQuestion.request.requestId
	              dispatchPermission({ type: 'submitted', sessionId, requestId })
	              try {
	                getBridge().answerQuestions(sessionId, requestId, answers)
	                setTransportError(null)
	              } catch (error) {
	                dispatchPermission({
	                  type: 'submissionFailed',
	                  sessionId,
	                  requestId,
	                })
	                setTransportError(errorMessage(error))
	              }
	            }}
	            onCancelQuestions={() => {
	              // Decline reuses the existing permission deny path (there is no
	              // cancel verb — ASK-USER-QUESTION-ANSWER.md §2).
	              if (!sessionAskQuestion) return
	              respondToPermission(
	                sessionId,
	                sessionAskQuestion.request.requestId,
	                buildDenyResponse('User declined to answer questions'),
	              )
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
	            pendingSubmit={selectPendingSubmit(pendingSubmits, sessionId)}
	            history={selectHistory(historyState, sessionId)}
	            onPaste={(content, selectionStart, selectionEnd) =>
	              addSessionPaste(
	                sessionId,
	                selectPromptDraft(promptDrafts, sessionId),
	                content,
	                selectionStart,
	                selectionEnd,
	              )
	            }
	            onRemovePaste={entry =>
	              removeSessionPaste(
	                sessionId,
	                selectPromptDraft(promptDrafts, sessionId),
	                entry,
	              )
	            }
		            transcript={panelPreviewTranscript ?? transcript}
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
        rows: shellDescriptors,
        activeSessionId,
        hasPanels: workspacePanels.length > 0,
        slashCatalog: selectSlashCatalog(slashCatalog, activeSessionId) ?? [],
        recentItemIds: recentPaletteItemIds,
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
          navigatePage: page => setActiveView(page),
        },
      })
    : EMPTY_PALETTE_ITEMS

  // P4-15 — the active session's per-domain startup facts. Trust gate (per
  // session-create, `workspace-trust.snapshot` P4-14) takes precedence over
  // first-run OAuth (no credentialed account → pool initialized but empty),
  // mirroring the engine's trust→auth startup order (`init.ts`).
  const activeAccountsSnapshot = selectAccountsSnapshot(accounts, activeSessionId)
  const activeTrustSnapshot = selectWorkspaceTrustSnapshot(
    workspaceTrust,
    activeSessionId,
  )
  const showTrustGate =
    !!activeSessionId && activeTrustSnapshot?.trusted === false
  const showFirstRunOAuth = shouldShowFirstRunOAuth(
    activeAccountsSnapshot,
    showTrustGate,
  )

  // P4-15 — the live OAuth progress (the back-channel) + the sub-state VIEWS
  // derived from it. One view now: the first-run surface (and the add-account
  // overlay, which reuses it) owns starting/waiting_for_login/waiting_for_alias/
  // success/error. The reauth card that used to own waiting/error is deleted
  // (P4-34); the blocking modal was already CUT.
  const oauthProgress = selectOAuthProgress(accounts, activeSessionId)
  const firstRunOAuthView: StartupOAuthView = oauthProgress
    ? oauthProgress.state === 'waiting_for_login'
      ? { phase: 'waiting', url: oauthProgress.url }
      : oauthProgress.state === 'waiting_for_alias'
        ? { phase: 'alias' }
        : oauthProgress.state === 'success'
          ? { phase: 'success' }
          : oauthProgress.state === 'error'
            ? { phase: 'error', message: oauthProgress.message }
            : { phase: 'waiting', url: null } // 'starting' — url not minted yet
    : oauthStarting
      ? { phase: 'waiting', url: null }
      : { phase: 'ready' }

  // Keep the first-run surface mounted through its `success` dwell even once the
  // account has landed (pool no longer empty), so the "Signed in" beat is seen.
  const showFirstRunOAuthSurface =
    showFirstRunOAuth ||
    (oauthContext === 'first-run' && oauthProgress?.state === 'success')

  // An OAuth flow with NO owning context, on a non-empty pool, was started by the
  // P4-5 AddAccountDialog ("add account"). Adopt it into the SAME shared OAuth
  // surface (as a top-level overlay) so its sub-states — crucially the alias step
  // a new account needs — are reachable, rather than stranding the flow with no
  // UI. Reuses `account.login`'s back-channel; no second login path.
  const adoptOrphanOAuth =
    !showTrustGate &&
    !showFirstRunOAuthSurface &&
    oauthContext === null &&
    oauthProgress != null &&
    oauthProgress.state !== 'success'

  const showAddAccountOAuthSurface =
    !showTrustGate &&
    !showFirstRunOAuthSurface &&
    oauthContext === 'add-account' &&
    (oauthStarting || oauthProgress != null)

  // Reset flow-local framing once the first-run surface should no longer show and
  // its progress has cleared (e.g. an account was added out of band), so a later
  // re-entry starts at the sign-in CTA rather than a stranded spinner.
  useEffect(() => {
    if (
      !showFirstRunOAuthSurface &&
      oauthContext === 'first-run' &&
      oauthProgress == null
    ) {
      setOauthStarting(false)
      setOauthContext(null)
    }
  }, [showFirstRunOAuthSurface, oauthContext, oauthProgress])

  // First-run `success`: brief dwell on the "Signed in" card, then clear so the
  // now-populated pool advances to the normal UI (the real flow completes on the
  // token write; this is a short presentation beat, not a scripted auth timer).
  useEffect(() => {
    if (oauthContext !== 'first-run' || oauthProgress?.state !== 'success') return
    const timer = window.setTimeout(() => {
      setOauthStarting(false)
      setOauthContext(null)
      if (activeSessionId) {
        dispatchAccounts({ type: 'oauthReset', sessionId: activeSessionId })
      }
    }, 900)
    return () => window.clearTimeout(timer)
  }, [oauthContext, oauthProgress, activeSessionId])

  // Add-account `success`: keep the shared surface mounted long enough to
  // acknowledge completion, then clear its session-scoped progress. Unlike the
  // old orphan adoption path, retry retains the add-account owner throughout.
  useEffect(() => {
    if (oauthContext !== 'add-account' || oauthProgress?.state !== 'success') {
      return
    }
    const timer = window.setTimeout(() => {
      setOauthStarting(false)
      setOauthContext(null)
      if (activeSessionId) {
        dispatchAccounts({ type: 'oauthReset', sessionId: activeSessionId })
      }
    }, 900)
    return () => window.clearTimeout(timer)
  }, [oauthContext, oauthProgress, activeSessionId])

  return (
    <div className="flex h-screen bg-app-bg font-sans text-text-primary">
      {/* Sidebar rail (P3-5b): the full roster (live ∪ restorable) + the
       * restore-offer, alongside the TabBar's live ∪ preview view. */}
      <Sidebar
        rows={sessionCatalogRows}
        activeSessionId={activeSessionId}
        activeView={activeView}
        onSelectView={setActiveView}
        onSelectLive={selectTab}
        onRestore={sessionId => void performRestore(sessionId)}
        onOpenHistory={engineSessionId => void openHistorySession(engineSessionId)}
        onOpenRowActions={(sessionId, anchor) =>
          setSessionActionsTarget({ sessionId, anchor, origin: 'sidebar' })
        }
        /* P4-33 (Sidebar.jsx:80) — the row's ⋮ menu and rename editor are
         * App-level `fixed` overlays, so they float OUTSIDE the rail's hover box:
         * moving the pointer toward one fires onMouseLeave and collapses the
         * sidebar out from under a menu still anchored to a now-hidden row. Hold
         * it open while a SIDEBAR-anchored overlay is up. */
        menuActive={
          sessionActionsTarget?.origin === 'sidebar' ||
          renamingSession?.origin === 'sidebar'
        }
        onNewSessionInWorkspace={repId => void newSessionInWorkspace(repId)}
        modelForSession={id =>
          selectDiagnosticsSnapshot(diagnostics, id)?.mainLoopModelForSession ??
          null
        }
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabs}
          activeSessionId={activeSessionId}
          onSelect={selectTab}
          onClose={closeTab}
          onRestart={restartTab}
          onNewTab={newSession}
          onOpenActions={(sessionId, anchor) =>
            setSessionActionsTarget({ sessionId, anchor, origin: 'tab' })
          }
          panelCount={workspaceLayout.panels.length}
          canAddPanel={paneSessionIds.length > workspaceLayout.panels.length}
          onAddPanel={addWorkspacePanel}
          onRemovePanel={removeWorkspacePanel}
        />

        {/* P4-6b — the tab ⋯ actions overflow + its MetadataInspector drawer +
         * inline rename editor. The menu resolves and acts against the row it was
         * OPENED for (`sessionActionsTarget.sessionId`), never the active tab.
         * rename/export/branch dispatch the real WRITE verbs to that session's
         * sidecar; metadata + copy + open read state the renderer already holds. */}
        {sessionActionsTarget
          ? (() => {
              const targetRow = sessionCatalogRows.find(
                row => row.appSessionId === sessionActionsTarget.sessionId,
              )
              if (!targetRow) return null
              const targetId = sessionActionsTarget.sessionId
              return (
                <SessionActionsMenu
                  items={resolveSessionActions(targetRow, {
                    isActiveOpen: targetId === activeSessionId,
                  }).filter(
                    // The prototype's `hide=['metadata']` for the Sessions-page
                    // entry point: the inspector reads the ATTACHED tab, so on a
                    // manager page listing every session it is disabled for all
                    // but one row. Filtered here, so the shared menu component
                    // stays presentation-only.
                    item =>
                      !sessionActionsTarget.fromSessionsPage ||
                      item.kind !== 'metadata',
                  )}
                  anchor={sessionActionsTarget.anchor}
                  onAction={kind => {
                    if (kind === 'metadata') setMetadataOpen(true)
                    // `copy` is the flyout HOST and is never dispatched; P4-30
                    // split the real action out as `copy-text`.
                    else if (kind === 'copy-text') copyForLlm(targetId)
                    // P4-29 — was a bare `selectTab`, which merely re-focused a
                    // stale pane for the very rows whose menu says "Restore".
                    else if (kind === 'open') openCatalogRow(targetRow)
                    else if (kind === 'rename')
                      sessionActionsTarget.fromSessionsPage
                        ? setSessionsRenameRequest({
                            sessionId: targetRow.sessionId,
                          })
                        : setRenamingSession({
                            sessionId: targetId,
                            anchor: sessionActionsTarget.anchor,
                            initial: targetRow.title ?? '',
                            // P4-33 — the rename editor replaces the menu in
                            // place, so it inherits whichever surface anchored it.
                            origin: sessionActionsTarget.origin,
                          })
                    else if (kind === 'export') {
                      // P4-30 — dispatch AND open: the dialog exists to show the
                      // transcript the sidecar renders, so it opens pending and
                      // fills in when its own result arrives.
                      const requestId = newRequestId()
                      setExportDialog({
                        sessionId: targetId,
                        requestId,
                        title: targetRow.title ?? null,
                      })
                      sendSessionActionVerb(targetId, {
                        type: 'session.export',
                        requestId,
                      })
                    } else if (kind === 'branch')
                      // P4-30 — CONFIRM FIRST. The verb writes a real fork on
                      // disk; it is dispatched by the dialog, not by this click.
                      setBranchConfirm({
                        sessionId: targetId,
                        title: targetRow.title ?? null,
                      })
                  }}
                  onClose={() => setSessionActionsTarget(null)}
                />
              )
            })()
          : null}

        {renamingSession ? (
          <SessionRenamePopover
            anchor={renamingSession.anchor}
            initial={renamingSession.initial}
            onCancel={() => setRenamingSession(null)}
            onCommit={title => {
              const trimmed = title.trim()
              if (trimmed && trimmed !== renamingSession.initial) {
                sendSessionActionVerb(renamingSession.sessionId, {
                  type: 'session.rename',
                  requestId: newRequestId(),
                  title: trimmed,
                })
              }
              setRenamingSession(null)
            }}
          />
        ) : null}

        {/* P4-30 — the SAModal dialog layer (PARITY-LEDGER §17). Branch gates the
         * fork behind a confirmation; Export shows the engine-rendered transcript
         * with its file name before anything is copied. */}
        {branchConfirm ? (
          <BranchDialog
            title={branchConfirm.title}
            onClose={() => setBranchConfirm(null)}
            onConfirm={() => {
              sendSessionActionVerb(branchConfirm.sessionId, {
                type: 'session.branch',
                requestId: newRequestId(),
              })
              setBranchConfirm(null)
            }}
          />
        ) : null}

        {exportDialog
          ? (() => {
              const preview = selectLatchedExportPreview(
                latchedExport,
                exportDialog.requestId,
              )
              return (
                <ExportDialog
                  title={exportDialog.title}
                  fileName={exportFileName(exportDialog.title)}
                  preview={preview}
                  {...(preview.status === 'ready'
                    ? {
                        onCopy: () => {
                          void navigator.clipboard
                            .writeText(preview.text)
                            .then(() =>
                              toast('Transcript copied to clipboard', {
                                tone: 'success',
                              }),
                            )
                            .catch(() =>
                              toast('Could not write to the clipboard', {
                                tone: 'warn',
                              }),
                            )
                        },
                      }
                    : {})}
                  onClose={() => setExportDialog(null)}
                />
              )
            })()
          : null}

        {metadataOpen && activeSessionId ? (
          <MetadataInspector
            session={buildSessionMetadataView({
              sessionId: activeSessionId,
              row: activeSessionRow,
              permissionMode:
                selectPermissionContext(permissions, activeSessionId)?.mode ??
                null,
              threadGoal: selectThreadGoalSnapshot(goalMemory, activeSessionId),
            })}
            sessionState={buildSessionInspectorState({
              cwd: tabDescriptorsById.get(activeSessionId)?.cwd ?? null,
              settings: selectSettingsSnapshot(settings, activeSessionId),
              permissionContext: selectPermissionContext(
                permissions,
                activeSessionId,
              ),
              workspaceTrust: selectWorkspaceTrustSnapshot(
                workspaceTrust,
                activeSessionId,
              ),
              diagnostics: selectDiagnosticsSnapshot(diagnostics, activeSessionId),
            })}
            log={selectRawMessageLog(state, activeSessionId)}
            tasks={selectTasksSnapshot(tasks, activeSessionId)}
            onClose={() => setMetadataOpen(false)}
          />
        ) : null}

        {shellError ? (
          <div className="border-b border-shell-seam bg-shell-chrome px-6 py-1.5 text-xs text-tone-danger">
            {shellError}
          </div>
        ) : null}

        {/* The all-dead wall, per-account reauth banners, and the collapsed chip
         * were REMOVED entirely (#12, 2026-07-20 —
         * `docs/migration/decisions/STARTUP-GATES.md`): zero-healthy no longer
         * renders a surface or blocks submit; the pool error surfaces inline at
         * request time. P4-34 removed the last remnant, a floating
         * `ReauthOAuthProgress` card: with the banner gone, the only thing that
         * could put the OAuth flow into a `'reauth'` context was that card's own
         * Retry button, so nothing could ever open it. Re-authentication now runs
         * through the same `StartupOAuth`/add-account surfaces as any other
         * sign-in. */}

        {/* P4-15 — a "add account" (AddAccountDialog) OAuth flow started with no
         * owning surface: adopt it into the shared OAuth surface as a top-level
         * overlay so it can complete (incl. the alias step), regardless of the
         * active view. First-run owns its own surface above. */}
        {adoptOrphanOAuth || showAddAccountOAuthSurface ? (
          <div className="absolute inset-0 z-50">
              <StartupOAuth
                view={firstRunOAuthView}
                provider={oauthProvider}
                onBegin={provider => beginOAuth('add-account', provider)}
                onCancel={clearOAuth}
              onPasteCode={submitOAuthPasteCode}
              onSubmitAlias={submitOAuthAlias}
                onRetry={() => beginOAuth('add-account', oauthProvider)}
            />
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
            permissionContext={selectPermissionContext(permissions, activeSessionId)}
            agentsSnapshot={selectAgentConfigSnapshot(agentConfig, activeSessionId)}
            cwd={activeSessionId ? tabDescriptorsById.get(activeSessionId)?.cwd ?? null : null}
            diagnosticsSnapshot={selectDiagnosticsSnapshot(diagnostics, activeSessionId)}
            extensionsSnapshot={selectExtensionsSnapshot(extensions, activeSessionId)}
            initialCategory="agents"
            memorySnapshot={selectMemorySnapshot(goalMemory, activeSessionId)}
            onRemoteVerb={sendRemoteSettingsVerb}
            onSettingWrite={sendSettingWrite}
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
            snapshot={selectGlobalAccountsSnapshot(accounts)}
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
            onOpenRow={openCatalogRow}
            onNewSession={() => void newSession()}
            onOpenRowActions={(row, anchor) => {
              if (row.appSessionId == null) return
              setSessionActionsTarget({
                sessionId: row.appSessionId,
                anchor,
                fromSessionsPage: true,
                origin: 'sessions-page',
              })
            }}
            onRenameRow={(row, title) => {
              if (row.appSessionId == null) return
              sendSessionActionVerb(row.appSessionId, {
                type: 'session.rename',
                requestId: newRequestId(),
                title,
              })
            }}
            onTagRows={(targets, tag) => {
              // One verb per row: each write runs inside that session's OWN
              // engine (N-process, LOCKED). The ids are remembered so the
              // confirmed result can be echoed back to the page.
              for (const row of targets) {
                if (row.appSessionId == null) continue
                const requestId = newRequestId()
                pendingTagWritesRef.current.set(requestId, {
                  sessionIds: [row.sessionId],
                  tag,
                })
                sendSessionActionVerb(row.appSessionId, {
                  type: 'session.tag',
                  requestId,
                  tag: tag ?? '',
                })
              }
            }}
            renameRequest={sessionsRenameRequest}
            tagEcho={sessionsTagEcho}
          />
        ) : showTrustGate && activeSessionId ? (
          // Per-session-create trust gate (D4 §1.1): this session's cwd is
          // untrusted. Trust persists via the engine's own store + re-broadcast;
          // decline closes the tab (Q1 TUI parity — no read-only mode).
          <div className="relative flex min-h-0 flex-1">
            <WorkspaceTrustGate
              cwd={tabDescriptorsById.get(activeSessionId)?.cwd ?? activeSessionId}
              // The scope the accept actually writes at (git root, not the cwd) —
              // straight off the engine snapshot so the prompt names what it does.
              trustRoot={activeTrustSnapshot?.trustRoot ?? null}
              onTrust={sendWorkspaceTrust}
              onDecline={() => closeTab(activeSessionId)}
              errorMessage={selectWorkspaceTrustError(workspaceTrust, activeSessionId)}
            />
          </div>
        ) : showFirstRunOAuthSurface ? (
          // First-run: no credentialed Codex account exists. Surface the OAuth
          // flow — its sub-states (waiting/paste-code/alias/success/error) are
          // DRIVEN by the real `oauth.login.progress` back-channel; the engine
          // owns the token. Unmounts after the success dwell once the pool gains
          // the account (the snapshot re-broadcast on `success`).
          <div className="relative flex min-h-0 flex-1">
            <StartupOAuth
              view={firstRunOAuthView}
              provider={oauthProvider}
              onBegin={provider => beginOAuth('first-run', provider)}
              onCancel={clearOAuth}
              onPasteCode={submitOAuthPasteCode}
              onSubmitAlias={submitOAuthAlias}
              onRetry={() => beginOAuth('first-run', oauthProvider)}
            />
          </div>
        ) : workspacePanels.length === 0 || !activeSessionId ? (
          // P4-17 — the rich launcher replaces the minimal empty shell. Reads
          // derived recents (D5) + the P4-5 pool + agent-mode, wires open/restore
          // (HC1 id-only) and the HC1 folder picker (post-spawn trust gate).
          <WelcomeScreen
            recents={welcomeRecents}
            accounts={activeAccountsSnapshot ?? selectGlobalAccountsSnapshot(accounts)}
            orchestratorActive={
              selectAgentModeSnapshot(orchestrator, activeSessionId)?.active ?? false
            }
            onOpenRecent={recent => {
              if (recent.appSessionId == null) return
              if (recent.live) selectTab(recent.appSessionId)
              else void performRestore(recent.appSessionId)
            }}
            onOpenFolder={() => void newSession()}
          />
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
        onRunItem={itemId =>
          setRecentPaletteItemIds(previous => [
            itemId,
            ...previous.filter(id => id !== itemId),
          ].slice(0, 5))
        }
        items={paletteItems}
      />

      {/* Background tasks dialog (P4-9): ⌘K → "Background tasks" or the strip pill. */}
      <TasksDialog
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        snapshot={selectTasksSnapshot(tasks, activeSessionId)}
        hasActiveSession={activeSessionId !== null}
        onStopTask={activeSessionId ? sendStopTask : undefined}
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

/**
 * One session pane — the P2 transcript spine + prompt + permission surfaces.
 * App supplies one instance per visible workspace panel, scoped to that panel's
 * session id; switching focus never tears down a background session's state.
 */
export function SessionPane({
  accountsSnapshot,
  activeAccount,
  activeAnthropicAccount,
  onSwitchAccount,
  onManageAccounts,
  accountsLastResult,
  activeConnection,
  activeDescriptor,
  branch,
  activeLog,
  activeSessionId,
  isActivePane,
  preview = false,
  previewTruncationMessage = null,
  onPreviewEngage,
  previewRunFacts = null,
  allowPermission,
  model,
  reasoningEffort,
  fastMode,
  runControls,
  slashCatalog = EMPTY_SLASH_CATALOG,
  onSetModel,
  onSetEffort,
  onSetFast,
  copyForLlm,
  denyPermission,
  history,
  mentionItems,
  onApprovePlan,
  onPaste,
  onRemovePaste,
  onRevisePlan,
  askQuestion,
  onAnswerQuestions,
  onCancelQuestions,
  orchestratorActive,
  onToggleOrchestrator,
  partialCount,
  pastes,
  pendingSubmit = null,
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
  const toast = useToast()
  // ACCT-5 — correlate the composer profile popover's account switch by the
  // requestId SessionPane itself mints (switchVerb), matching AccountsPage's
  // pendingRef/lastResult pattern: NO optimistic UI, toast only on the real
  // `account.result` for this session.
  const pendingAccountSwitchRef = useRef<string | null>(null)
  useEffect(() => {
    const pendingRequestId = pendingAccountSwitchRef.current
    if (
      pendingRequestId &&
      accountsLastResult &&
      accountsLastResult.requestId === pendingRequestId &&
      accountsLastResult.sessionId === activeSessionId
    ) {
      pendingAccountSwitchRef.current = null
      toast(accountsLastResult.message, {
        tone: resultToastTone(accountsLastResult.ok),
      })
    }
  }, [accountsLastResult, activeSessionId, toast])
  const handleSwitchAccount = onSwitchAccount
    ? (accountId: string) => {
        const verb = switchVerb(accountId)
        pendingAccountSwitchRef.current = verb.requestId
        onSwitchAccount(verb)
      }
    : undefined
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
  // The picker renders rich rows (name + arg-hint + description, prototype
  // parity) from the `slash-catalog.snapshot` read seam (the `slashCatalog`
  // prop). It falls back to the names-only `slash_commands` catalog (from the
  // init frame) when the rich snapshot is absent — a session that predates it, or
  // a degraded catalog load — so the picker never regresses below name-only.
  const slashEntries: readonly SlashCatalogEntry[] =
    slashCatalog.length > 0
      ? slashCatalog
      : selectSlashCommands(transcript, activeSessionId).map(name => ({
          name,
          description: '',
        }))
  const slashQuery = parseSlashDraft(prompt)
  const slashMatches =
    slashQuery === null ? [] : filterSlashCommands(slashEntries, slashQuery)
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

  // P4-24 multi-line composer. `composerRef` gives the keydown/paste handlers the
  // live caret (for at-caret paste, whole-token Backspace, and edge-gated ↑/↓
  // history); `isComposingRef` guards Enter/arrows during IME composition
  // (parity `Chat.jsx:716`, `src/hooks/useTextInput.ts`).
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // P4-24 — where the caret belongs after a PROGRAMMATIC draft rewrite (at-caret
  // paste, whole-token Backspace). Reassigning a controlled textarea's `value`
  // drops the selection to the end of the text, so without this the next
  // keystroke lands at the end of the draft instead of where the edit happened —
  // and a second Backspace eats the last character rather than continuing.
  // `base` is the offset the edit ends at in the OLD draft; the new caret is that
  // offset shifted by however much the rewrite changed the length.
  const pendingCaretRef = useRef<{ base: number; prevLength: number } | null>(
    null,
  )
  // Feature #4 — the composer action bar's toolbar node, so Tab / ArrowDown-when-
  // empty can move focus from the textarea into the first chip face.
  const actionBarRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const [previewEngaged, setPreviewEngaged] = useState(false)
  const previewEngageRef = useRef(onPreviewEngage)
  previewEngageRef.current = onPreviewEngage
  useEffect(() => {
    // Reset engagement when the previewed session changes. The 300 ms dwell
    // auto-spawn was removed (cut-list §I.1, ruling #3): a read-only browse no
    // longer spawns an engine process. Engagement is now driven only by composer
    // focus/pointer-down (engagePreviewPane) and the cache-miss immediate spawn.
    setPreviewEngaged(false)
  }, [activeSessionId, preview])
  const engagePreviewPane = (): void => {
    if (!preview) return
    setPreviewEngaged(true)
    previewEngageRef.current?.()
  }
  // Auto-resize the textarea to its content, capped at ~38vh, then let it scroll
  // (prototype `resizeComposer`, `Chat.jsx:437-441`). Imperative height/overflow
  // is the only way to size a textarea to its content — it is NOT a JSX inline
  // `style={{}}` (the static cap `max-h-[38vh]` stays a class). Effects never run
  // under `renderToStaticMarkup`, so the SSR pane snapshot is unaffected.
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.round(window.innerHeight * 0.38)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [prompt])

  // Put the caret back where the programmatic rewrite left off (see
  // `pendingCaretRef`). Same passive-effect DOM write as the auto-resize above.
  useEffect(() => {
    const pending = pendingCaretRef.current
    if (!pending) return
    pendingCaretRef.current = null
    const el = composerRef.current
    if (!el) return
    const caret = Math.max(
      0,
      Math.min(prompt.length, pending.base + (prompt.length - pending.prevLength)),
    )
    el.setSelectionRange(caret, caret)
  }, [prompt])

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

  // P4-18c transcript scroll + live activity. `generating` is the honest
  // turn-active signal: a ready session whose input is disabled is mid-turn
  // (the same gate the composer uses). `paused` = a pending permission request.
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [stopError, setStopError] = useState<string | null>(null)
  const generating =
    !!activeSessionId &&
    activeConnection.status === 'ready' &&
    !activeConnection.inputEnabled
  // CC-16 — the composer's two gates, kept apart: `engineInputEnabled` is the
  // engine's own "input is closed" (mid-turn), `connectPending` is "no engine
  // attached yet, and your own focus/keystroke is what attaches one". Typing,
  // sending and attaching are all allowed while connect-pending; the SUBMIT is
  // what waits (parked by `submitSession`, drained in App's CC-16 effect).
  const composerGate = selectComposerGate({
    hasSession: !!activeSessionId,
    preview,
    connectionStatus: activeConnection.status,
    connectionInputEnabled: activeConnection.inputEnabled,
    logInputEnabled: activeLog.inputEnabled,
  })
  // The placeholder never instructs the user any more: a previewed/connecting
  // pane reads exactly like a live one (prototype `Chat.jsx:1145` has no
  // connection-state placeholder at all). 'Connecting…' survives only for the
  // terminal statuses — dead/failed/exited/disconnected — which stay read-only.
  const composerPlaceholder =
    composerGate.editable || activeConnection.status === 'ready'
      ? 'Ask Cat Code anything or describe a task…'
      : 'Connecting…'
  const paused = permissionQueue.length > 0 || askQuestion !== null
  // Slice-cached: stable ref while the session's rows are unchanged, so both
  // `deriveActivity` and the token estimate share one projection.
  const nestedRows = selectNestedTranscriptRows(transcript, activeSessionId)
  const activity = deriveActivity(nestedRows)

  // IS-C (M5) — the restore affordance phase for TranscriptView. A preview pane
  // reads as "restored" (pulsing "resuming" once engaged); a no-cache restore
  // that is spawning with nothing to show yet gets the skeleton instead of an
  // empty WelcomeScreen (report F4). `engineSessionId != null` on a connecting
  // pane means a real transcript is being resumed (host.ts:342,642) — a fresh
  // `New session` has a null engineSessionId until ready, so it still Welcomes.
  const restoreConnecting =
    activeConnection.status === 'connecting' ||
    activeConnection.status === 'starting'
  const restorePhase: RestorePhase | null = preview
    ? previewEngaged
      ? 'resuming'
      : 'preview'
    : restoreConnecting &&
        activeDescriptor?.engineSessionId != null &&
        nestedRows.length === 0
      ? 'connecting'
      : null

  // Elapsed clock: reset and tick once per second while a turn runs.
  const [elapsedMs, setElapsedMs] = useState(0)
  const turnStartRef = useRef<number | null>(null)
  useEffect(() => {
    if (!generating) {
      turnStartRef.current = null
      setElapsedMs(0)
      return
    }
    turnStartRef.current = Date.now()
    setElapsedMs(0)
    const id = setInterval(() => {
      if (turnStartRef.current !== null) {
        setElapsedMs(Date.now() - turnStartRef.current)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [generating, activeSessionId])

  // Live per-turn token estimate for the activity byline. Recomputed when the
  // transcript slice changes (streaming deltas) or the 1s elapsed tick fires,
  // so its cadence matches the elapsed clock without a second timer. Only while
  // a turn is running; the gauge is gated behind 30s in `ActivityIndicator`.
  const liveTokens = useMemo(
    () => (generating ? selectLiveTokenEstimate(nestedRows) : 0),
    [generating, nestedRows, elapsedMs],
  )

  // Stop → the real `app.abort` boundary. The requestId is a message envelope
  // (the sidecar aborts the current turn regardless — `sidecarServer.ts:642`),
  // so a fresh id is correct; no engine-minted turn id is needed.
  const stopTurn = (): void => {
    if (!activeSessionId) return
    try {
      getBridge().abort(activeSessionId, `abort-${Date.now()}`, 'user-stop')
      setStopError(null)
    } catch (error) {
      setStopError(errorMessage(error))
    }
  }

  // Instant jump to bottom when the pane binds to a session (prototype: no slow
  // crawl on open); live-turn content then follows the bottom while stuck.
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [activeSessionId])
  const contentSignature = `${activeLog.messages.length}:${partialCount}`
  // P4-24: context-window fullness for the composer donut. The prototype's
  // ContextChip is always on (`Surfaces.jsx:471-473`), so `selectContextUsage`
  // always returns — real result-frame usage once a turn provides it, a 0% gauge
  // before then (never hidden).
  //
  // The DENOMINATOR before that first turn is the run-controls snapshot's
  // engine-resolved window for the current model, so a fresh session already
  // reads this model's real window instead of a flat 200k. Depending on the
  // number rather than the snapshot object keeps the memo from re-running on
  // every unrelated re-broadcast.
  const runControlsContextWindow = runControls?.model.contextWindow ?? null
  const liveContextUsage = useMemo(
    () => selectContextUsage(activeLog.messages, model, runControlsContextWindow),
    [activeLog.messages, model, runControlsContextWindow],
  )
  /*
   * The rail under a PREVIEWED session reads the cache, not the engine.
   *
   * A preview has no sidecar, so `runControls` / `diagnostics` are absent and
   * every live value above is empty: the model face vanishes and the donut
   * reports 0% for a session that plainly used context. Both are answerable
   * from the session's own cached traffic (`previewRunFacts`), so the rail
   * shows what it really ran on. Where the cache is silent the value stays
   * null and the face renders nothing, which is the same rule the live rail
   * follows before its first snapshot lands.
   */
  const railModel = preview ? (previewRunFacts?.model ?? null) : model
  const railEffort = preview ? (previewRunFacts?.effort ?? null) : reasoningEffort
  const railPermissionMode = preview
    ? (previewRunFacts?.permissionMode ?? null)
    : null
  const contextUsage = preview
    ? (previewRunFacts?.contextUsage ?? null)
    : liveContextUsage
  // Dev-only raw-frame inspector (not a shipped surface, not in the Chat.jsx
  // design): hidden even in dev UNLESS a developer opts in via
  // `localStorage['catcode:devPanels'] = '1'`, so a normal dev run shows the
  // clean composer surface.
  const showRawEvents =
    import.meta.env.DEV &&
    (() => {
      try {
        return globalThis.localStorage?.getItem('catcode:devPanels') === '1'
      } catch {
        return false
      }
    })()
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el || !atBottom) return
    el.scrollTop = el.scrollHeight
  }, [contentSignature, atBottom])

  const onTranscriptScroll = (): void => {
    const el = transcriptScrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(gap < 120)
  }
  const jumpToBottom = (): void => {
    const el = transcriptScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }

  // A large paste collapses to a chip (App holds the full text aside and inserts
  // the `[Pasted text #N]` token); a small paste falls through to the browser's
  // default plain-text insert. P4-24: the token is spliced in at the caret (the
  // selection the paste replaced), not appended at the end.
  const handlePaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const text = event.clipboardData.getData('text')
    if (!text || !shouldCollapsePaste(text)) return
    event.preventDefault()
    pendingCaretRef.current = {
      base: event.currentTarget.selectionEnd,
      prevLength: prompt.length,
    }
    onPaste(text, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    // IME guard: a composition-commit Enter/arrow must never submit, recall, or
    // drive a picker — it belongs to the input method (parity `Chat.jsx:716`).
    if (isComposingRef.current || event.nativeEvent.isComposing) return
    // Feature #4 — keydowns bubbling from the composer action bar (a focused chip
    // face) are owned by that toolbar's own handler; never treat them as textarea
    // input here (Enter on a face must not submit, Backspace must not edit the
    // draft, ↑/↓ must not recall). This form handler is textarea-only.
    if (event.target !== composerRef.current) return
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
          {
            const picked = slashMatches[slashIndex]
            if (picked) pickSlashCommand(picked.name)
          }
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
    // No typeahead open — Escape interrupts an in-flight turn (the keybinding
    // for the Stop control; mirrors the TUI Ctrl+C/Esc cancel).
    if (event.key === 'Escape' && generating) {
      event.preventDefault()
      stopTurn()
      return
    }
    // Feature #4, keyboard ENTRY POINT #1 — Tab hands focus from the textarea to
    // the composer action bar's first chip face (the bar is the next focusable
    // region). Shift+Tab keeps native behavior (returns to the previous focusable).
    if (event.key === 'Tab' && !event.shiftKey) {
      if (focusFirstComposerFace(actionBarRef.current)) event.preventDefault()
      return
    }
    // Enter submits; Shift/Alt/Meta+Enter insert a newline (the multi-line
    // textarea does NOT submit a form on Enter the way the old `<input>` did, so
    // submit is driven explicitly via the form's own `requestSubmit`). Parity:
    // Shift+Enter and Alt/Meta+Enter → newline (`src/hooks/useTextInput.ts:257-264`).
    if (event.key === 'Enter') {
      if (event.shiftKey || event.altKey || event.metaKey) return // newline (default)
      event.preventDefault()
      event.currentTarget.requestSubmit()
      return
    }
    // Backspace immediately after a `[Pasted text #N]` token deletes the WHOLE
    // token in one keystroke — the atomic-pill delete a contentEditable would get
    // for free. A genuine 'edit' write, so the paste entry is pruned with it.
    if (event.key === 'Backspace') {
      const el = composerRef.current
      if (el && el.selectionStart === el.selectionEnd) {
        const range = pasteTokenBeforeCaret(prompt, el.selectionStart)
        if (range) {
          event.preventDefault()
          pendingCaretRef.current = {
            base: range.end,
            prevLength: prompt.length,
          }
          setPrompt(prompt.slice(0, range.start) + prompt.slice(range.end))
          return
        }
      }
    }
    // ↑/↓ walk the submitted-prompt history for this session — but only at the
    // vertical edge of the draft; elsewhere the arrow moves the caret between
    // lines (multi-line composer). `caretAtHistoryEdge` on a newline-free draft
    // is always true, so single-line recall is unchanged.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
      const caret = composerRef.current?.selectionStart ?? prompt.length
      if (!caretAtHistoryEdge(prompt, caret, direction)) return
      const result = navigateHistory(history, historyNav, direction, prompt)
      if (result) {
        event.preventDefault()
        setHistoryNav(result.nav)
        // history-nav: this draft swap must not prune the live paste held aside.
        setPrompt(result.value, 'history-nav')
        return
      }
      // Feature #4, keyboard ENTRY POINT #2 — ArrowDown on an EMPTY draft with
      // nothing newer to recall (navigateHistory returned null) hands focus to the
      // action bar, honoring the operator's "down arrow" request. A non-empty draft
      // keeps its caret/recall behavior (handled above), untouched.
      if (direction === 'down' && prompt.length === 0) {
        if (focusFirstComposerFace(actionBarRef.current)) event.preventDefault()
      }
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-8">
      {/* No chat header row: the prototype's ChatView has none (the session
       * title lives in the TabBar; the title + actions overflow menu is the
       * P4-6b `SessionActionsMenu`, a separate surface). The cwd/status debug
       * line and the "Copy for LLM" dev button are dropped — Copy-for-LLM stays
       * reachable via its keyboard shortcut. */}
      <ConnectionRecovery
        connection={activeConnection}
        sessionId={activeSessionId}
      />

      {/* P4-24 reflow: the transcript is the primary surface — it fills the
       * viewport as the sole `flex-1` scroller directly under the header, with
       * the composer and its satellites (activity, pastes, permissions) DOCKED
       * below it (Chat.jsx grammar: read above, type below). `<main>` stays
       * `overflow-hidden`, so this region's inner `overflow-auto` engages under
       * the flex-height chain; the scroll div tracks stick-to-bottom + drives
       * the jump-to-bottom control. */}
      <section className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={transcriptScrollRef}
          onScroll={onTranscriptScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          {previewTruncationMessage ? (
            <div
              className="mx-auto mb-3 w-full max-w-[740px] border-l-2 border-tone-warn px-3 py-2 text-xs text-tone-warn"
              role="status"
            >
              {previewTruncationMessage}
            </div>
          ) : null}
          <TranscriptView
            accounts={accountsSnapshot}
            activeSessionId={activeSessionId}
            cwd={activeDescriptor?.cwd ?? null}
            branch={branch}
            orchestratorActive={orchestratorActive}
            onToggleOrchestrator={onToggleOrchestrator}
            restorePhase={restorePhase}
            state={transcript}
          />
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={jumpToBottom}
            className={`absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] shadow-lg backdrop-blur ${
              generating
                ? paused
                  ? 'border-tone-warn/50 bg-shell-chrome/90 text-tone-warn'
                  : 'border-accent/50 bg-shell-chrome/90 text-accent'
                : 'border-shell-seam bg-shell-chrome/90 text-text-muted'
            }`}
          >
            {generating ? (
              <>
                <span
                  className={`h-1.5 w-1.5 animate-pulse rounded-full ${
                    paused ? 'bg-tone-warn' : 'bg-accent'
                  }`}
                  aria-hidden
                />
                <span className="font-semibold">
                  {paused ? 'Waiting for approval' : activity.verb}
                </span>
                <span className="font-mono tabular-nums text-text-subtle">
                  {fmtElapsed(elapsedMs)}
                </span>
                <span aria-hidden>↓</span>
              </>
            ) : (
              <span>↓ Latest</span>
            )}
          </button>
        ) : null}
      </section>

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

      {/* P4-24 fidelity: the composer dock is centered in the SAME max-740px
       * column as the transcript (Chat.jsx:1320 `maxWidth: MSG_MAX, margin: '0
       * auto'`) so the input aligns under the message column; a top seam
       * separates it from the scrolling transcript above. Inner blocks keep
       * their existing indent (wrapped without re-indentation). */}
      <div className="mx-auto flex w-full max-w-[740px] shrink-0 flex-col gap-4">
      {/* Docked above the composer, in Chat.jsx order — live permission-request
       * cards and any error/notice sit directly above the input, then the
       * in-turn activity row hugs the composer. */}
      {askQuestion ? (
        <AskQuestionFlow
          key={askQuestion.request.requestId}
          isActivePane={isActivePane}
          onAnswer={onAnswerQuestions}
          onCancel={onCancelQuestions}
          questions={askQuestion.questions}
          requestId={askQuestion.request.requestId}
          submitted={askQuestion.submitted}
        />
      ) : null}

      <PermissionQueue
        items={permissionQueue}
        onAllow={allowPermission}
        onDeny={denyPermission}
        onRestore={restorePermission}
      />

      {activeLog.error ? (
        <div className="text-sm text-tone-danger">{activeLog.error}</div>
      ) : null}

      {transportError ? (
        <div className="text-sm text-tone-danger">{transportError}</div>
      ) : null}

      {activeLog.truncated ? (
        <div className="text-sm text-tone-warn">
          Raw message history was truncated to the renderer retention budget.
        </div>
      ) : null}

      {/* CC-16 — the parked prompt is the only sign the message still exists:
       * the composer was cleared on submit, so without this row the text looks
       * lost until the session finishes connecting. */}
      {pendingSubmit ? (
        <div className="flex items-baseline gap-2 text-xs" role="status">
          <span className="shrink-0 font-medium text-text-muted">Queued</span>
          <span className="min-w-0 flex-1 truncate text-text-subtle">
            {pendingSubmit}
          </span>
          <span className="shrink-0 text-text-subtle">
            Sends when the session is ready.
          </span>
        </div>
      ) : null}

      {generating ? (
        <ActivityIndicator
          verb={activity.verb}
          target={activity.target}
          elapsedMs={elapsedMs}
          liveTokens={liveTokens}
          paused={paused}
          onStop={stopTurn}
          stopError={stopError}
        />
      ) : null}

      {/* P4-24: collapsed-paste PILLS, attached directly above the composer (the
       * `[Pasted text #N]` token lives inline in the textarea at the caret; the
       * textarea can't host styled DOM, so the pill re-skin sits here — §0 flag).
       * Each pill: label + count + × remove, with a hover/keyboard-focus full-text
       * preview popover (parity `Chat.jsx:1379`). Reuses the exact P4-0 paste
       * model — expand-on-submit is unchanged; this only re-skins the chip. */}
      {pastes.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Collapsed pastes">
          {pastes.map(entry => (
            <span
              key={entry.id}
              className="group relative inline-flex min-w-0 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent"
            >
              <span className="truncate font-mono text-[10.5px]">
                {formatPasteRef(entry.id, entry.numLines)}
              </span>
              <button
                type="button"
                aria-label="Remove paste"
                title="Remove"
                className="shrink-0 rounded text-text-subtle transition-colors hover:text-tone-danger"
                onClick={() => onRemovePaste(entry)}
              >
                ×
              </button>
              {/* Full-text preview: revealed on hover OR keyboard focus (the ×
               * button focusing drives `group-focus-within`). Always in the DOM
               * (hidden), exactly like the old <details><pre> body. */}
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-0 z-40 mb-1.5 hidden max-h-[40vh] w-[min(560px,80vw)] overflow-auto whitespace-pre-wrap rounded-md border border-shell-seam bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-text-subtle shadow-lg group-hover:block group-focus-within:block"
              >
                {entry.content}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {/* P4-24 composer, trued to Chat.jsx:1318's "minimal, borderless" input:
       * a transparent auto-resizing textarea (no box), a pink up-arrow SEND icon
       * (not a "Send" button), a focus-rule underline that lights on focus, and
       * an icon-only actions row (attach + the context donut). All handlers are
       * unchanged — this is a visual re-skin only. */}
      <form
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-label="Composer"
        className="flex flex-col"
        onKeyDown={onComposerKeyDown}
        onSubmit={event => {
          // CC-16 — a submit is intent too. Focus/pointer-down normally fired
          // the spawn already (`claimLazyRestore` makes a repeat a no-op), but
          // a send-arrow click on a pre-filled draft never touched the
          // textarea; without this the parked prompt would wait on a spawn
          // nobody started.
          engagePreviewPane()
          submit(event)
        }}
      >
        <div className="peer relative flex items-end gap-[14px] px-1 pb-[11px]">
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
            {/* Multi-line, auto-resizing, BORDERLESS (Chat.jsx:1407): transparent,
             * 16px light text, accent caret. Enter submits, Shift/Alt/Meta+Enter
             * insert a newline; grows to ~38vh then scrolls (auto-resize effect).
             * `max-h-[38vh]` is a STATIC arbitrary class so Tailwind emits it. */}
            <textarea
              ref={composerRef}
              aria-label="Prompt"
              rows={1}
              className="max-h-[38vh] w-full resize-none overflow-hidden border-none bg-transparent py-1.5 text-base font-light leading-normal text-text-primary caret-accent outline-none placeholder:text-[#52525b] placeholder:font-light"
              disabled={!activeSessionId}
              readOnly={!composerGate.editable}
              onFocus={engagePreviewPane}
              onPointerDown={engagePreviewPane}
              onChange={event => {
                // A genuine keystroke abandons any active ↑/↓ recall cursor
                // (parity with the prototype resetting historyIdx on input) and
                // prunes pastes whose token was actually deleted (reason 'edit').
                // A real keystroke also abandons any caret a programmatic
                // rewrite was about to restore: the browser already placed it.
                pendingCaretRef.current = null
                setHistoryNav(EMPTY_HISTORY_NAV)
                setPrompt(event.target.value)
              }}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              onPaste={handlePaste}
              placeholder={composerPlaceholder}
              value={prompt}
            />
          </div>
          {/* Pink up-arrow SEND (Chat.jsx:1419) — icon, not a labelled button;
           * quiet when the draft is empty. Stop lives in the activity row. */}
          <button
            aria-label="Send prompt"
            title="Send"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center self-end rounded-lg text-accent transition-colors disabled:text-[#3f3f46]"
            disabled={
              !composerGate.editable ||
              prompt.trim().length === 0 ||
              pendingSubmit !== null
            }
            type="submit"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>

        {/* Focus rule (Chat.jsx:1428): a hairline that lights to an accent
         * gradient while the input has focus. */}
        <div
          aria-hidden
          className="h-0.5 rounded-sm bg-white/[0.08] transition-colors peer-focus-within:bg-gradient-to-r peer-focus-within:from-accent peer-focus-within:to-accent/[0.12]"
        />

        {/* Actions row (Chat.jsx:1454 / Surfaces.jsx:745 `ChipStrip`): attach ·
         * model override · permission MODE · —— · active account · context donut.
         * Real data only — see `ComposerActionsBar` for the per-chip backing. */}
        <ComposerActionsBar
          attachDisabled={!composerGate.editable}
          onAttach={() =>
            toast('Paste a large block to attach it as a collapsed chip.', {
              tone: 'info',
            })
          }
          model={railModel}
          reasoningEffort={railEffort}
          permissionModeReadOnly={railPermissionMode}
          fastMode={fastMode}
          runControls={runControls}
          onSetModel={onSetModel}
          onSetEffort={onSetEffort}
          onSetFast={onSetFast}
          permissionContext={permissionContext}
          onSetMode={setPermissionMode}
          account={activeAccount}
          anthropicAccount={activeAnthropicAccount}
          accounts={accountsSnapshot?.accounts ?? []}
          onSwitchAccount={handleSwitchAccount}
          onManageAccounts={onManageAccounts}
          contextUsage={contextUsage}
          toolbarRef={actionBarRef}
          onFocusComposer={() => composerRef.current?.focus()}
        />

        {/* TEMPORARY debug line (2026-07-28, operator request). DELETE ME.
         *
         * It prints session ids, which §7 forbids on a real text surface, so it
         * is dev-gated and Vite drops it from a production build. On a
         * preview it also names which run facts the rail actually RECEIVED,
         * which is the one signal that separates "the cache never got the
         * facts" from "the rail got them and did not render" — the ambiguity
         * that made this bug expensive to find. Delete once the rail settles. */}
        {import.meta.env.DEV ? (
          <div className="mt-2 select-all rounded-[4px] bg-white/[0.04] px-2 py-1 font-mono text-[11px] leading-tight text-[#a1a1aa]">
            app {activeSessionId ?? 'none'} · engine{' '}
            {activeDescriptor?.engineSessionId ?? 'none'}
            {preview
              ? ` · facts ${
                  [
                    previewRunFacts?.model ? 'model' : null,
                    previewRunFacts?.permissionMode ? 'mode' : null,
                    previewRunFacts?.effort ? 'effort' : null,
                    previewRunFacts?.contextUsage ? 'ctx' : null,
                  ]
                    .filter(Boolean)
                    .join(',') || 'none'
                }`
              : ''}
          </div>
        ) : null}
      </form>
      </div>

      {/* Raw-SDKMessage inspector — a developer tool, NOT part of the Chat.jsx
       * design. Hidden by default even in dev (see `showRawEvents`); opt in with
       * `localStorage['catcode:devPanels'] = '1'`. Vite DCE's it from prod. */}
      {showRawEvents ? (
        <section className="flex shrink-0 flex-col">
          <details
            className="max-h-64 overflow-auto"
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
      ) : null}
    </main>
  )
}

/** Parity with the engine's `SHOW_TOKENS_AFTER_MS` (`SpinnerAnimationRow.tsx:19`):
 * the estimated token byline is gated behind 30s of turn time so quick turns
 * stay quiet — it appears only on genuinely long turns, exactly as the TUI. */
const SHOW_TOKENS_AFTER_MS = 30_000

/**
 * P4-18c activity indicator (`Chat.jsx` SpinnerWithVerb): pulse dots + verb +
 * active target + elapsed clock + optional per-turn token byline + a Stop
 * control wired to the real `app.abort`. Paused (a pending permission request)
 * tints amber and reads "Waiting for approval". The token byline is the
 * renderer-side `displayedResponseLength / 4` estimate (`selectLiveTokenEstimate`),
 * gated on `elapsed > 30s && tokens > 0` like the engine — an estimate, never a
 * mocked exact count.
 */
function ActivityIndicator({
  verb,
  target,
  elapsedMs,
  liveTokens,
  paused,
  onStop,
  stopError,
}: {
  verb: string
  target: string | null
  elapsedMs: number
  liveTokens: number
  paused: boolean
  onStop: () => void
  stopError: string | null
}) {
  const tone = paused ? 'text-tone-warn' : 'text-accent'
  const dot = paused ? 'bg-tone-warn' : 'bg-accent'
  const showTokens = liveTokens > 0 && elapsedMs > SHOW_TOKENS_AFTER_MS
  return (
    <div className="flex items-center gap-2.5 border-b border-shell-seam px-1 py-1.5 text-xs">
      <span className="flex items-center gap-1" aria-hidden>
        <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot}`} />
        <span
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot} [animation-delay:150ms]`}
        />
        <span
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot} [animation-delay:300ms]`}
        />
      </span>
      <span className={`font-semibold ${tone}`}>
        {paused ? 'Waiting for approval' : verb}
      </span>
      {target ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-subtle">
          {target}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
        {fmtElapsed(elapsedMs)}
        {showTokens ? (
          <span
            title="Output tokens this turn (estimate); arrow shows phase, not direction"
          >
            {' · ↓ '}
            {fmtTok(liveTokens)} tokens
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-keyshortcuts="Escape"
        title="Stop the turn (Esc)"
        className="shrink-0 rounded border border-tone-danger/40 px-2 py-0.5 text-[11px] font-semibold text-tone-danger transition-colors hover:bg-tone-danger/10"
      >
        ■ Stop
      </button>
      {stopError ? (
        <span className="shrink-0 text-[11px] text-tone-danger">{stopError}</span>
      ) : null}
    </div>
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
  // Only a TERMINAL connection earns a failure bar and a Restart invitation. A
  // still-spawning session (`connecting`/`starting`) has not failed, so the
  // shared partition decides this rather than a local status list.
  if (!sessionId || !isTerminalConnectionStatus(connection.status)) {
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

/** Stable empty inventory for the closed palette — a fresh `[]` each render would
 * bust the palette's `useMemo(filter)` identity check for no reason. */
const EMPTY_PALETTE_ITEMS: PaletteItem[] = []

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
  | { type: 'preview-open'; sessionId: SessionId }
  | { type: 'preview-close'; sessionId: SessionId }

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
  if (action.type === 'event') return reduceShellState(state, action.event)
  return reduceShellState(state, action)
}

type SessionPaneProps = {
  /** In-session empty-state Welcome context: this session's real Codex pool
   * snapshot (P4-5), read-only (HC1). Null before any pool frame lands. */
  accountsSnapshot: AccountsSnapshot | null
  /** This session's active pool account (real alias), or null before its snapshot. */
  activeAccount: AccountStatus | null
  /** Active Anthropic subscription account when this session routes Anthropic. */
  activeAnthropicAccount?: AnthropicAccountStatus | null
  /** Dispatch a minted `account.switch` verb (its requestId already assigned by
   * SessionPane, ACCT-5) to this session's sidecar. Absent → the account face
   * stays read-only. */
  onSwitchAccount?: (verb: AccountSwitchMessage) => void
  /** Open the Accounts page (the profile popover's "Manage accounts →"). */
  onManageAccounts?: () => void
  /** Global most-recent `account.result` (ACCT-5) — SessionPane correlates it by
   * requestId + sessionId against its own in-flight composer switch and toasts
   * the real outcome; no optimistic UI, mirrors AccountsPage's `pendingRef`. */
  accountsLastResult: AccountResultFrame | null
  activeConnection: ConnectionSnapshot
  activeDescriptor: SessionDescriptor | undefined
  activeLog: RawMessageSessionLog
  /** Read-only git branch for the empty-state meta strip (session log `gitBranch`). */
  branch: string | null
  activeSessionId: SessionId | null
  /** This pane is the operator's focused one — gates window-level keyboard ownership in a split. */
  isActivePane: boolean
  /** Cache-backed transcript is currently painted; operational stores stay live-only. */
  preview?: boolean
  /** Visible-lossiness boundary retained beside a truncation-only cache. */
  previewTruncationMessage?: string | null
  /** First focus, pointer-down, or pane dwell lazily restores the real session. */
  onPreviewEngage?: () => void
  /** What the cached transcript says this session ran on; feeds the rail while
   * no engine exists to report it live. */
  previewRunFacts?: PreviewRunFacts | null
  allowPermission: (requestId: string, applySuggestions?: number[]) => void
  /** The RESOLVED model this session runs (`mainLoopModelForSession`); null before the snapshot. */
  model: string | null
  /** The session's reasoning-effort tier, or null when running at the provider default. */
  reasoningEffort: string | null
  /** The fast-mode toggle; the ⚡ face renders when on OR togglable (P4-24c interactive). */
  fastMode: boolean
  /** P4-24c — the live run-controls snapshot (current + real picker options + availability). */
  runControls?: RunControlsSnapshot | null
  /** The session's rich slash-command catalog (name + description + arg hint) for
   * the composer picker; empty/absent falls the picker back to the names-only list. */
  slashCatalog?: readonly SlashCatalogEntry[]
  /** P4-24c — set this session's model (a value from `runControls.model.options`). */
  onSetModel?: (model: string | null) => void
  /** P4-24c — set this session's reasoning-effort tier (a level, or `auto` to clear). */
  onSetEffort?: (effort: string) => void
  /** P4-24c — toggle this session's fast mode on/off. */
  onSetFast?: (active: boolean) => void
  copyForLlm: () => void
  denyPermission: (requestId: string, message?: string) => void
  /** This session's agent-mode active flag, shown in the empty Welcome. */
  orchestratorActive: boolean
  /** P4-8b — toggle THIS session's agent mode from the empty-state Orchestrator
   * switch (renderer authors the boolean intent → the `agent-mode.set` verb).
   * Optional: when absent the empty-state toggle degrades to a read-only reflect. */
  onToggleOrchestrator?: (next: boolean) => void
  partialCount: number
  permissionContext: ReturnType<typeof selectPermissionContext>
  permissionQueue: ReturnType<typeof selectPermissionQueue>
  /** P4-11 — the pending ExitPlanMode review, or `null`; drives PlanBar/PlanPanel. */
  planReview: PlanReview | null
  /** Composes `setPermissionMode` + a C1 allow on the plan-review request. */
  onApprovePlan: (mode: PlanApprovalMode) => void
  /** Denies the plan-review request with feedback (real "keep planning"). */
  onRevisePlan: (message: string) => void
  /** P4-20 — the pending AskUserQuestion request, or `null`; drives AskQuestionFlow. */
  askQuestion: AskQuestionReview | null
  /** Sends the answer via the `answerQuestions` verb (index selection + freeform). */
  onAnswerQuestions: (answers: AskUserQuestionAnswer[]) => void
  /** Declines the AskUserQuestion request (reuses the permission deny path). */
  onCancelQuestions: () => void
  prompt: string
  restorePermission: (requestId: string) => void
  setPermissionMode: (mode: PermissionSetModeMode) => void
  setPrompt: (value: string, reason?: DraftWriteReason) => void
  submit: (event: FormEvent<HTMLFormElement>) => void
  /** Real @-mention sources for this session (agents; files need a read-seam). */
  mentionItems: MentionItem[]
  /** Collapsed pastes held aside for this session, oldest first. */
  pastes: PasteEntry[]
  /** CC-16 — a prompt submitted before the engine could accept it, held until it
   * can. Present = the composer is empty because the text is queued, not lost. */
  pendingSubmit?: string | null
  /** Prior submitted prompts for ↑/↓ recall (per session, newest last). */
  history: string[]
  /** Store a large paste as a collapsed chip and splice its token in at the
   * composer caret (`selectionStart`/`selectionEnd`); absent selection appends. */
  onPaste: (
    content: string,
    selectionStart?: number,
    selectionEnd?: number,
  ) => void
  /** Remove a collapsed paste (strip its token + drop the stored content). */
  onRemovePaste: (entry: PasteEntry) => void
  transcript: TranscriptState
  transportError: string | null
}
