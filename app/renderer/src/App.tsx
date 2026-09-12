import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { getBridge } from './bridge.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'
import { PermissionQueue } from './PermissionQueue.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectPendingPermissionCount,
  selectPermissionContext,
  selectPermissionQueue,
  selectVisiblePermission,
} from './permissionState.js'
import {
  selectNonPlanPermissionQueue,
  selectPlanReview,
} from './planState.js'
import {
  selectAskQuestion,
  selectGenericPermissionQueue,
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
import {
  attemptRosterBootstrap,
  createRosterBootstrapState,
  mergeRosterSnapshot,
  reduceRosterBootstrapState,
} from './rosterBootstrap.js'
import { deriveTabVisualState } from './tabStatus.js'
import { sessionStatusVisual } from './sessionStatusVisual.js'
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
} from './rawMessageLog.js'
import {
  createTranscriptState,
  selectHasHiddenRows,
  selectTranscriptRows,
} from './transcriptProjector.js'
import {
  applyPreviewHandover,
  claimLazyRestore,
  createPreviewTranscriptState,
  hasPreviewTranscript,
  openPreloadedPreview,
  previewClosePlan,
  reduceLiveTranscriptState,
  reducePreviewTranscriptState,
  selectPaneTranscript,
} from './previewTranscriptState.js'
import {
  STARTUP_PRELOAD_MAX_SESSIONS,
  calculateStartupPreloadCapacity,
  estimateProjectedPreviewBytes,
  runStartupTranscriptPreload,
  selectStartupPreloadCandidates,
} from './sessionPreload.js'
import {
  type MessageActionHandler,
} from './TranscriptView.js'
import {
  createTranscriptScrollMemoryState,
  reduceTranscriptScrollMemoryState,
  selectTranscriptScrollAnchor,
  type TranscriptScrollAnchor,
  type TranscriptScrollMemoryState,
} from './transcriptScrollMemory.js'
import {
  createHistoryLoadEarlierState,
  reduceHistoryLoadEarlierState,
  selectHistoryLoadEarlierFailure,
  selectHistoryLoadEarlierPending,
  type HistoryLoadEarlierState,
} from './historyLoadEarlierState.js'
import {
  parseSlashDraft,
} from './slashCommandPickerModel.js'
import {
  buildSubmitPrompt,
  createFileAttachmentState,
  createHistoryState,
  createImageAttachmentState,
  createPasteState,
  createPendingSubmitState,
  createRetainedSubmitState,
  createTransportErrorState,
  foldRecalledPrompts,
  formatPasteRef,
  PENDING_SUBMIT_RELEASED_MESSAGE,
  planSessionSubmit,
  reduceHistoryPushed,
  reduceFileAttachmentRemoved,
  reduceFileAttachmentSelected,
  reduceImageAttachmentAdded,
  reduceImageAttachmentRemoved,
  reducePasteAdded,
  reducePasteStateForDraftWrite,
  reducePendingSubmitCleared,
  reducePendingSubmitHeld,
  reduceRetainedSubmitCleared,
  reduceRetainedSubmitHeld,
  reduceSubmitAnswers,
  reduceSessionImagesReplaced,
  reduceSessionImagesRestored,
  reduceSessionFileAttachmentRestored,
  reduceSessionPastesCleared,
  removePasteOccurrence,
  reduceTransportErrorCleared,
  reduceTransportErrorSet,
  resolvePendingSubmit,
  restoreSelectedPrompt,
  applyRefusedSubmitRestoration,
  restoreDraftWithPending,
  selectAgentMentionItems,
  selectFileAttachment,
  selectHistory,
  selectImageAttachments,
  selectPendingSubmit,
  selectSessionPasteList,
  selectSessionPasteState,
  selectTransportError,
  type DraftWriteReason,
  type FileAttachmentState,
  type HistoryState,
  type ImageAttachmentState,
  type PasteEntry,
  type PasteState,
  type PendingSubmitState,
  type RetainedSubmit,
  type RetainedSubmitState,
  type TransportErrorState,
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
  connectionHasEngine,
  createConnectionState,
  isTerminalConnectionStatus,
  reduceConnectionState,
  selectConnection,
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
  selectThreadGoalRows,
  selectThreadGoalSnapshot,
} from './goalMemoryState.js'
import { selectComposerRail } from './composerRailModel.js'
import {
  createAccountsState,
  reduceAccountsState,
  selectAccountsSnapshot,
  selectActiveAccount,
  selectActiveAnthropicAccount,
  selectGlobalAccountsSnapshot,
  selectOAuthProgress,
  selectUsageStatsForRange,
} from './accountsState.js'
import { selectAccountHealthBanner } from './accountHealthBanner.js'
import { BannerStack, type BannerNotice } from './BannerStack.js'
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
  createContextBreakdownState,
  reduceContextBreakdownState,
  selectContextBreakdown,
} from './contextBreakdownState.js'
import {
  createSlashCatalogState,
  reduceSlashCatalogState,
  selectSlashCatalog,
} from './slashCatalogState.js'
import {
  createQueuedPromptsState,
  reduceQueuedPromptsState,
  selectQueuedPrompts,
} from './queuedPromptsState.js'
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
  filterInteractiveSessionDescriptors,
  reduceSessionsCatalogState,
  resolveRecentOpenRoute,
  resolveSessionOpenRoute,
  selectMergedSessionRows,
  selectRecentWorkspaces,
  selectRowEngineSessionId,
  selectSessionsCatalog,
  withResolvedTitle,
  type MergedSessionRow,
  type RecentWorkspace,
  type SessionOpenRoute,
} from './sessionsCatalogState.js'
import { WelcomeScreen } from './WelcomeScreen.js'
import { TasksDialog } from './TasksDialog.js'
import {
  createWorkersState,
  workersPill,
  reduceWorkersState,
  selectLiveWorkersSnapshot,
  summarizeWorkers,
} from './workersState.js'
import {
  AgentFaceRegistryContext,
  AgentFaceRegistryStoreContext,
  useAgentFaceRegistryStore,
} from './agentFace.js'
import {
  createLeaseState,
  reduceLeaseState,
  selectLastMainFailoverAccountId,
  selectLeaseSnapshot,
  selectSessionCodexAccount,
} from './leaseState.js'
import { WorkerRoster } from './WorkerRoster.js'
import { GoalsPage } from './GoalsPage.js'
import { AccountsPage } from './AccountsPage.js'
import {
  loginVerb,
  oauthAliasVerb,
  oauthCancelVerb,
  oauthPasteCodeVerb,
  selectAccountsNeedingSignIn,
} from './accountsPageModel.js'
import {
  StartupOAuth,
  WorkspaceTrustGate,
  type StartupOAuthView,
} from './StartupSurfaces.js'
import { SessionsPage } from './SessionsPage.js'
import { isWritableSessionRow } from './sessionsPageState.js'
import { MetadataInspector } from './MetadataInspector.js'
import { buildSessionInspectorState } from './sessionInspectorState.js'
import { buildSessionMetadataView } from './messageMetadata.js'
import {
  SessionActionsMenu,
  SessionRenamePopover,
  type SessionActionsAnchor,
} from './SessionActionsMenu.js'
import {
  resolveSessionActions,
  selectSessionsPageActions,
} from './sessionActions.js'
import { ExportDialog } from './SessionActionDialogs.js'
import {
  buildBulkExportDocument,
  bulkExportSavedMessage,
  describeSaveOutcome,
  exportFileName,
  selectBulkExportOutcome,
  selectExportPreview,
  selectLatchedExportPreview,
  type BulkExportRequest,
  type LatchedExportPreview,
} from './sessionActionDialogState.js'
import {
  createSessionActionRuntimeState,
  reduceSessionActionRuntimeState,
  selectLatestSessionActionError,
  selectLatestSessionActionResult,
} from './sessionActionRuntimeState.js'
import {
  classifyRecallAnswer,
  createRecallRequests,
  createVerbAckResultState,
  forgetRecallRequests,
  recallDeliveryFailureNotice,
  reduceVerbAckResultState,
  releaseRecallRequest,
  selectLatestVerbAckResult,
  takeRecallErrorRequest,
  trackRecallRequest,
  verbAckErrorToast,
} from './verbAckResultState.js'
import type { RecallRequests } from './verbAckResultState.js'
import { SettingsShell } from './SettingsShell.js'
import { selectSettingsProjectBinding } from './settingsProjectBinding.js'
import type { SettingWriteInput } from './SettingsEditors.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import type {
  AccountVerbMessage,
  LiveWorkerItem,
  PermissionResponseInput,
  RecalledPrompt,
  RemoteVerbMessage,
  SessionActionVerbMessage,
  SessionId,
  UsageStatsRange,
} from '../../shared/protocol.js'
import type {
  HostEvent,
  SessionDescriptor,
} from '../../shared/hostApi.js'
import {
  buildDebugExport,
  claimOAuthContextForAccountLogin,
  hostErrorMessage,
  reducePromptDrafts,
  reduceTurnStarts,
  selectPromptDraft,
  sendPermissionResponse,
  shouldShowAnthropicPoolAccount,
  shouldShowFirstRunOAuth,
  type OAuthContext,
  type PromptDraftState,
} from './appModel.js'
import {
  PROMPT_DRAFT_WRITE_DEBOUNCE_MS,
  readPromptDraftsFromStorage,
  writePromptDraftsToStorage,
} from './promptDraftPersistence.js'
import { SessionPane } from './SessionPane.js'
import { errorMessage } from './appModel.js'

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
const reduceWorkersStateBatched = withBatch(reduceWorkersState)
const reduceLeaseStateBatched = withBatch(reduceLeaseState)
const reduceAccountsStateBatched = withBatch(reduceAccountsState)
const reduceWorkspaceTrustStateBatched = withBatch(reduceWorkspaceTrustState)
const reduceDiagnosticsStateBatched = withBatch(reduceDiagnosticsState)
const reduceRunControlsStateBatched = withBatch(reduceRunControlsState)
const reduceContextBreakdownStateBatched = withBatch(reduceContextBreakdownState)
const reduceSlashCatalogStateBatched = withBatch(reduceSlashCatalogState)
const reduceQueuedPromptsStateBatched = withBatch(reduceQueuedPromptsState)
/** Stable empty notice list so a healthy pool re-renders nothing (P4-50). */
const EMPTY_BANNERS: readonly BannerNotice[] = []
/** Stable identity so a session with no worker snapshot never re-renders. */
const EMPTY_WORKERS: readonly LiveWorkerItem[] = []
  /** Stable identity for the pre-first-turn map, so the initial state is one object. */
const EMPTY_TURN_STARTS: ReadonlyMap<SessionId, number> = new Map()

/** Renderer-minted correlation id for a run-control verb (T5a-analog; echoed on
 * `run-control.result`). A UX field, not a security one — the sidecar bounds it. */
const newRequestId = (): string => crypto.randomUUID()
const TOASTED_ACTION_REQUEST_CAP = 512
function rememberToastedActionRequest(seen: Set<string>, requestId: string): void {
  seen.add(requestId)
  while (seen.size > TOASTED_ACTION_REQUEST_CAP) {
    const oldest = seen.values().next().value
    if (oldest === undefined) return
    seen.delete(oldest)
  }
}
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

/** The renderer's own storage, or null where it does not exist or throws on
 * access (SSR, a locked-down window). The `Sidebar.tsx` `defaultOrderStorage`
 * idiom. */
function defaultPromptDraftStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function App() {
  const pendingDeliveryStateAcksRef = useRef<Array<{ sessionId: SessionId; sequence: number; deliveryAttempt: number; streamEpoch: string; traceId: string }>>([])
  const pendingDeliveryCommitAcksRef = useRef<Array<{ sessionId: SessionId; sequence: number; deliveryAttempt: number; streamEpoch: string; traceId: string }>>([])
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
  // CC-84 — unsent composer text survives a reload. The draft is the only state
  // in the window the engine has never seen and cannot replay, and the app's own
  // crash recovery reloads the document (`app/main/main.ts` `render-process-gone`),
  // so the healing path used to destroy it. Renderer-local, best-effort
  // (`promptDraftPersistence.ts`).
  const [promptDrafts, setPromptDrafts] = useState<PromptDraftState>(
    () => readPromptDraftsFromStorage(defaultPromptDraftStorage()) ?? {},
  )
  const promptDraftsRef = useRef(promptDrafts)
  promptDraftsRef.current = promptDrafts
  const updatePromptDrafts = useCallback(
    (update: (current: PromptDraftState) => PromptDraftState): void => {
      const next = update(promptDraftsRef.current)
      promptDraftsRef.current = next
      setPromptDrafts(next)
    },
    [],
  )
  // Typing rewrites the draft on every keystroke and `setItem` is synchronous on
  // this thread, so the write is debounced rather than run per character.
  useEffect(() => {
    const storage = defaultPromptDraftStorage()
    if (!storage) return
    const timer = setTimeout(() => {
      writePromptDraftsToStorage(storage, promptDrafts)
    }, PROMPT_DRAFT_WRITE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [promptDrafts])
  // A reload or a quit can land inside the debounce window, which is exactly the
  // moment the draft matters most. `pagehide` fires on both and still allows a
  // synchronous write, so the pending one is flushed there.
  useEffect(() => {
    const storage = defaultPromptDraftStorage()
    if (!storage || typeof window === 'undefined') return
    const flush = () => writePromptDraftsToStorage(storage, promptDraftsRef.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])
  // P4-0 composer state, per-session-keyed exactly like `promptDrafts` so a
  // background session's collapsed pastes and input history survive a focus
  // switch (SessionPane unmounts for off-screen sessions). Renderer-local; never
  // crosses the wire.
  const [pasteState, setPasteState] = useState<PasteState>(createPasteState)
  const [imageAttachmentState, setImageAttachmentState] =
    useState<ImageAttachmentState>(createImageAttachmentState)
  const [fileAttachmentState, setFileAttachmentState] =
    useState<FileAttachmentState>(createFileAttachmentState)
  const [composerFocusRequests, setComposerFocusRequests] = useState<
    Partial<Record<SessionId, number>>
  >({})
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
  // D5 — a submit the sidecar refuses (the mid-turn depth cap is the reachable
  // case) used to leave the composer empty and the images gone: `↑` history is
  // text-only, so the attachments had no recovery path at all. The submitted
  // message is retained HERE across the optimistic clear, keyed by the
  // correlation id that went out with it, and handed back when its OWN answer
  // says it was refused (`reduceSubmitAnswers`). A ref, not state: nothing
  // renders it, and the frame subscription below is mounted once with no deps,
  // so a state value read inside it would always be the first one.
  const retainedSubmitsRef = useRef<RetainedSubmitState>(
    createRetainedSubmitState(),
  )
  const refusedSubmitPrefixesRef = useRef(
    new Map<SessionId, import('./composerState.js').RefusedDraftRestoreState>(),
  )
  // D1b — recall requests this page is waiting on or has answered, each against
  // the session it was asked for. A ref for the same reason as the one above, and
  // the reason it exists at all is the replay ring: a `prompt-recall.result` is
  // request-scoped, so only the page that asked may act on it. It keeps ANSWERED
  // ids for one more frame because a recall can correct its own answer
  // (`classifyRecallAnswer`). The session is what lets a request be released when
  // the row it belongs to goes away (`forgetRecallRequests`).
  const recallRequestsRef = useRef<RecallRequests>(createRecallRequests())
  // Bug fix — per-session (was one app-wide string shown on every pane
  // regardless of which session actually failed; `selectTransportError`
  // resolves it for the pane it belongs to).
  const [transportErrors, setTransportErrors] = useState<TransportErrorState>(
    createTransportErrorState,
  )
  const [shellError, setShellError] = useState<string | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  const newChatInFlightRef = useRef(false)
  // The window's face registries, one per SESSION, mounted at the shell so every
  // surface that draws a worker shares one. The transcript, the docked roster,
  // the Workers list and a relayed permission card can all show the same worker
  // at the same moment; separate registries would dedupe separately and put that
  // worker on screen twice wearing two different faces.
  //
  // Per session and not per ACTIVE session, because split view renders up to
  // MAX_WORKSPACE_PANELS panes at once on different sessions. One registry for
  // all of them spent the ten identity colours across unrelated transcripts, and
  // focusing a pane re-minted it under panes that never unmounted, re-rolling
  // faces on rows that were already settled. `SessionPane` therefore re-provides
  // its OWN session's registry to its subtree; what stays on the active session
  // here is the shell's own furniture (the Workers list, the ⌘K palette).
  const faceRegistries = useAgentFaceRegistryStore()
  const faceRegistry = faceRegistries.registryFor(activeSessionId)
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
  // P4-36 — transcript mode, PER SESSION: which sessions currently reveal their
  // hidden tier. Per-session rather than one global flag because tabs persist
  // here, so switching away and back must not silently re-hide what you asked to
  // see (the prototype's single chat view resets on switch, `Chat.jsx:339`,
  // because it has nowhere else to keep it). A view preference only: the rows
  // are already in projector state either way.
  const [revealHiddenSessions, setRevealHiddenSessions] = useState<
    Record<SessionId, true>
  >({})
  // P4-30 — Export is dispatched WHEN the dialog opens,
  // because the dialog's whole job is to show the transcript the sidecar renders.
  // The dialog holds the `requestId` it minted so it displays its OWN result and
  // never another action's (T5a-analog).
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
  const pendingMessageActionsRef = useRef<
    Map<
      SessionId,
      {
        requestId: string
        action: 'edit' | 'branch'
        awaitingReconnect: boolean
      }
    >
  >(new Map())
  const [rosterBootstrap, dispatchRosterBootstrap] = useReducer(
    reduceRosterBootstrapState,
    undefined,
    createRosterBootstrapState,
  )
  const hostSnapshotReady = rosterBootstrap.status === 'ready'
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
  // Acknowledge UI commitment only after React has committed a render caused by
  // the reducer batch. Dispatch return alone intentionally never satisfies it.
  useEffect(() => {
    getBridge().recordRenderCommit()
    const applied = pendingDeliveryStateAcksRef.current.splice(0)
    for (const entry of applied) {
      getBridge().deliveryAck(entry.sessionId, entry.sequence, entry.deliveryAttempt, entry.streamEpoch, entry.traceId, 'renderer.state.applied')
    }
    const pending = pendingDeliveryCommitAcksRef.current.splice(0)
    for (const entry of pending) {
      // A terminal UI acknowledgement is stronger than a generic React commit:
      // the *active, rendered* session must expose the terminal connection
      // projection produced by its reducer. Background tabs intentionally retain
      // only `renderer.state.applied` evidence instead of claiming visible UI.
      const projected = connection.sessions[entry.sessionId]
      if (activeSessionId !== entry.sessionId || !projected || !isTerminalConnectionStatus(projected.status)) continue
      getBridge().deliveryAck(entry.sessionId, entry.sequence, entry.deliveryAttempt, entry.streamEpoch, entry.traceId, 'renderer.ui.committed')
    }
  })
  // When each session's turn started, held above the panes because a pane only
  // exists while its session is on screen (`reduceTurnStarts`). The panes read
  // their own start from here to tick the activity clock.
  const [turnStarts, setTurnStarts] = useState<ReadonlyMap<SessionId, number>>(
    EMPTY_TURN_STARTS,
  )
  useEffect(() => {
    setTurnStarts(prev => reduceTurnStarts(prev, connection, Date.now()))
  }, [connection])
  // Where the reader is in each session's transcript, held above the panes for
  // the same reason `turnStarts` is: a pane is unmounted while its session is
  // off screen, so it cannot remember its own place across a tab switch. A ref
  // rather than state — the pane reports on every scroll event and nothing
  // renders from this, so storing it in state would re-render the window at
  // scroll rate.
  const transcriptScrollMemoryRef = useRef<TranscriptScrollMemoryState>(
    createTranscriptScrollMemoryState(),
  )
  const rememberTranscriptScroll = useCallback(
    (sessionId: SessionId, anchor: TranscriptScrollAnchor): void => {
      transcriptScrollMemoryRef.current = reduceTranscriptScrollMemoryState(
        transcriptScrollMemoryRef.current,
        { type: 'remember', sessionId, anchor },
      )
    },
    [],
  )
  // Which sessions are waiting on a read further back, and what the last one
  // that failed said. State, not a ref: the control on the boundary row renders
  // from it. Held here rather than in the pane for the reason above — a pane is
  // unmounted while its session is off screen, and a read outlives that.
  const [historyLoadEarlier, setHistoryLoadEarlier] =
    useState<HistoryLoadEarlierState>(createHistoryLoadEarlierState)
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
  const [contextBreakdown, dispatchContextBreakdown] = useReducer(
    reduceContextBreakdownStateBatched,
    undefined,
    createContextBreakdownState,
  )
  const [slashCatalog, dispatchSlashCatalog] = useReducer(
    reduceSlashCatalogStateBatched,
    undefined,
    createSlashCatalogState,
  )
  // D1a — what each session has waiting for its running response. Rendered at
  // the end of the transcript document but never a transcript ROW: until the
  // engine takes one of these the model has not seen it, so it stays out of
  // `transcriptProjector` and out of history.
  const [queuedPrompts, dispatchQueuedPrompts] = useReducer(
    reduceQueuedPromptsStateBatched,
    undefined,
    createQueuedPromptsState,
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
  const [workersState, dispatchWorkers] = useReducer(
    reduceWorkersStateBatched,
    undefined,
    createWorkersState,
  )
  // P4-32b — the read-only Codex lease seam (L1). Session-scoped: which account
  // each agent in this session's swarm is leasing right now.
  const [leases, dispatchLease] = useReducer(
    reduceLeaseStateBatched,
    undefined,
    createLeaseState,
  )
  const [tasksOpen, setTasksOpen] = useState(false)
  // CC-84 — which worker the tasks dialog should open ON, or null for the plain
  // list. The docked roster raises its `agentId` (`WorkerRoster.tsx`
  // `WorkerRow`) and App used to drop it, so clicking a worker landed on the
  // generic list. This carries it to the EXISTING P4-32b drilldown; no new
  // surface, and it is cleared with the dialog.
  const [tasksFocusAgentId, setTasksFocusAgentId] = useState<string | null>(null)
  const openTasksDialog = useCallback((agentId?: string) => {
    setTasksFocusAgentId(agentId ?? null)
    setTasksOpen(true)
  }, [])
  const closeTasksDialog = useCallback(() => {
    setTasksOpen(false)
    setTasksFocusAgentId(null)
  }, [])
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
  const activeSessionIdRef = useRef(activeSessionId)
  activeSessionIdRef.current = activeSessionId
  const pendingCloseRequestsRef = useRef<
    Map<SessionId, { openOrder: SessionId[] }>
  >(new Map())
  const pendingExplicitSessionRef = useRef<SessionId | null>(null)
  const lazyRestoreClaimsRef = useRef<Set<SessionId>>(new Set())
  const cancelledRestoresRef = useRef<Set<SessionId>>(new Set())
  // Sessions whose cached preview has already handed over to its live engine.
  // Released when a preview pane opens again (`openPreviewPane`) or the row is
  // reaped, so a later preview→live cycle still swaps exactly once.
  const swappedPreviewsRef = useRef<Set<SessionId>>(new Set())
  const startupPreloadStartedRef = useRef(false)
  const preloadCandidateIdsRef = useRef<Set<SessionId>>(new Set())
  const preloadQueuedIdsRef = useRef<Set<SessionId>>(new Set())
  const preloadReservedBytesRef = useRef<Map<SessionId, number>>(new Map())
  const preloadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const preloadCancelledRef = useRef(false)
  // Ids a live `session-removed` dropped before the initial snapshot folded in —
  // so the baseline hydrate never resurrects a row the host already reaped (F3).
  const removedIdsRef = useRef<Set<SessionId>>(new Set())
  const rosterReadAttemptRef = useRef(0)

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
              // A new cache is a new preview generation, and this path reaches
              // one without `openPreviewPane` (a live row that became restorable
              // again re-preloads through the host-event stream). The handover
              // claim belongs to the generation, not the session: leaving it set
              // would pin the pane to this cache while a live engine ran under it.
              swappedPreviewsRef.current.delete(cache.header.appSessionId)
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
      // This is the subscription callback's first action. It is intentionally
      // after preload receipt and before any reducer projection, so a delivery
      // timeline can distinguish a stalled renderer callback from a stalled
      // store update.
      for (const frame of frames) {
        if (!frame.deliveryTrace) continue
        bridge.deliveryAck(frame.sessionId, frame.deliveryTrace.sequence, frame.deliveryTrace.deliveryAttempt, frame.deliveryTrace.streamEpoch, frame.deliveryTrace.traceId, 'renderer.subscription.received')
      }
      const previewing = new Set<SessionId>()
      for (const sessionId in shellRef.current.previews) {
        previewing.add(sessionId)
      }
      // The claim is read and written synchronously here: React commits
      // `shell.previews` and the preview store a render later, so every batch of
      // a multi-batch restore would otherwise see the same still-previewing
      // session and hand over again. Ordering lives in `applyPreviewHandover`.
      const swapSessions = applyPreviewHandover(
        frames,
        previewing,
        swappedPreviewsRef.current,
        {
          resetLiveSession: sessionId =>
            dispatchSessionEvent({ type: 'preview-live-reset', sessionId }),
          applyFrames: () =>
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
              dispatchWorkers,
              dispatchLease,
              dispatchAccounts,
              dispatchWorkspaceTrust,
              dispatchDiagnostics,
              dispatchRunControls,
              dispatchContextBreakdown,
              dispatchSlashCatalog,
              dispatchQueuedPrompts,
              dispatchRemoteSettings,
              dispatchSessionActionRuntime,
              dispatchVerbAckResult,
              dispatchTranscript: dispatchSessionEvent,
            }),
          resetPreview: sessionId =>
            dispatchPreviewTranscript({ type: 'preview-reset', sessionId }),
        },
      )
      for (const sessionId of swapSessions) {
        preloadReservedBytesRef.current.delete(sessionId)
      }
      // D5 — resolve the retained submits against this batch. Each answer names
      // the submit it belongs to (`SubmitOptions.submitId` out,
      // `submit.result` back), so nothing here reads an outcome out of a frame
      // that was not addressed to one: the ordinary traffic a submit waits
      // through (a tool result on a user message, a republished staged snapshot,
      // both turn brackets, an error belonging to some other verb) passes by
      // without touching a retained copy.
      const answers = reduceSubmitAnswers(retainedSubmitsRef.current, frames)
      retainedSubmitsRef.current = answers.state
      const restoredBySession = new Map<SessionId, RetainedSubmit[]>()
      for (const { sessionId, retained } of answers.restored) {
        const entries = restoredBySession.get(sessionId) ?? []
        entries.push(retained)
        restoredBySession.set(sessionId, entries)
      }
      for (const [sessionId, retained] of restoredBySession) {
        restoreRefusedSubmits(sessionId, retained)
      }
      // D1b — the messages a recall took back, put where the user can edit them,
      // plus the one thing about the outcome the user has to be told. BOTH sit
      // behind the same gate: a requestId THIS page minted. That gate is what
      // makes the result safe to keep in the evictable replay ring, since a
      // reload starts with an empty set, so a replayed recall from before it
      // can neither push text the user has long since resent back into the
      // composer nor re-announce an outcome they already read.
      //
      // A recall gets ONE answer, and then possibly one correction to it: a
      // message it reported as taken back can turn out to have reached the model,
      // and the sidecar says so from the delivery signal. A correction is toasted
      // and restores NOTHING — the text is already in the composer from the first
      // answer, and the corrected message is the one that stayed with the model.
      //
      // An error carrying the same id is the OTHER answer a recall can get: main
      // raises one when it cannot reach the session at all, and the sidecar raises
      // one while parking. It releases the id just the same, so an undeliverable
      // recall is neither silent nor remembered forever.
      for (const frame of frames) {
        if (frame.kind === 'prompt-recall.result') {
          const disposition = classifyRecallAnswer(
            recallRequestsRef.current,
            frame,
          )
          if (disposition === 'ignore') continue
          if (disposition === 'first') {
            restoreRecalledPrompts(frame.sessionId, frame.recalled)
          }
          const outcome = verbAckErrorToast(frame)
          if (outcome) toast(outcome.message, { tone: outcome.tone })
          continue
        }
        // The answer to a read further back. It resolves the control on the
        // boundary row and nothing else: the recovered messages arrived ahead of
        // it as ordinary replay events, and whether the transcript is now whole
        // is read off the row's own presence, not from here. A refusal is shown
        // ON the row rather than toasted — the row is what the user pressed, and
        // it is where they will press again.
        if (frame.kind === 'history.loadEarlier.result') {
          setHistoryLoadEarlier(prev =>
            reduceHistoryLoadEarlierState(prev, { type: 'result', frame }),
          )
          continue
        }
        // A session that lost its engine is not going to answer. Without this
        // the control would stay disabled for the life of the window.
        if (frame.kind === 'lifecycle') {
          setHistoryLoadEarlier(prev =>
            reduceHistoryLoadEarlierState(prev, {
              type: 'engine-gone',
              sessionId: frame.sessionId,
            }),
          )
          continue
        }
        if (frame.kind !== 'error' || frame.requestId === undefined) continue
        if (!takeRecallErrorRequest(recallRequestsRef.current, frame.requestId)) {
          continue
        }
        const notice = recallDeliveryFailureNotice(frame)
        if (notice === null) continue
        setTransportErrors(prev =>
          reduceTransportErrorSet(prev, frame.sessionId, notice),
        )
      }
      for (const frame of frames) {
        if (!frame.deliveryTrace) continue
        bridge.deliveryAck(frame.sessionId, frame.deliveryTrace.sequence, frame.deliveryTrace.deliveryAttempt, frame.deliveryTrace.streamEpoch, frame.deliveryTrace.traceId, 'renderer.state.queued')
        // The post-commit effect below provides applied proof only after React
        // has incorporated the reducer batch; dispatch return proves queuing.
        pendingDeliveryStateAcksRef.current.push({
          sessionId: frame.sessionId,
          sequence: frame.deliveryTrace.sequence,
          deliveryAttempt: frame.deliveryTrace.deliveryAttempt,
          streamEpoch: frame.deliveryTrace.streamEpoch,
          traceId: frame.deliveryTrace.traceId,
        })
        // Streaming frames receive/apply proof but do not create one React-commit
        // IPC per token. Terminal/lifecycle outcomes receive the stronger proof.
        if (frame.kind === 'lifecycle' && ['disconnected', 'failed', 'exited'].includes(frame.status)) {
          pendingDeliveryCommitAcksRef.current.push({
            sessionId: frame.sessionId,
            sequence: frame.deliveryTrace.sequence,
            deliveryAttempt: frame.deliveryTrace.deliveryAttempt,
            streamEpoch: frame.deliveryTrace.streamEpoch,
            traceId: frame.deliveryTrace.traceId,
          })
        }
      }
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  const hydrateHostRoster = useCallback(() => {
    const attempt = ++rosterReadAttemptRef.current
    return attemptRosterBootstrap({
      listSessions: () => getBridge().listSessions(),
      onStarted: () => {
        dispatchRosterBootstrap({ type: 'read-started' })
      },
      onSnapshot: sessions => {
        if (attempt !== rosterReadAttemptRef.current) return
        dispatchShell({
          type: 'hydrate',
          sessions,
          removed: removedIdsRef.current,
        })
        dispatchRosterBootstrap({ type: 'read-succeeded' })
      },
      onFailure: () => {
        if (attempt !== rosterReadAttemptRef.current) return
        dispatchRosterBootstrap({ type: 'read-failed' })
      },
    })
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
      // Usage analytics ride the same accounts worker run, for the same reason:
      // the Accounts page opens with no session attached, and the per-session
      // stats frame cannot reach it there. Also NOT a roster row.
      if (event.type === 'usage-stats') {
        dispatchAccounts({ type: 'usage-stats', stats: event.stats })
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

        // Clean close / parked session (leaves tab membership): release the live
        // projected transcript and raw message log from renderer memory. The durable
        // source of truth is the engine transcript on disk. Releasing it on park
        // prevents closed sessions from retaining memory indefinitely.
        if (descriptor.status !== 'disconnected') {
          dispatch({ type: 'session-removed', sessionId })
          dispatchSessionEvent({ type: 'session-removed', sessionId })
        }

        // PL-A + PL-B composition: main re-emits a stable session-status after
        // writing a backfilled cache. Admit that cache through the existing
        // previewSession read path, serialized and under the same count/RAM
        // bounds as startup. This adds no IPC method or inbound frame kind.
        if (!hasPreviewTranscript(previewTranscriptRef.current, sessionId)) {
          queueTranscriptPreload([descriptor], { throttleMs: 0, quiet: true })
        }
      }
      if (event.type === 'session-removed') {
        dispatch({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchSessionEvent({
          type: 'session-removed',
          sessionId: event.appSessionId,
        })
        dispatchConnection({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchTasks({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchLease({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchWorkers({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchSessionActionRuntime({ type: 'session-removed', sessionId: event.appSessionId })
        removedIdsRef.current.add(event.appSessionId)
        lazyRestoreClaimsRef.current.delete(event.appSessionId)
        cancelledRestoresRef.current.delete(event.appSessionId)
        swappedPreviewsRef.current.delete(event.appSessionId)
        // A queued prompt must not outlive its session. It is otherwise cleared
        // only by a send or a release, so a row that leaves the roster with one
        // still held would leave the drain acting on a session that is gone.
        releasePendingSubmit(event.appSessionId)
        // Same rule, two stores the release above does not reach: a submit
        // awaiting its answer holds the user's text and a full base64 image,
        // and the staged rows describe a queue that is going away with the
        // session. Left behind, a later error frame could restore a message
        // from a session the user deleted.
        retainedSubmitsRef.current = reduceRetainedSubmitCleared(
          retainedSubmitsRef.current,
          event.appSessionId,
        )
        refusedSubmitPrefixesRef.current.delete(event.appSessionId)
        forgetRecallRequests(recallRequestsRef.current, event.appSessionId)
        dispatchQueuedPrompts({
          type: 'session-removed',
          sessionId: event.appSessionId,
        })
        dispatchPreviewTranscript({
          type: 'preview-reset',
          sessionId: event.appSessionId,
        })
        // The per-session domain stores keep their last-known values across a
        // LIFECYCLE frame on purpose — the rail must keep reading for a session
        // whose engine is merely gone. A REMOVED row is the other case: there is
        // nothing left to display it for, and the retained run-controls snapshot
        // carries a full model option list, so it is dropped here rather than
        // held until the renderer restarts.
        dispatchRunControls({
          type: 'session-removed',
          sessionId: event.appSessionId,
        })
        dispatchAccounts({ type: 'session-removed', sessionId: event.appSessionId })
        dispatchPermission({
          type: 'session-removed',
          sessionId: event.appSessionId,
        })
        preloadReservedBytesRef.current.delete(event.appSessionId)
      }
      dispatchShell({ type: 'event', event })
    })
    void hydrateHostRoster()
    return () => {
      rosterReadAttemptRef.current += 1
      preloadCancelledRef.current = true
      unsubscribe()
    }
  }, [hydrateHostRoster, queueTranscriptPreload])

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
  const focusActivePaneAfterRosterChange = useCallback(() => {
    const current = activeSessionIdRef.current
    const currentShell = shellRef.current
    const paneOrder = selectPaneSessions(currentShell).map(
      descriptor => descriptor.appSessionId,
    )
    const pendingClose =
      current === null
        ? undefined
        : pendingCloseRequestsRef.current.get(current)
    if (pendingClose) return
    const openOrder =
      currentShell.order.filter(
        sessionId =>
          currentShell.tabs[sessionId] === true ||
          currentShell.previews[sessionId] === true ||
          sessionId === current,
      )
    const next =
      current === null
        ? paneOrder[0] ?? null
        : activeAfterPaneChange(current, paneOrder, openOrder)
    if (next === current) return
    setActiveSessionId(next)
  }, [])

  useEffect(() => {
    focusActivePaneAfterRosterChange()
  }, [focusActivePaneAfterRosterChange, shell])

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
  const shellDescriptors = useMemo(() => selectShellDescriptors(shell), [shell])
  const visibleShellDescriptors = useMemo(
    () =>
      filterInteractiveSessionDescriptors(
        shellDescriptors,
        sessionCatalogSnapshot,
      ),
    [shellDescriptors, sessionCatalogSnapshot],
  )

  // Build one tab model per pane session, fusing the host descriptor with the
  // per-session connection view + pending-permission count (the background
  // attention badge). Every tab is computed from its OWN sessionId slice, so a
  // background tab's status/badge is correct without it being active.
  const tabs: TabModel[] = useMemo(
    () =>
      filterInteractiveSessionDescriptors(
        selectPaneSessions(shell),
        sessionCatalogSnapshot,
      ).map(rawDescriptor => {
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
                // Label + tone come from the ONE shared vocabulary
                // (`sessionStatusVisual`), never hand-built here; only the two
                // tab-specific booleans are set locally.
                ...sessionStatusVisual('preview', false, true),
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
  // The active session's worker snapshot, read once for the docked roster and
  // footer strip so both read one truth.
  const activeLiveWorkersSnapshot = selectLiveWorkersSnapshot(
    workersState,
    activeSessionId,
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

  // P4-6a — the merged Sessions catalog: the host registry rows (openable) ∪
  // the sidecar engine-history snapshot (rich metadata), via the shared
  // selector (reused by P4-17 Welcome recents, D5).
  const sessionCatalogRows = useMemo(
    () => selectMergedSessionRows(visibleShellDescriptors, sessionCatalogSnapshot),
    [visibleShellDescriptors, sessionCatalogSnapshot],
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

  // Settings is resolved per active engine session, but its project label must
  // be disambiguated against the whole merged roster (two workspaces can both
  // end in `app`). Keep that binding in its dedicated selector rather than
  // falling back to the cwd basename inside SettingsShell.
  const settingsProjectBinding = useMemo(
    () => selectSettingsProjectBinding(sessionCatalogRows, activeSessionId),
    [activeSessionId, sessionCatalogRows],
  )

  // P4-17 Welcome launcher — derived inputs, read from the SAME domain seams as
  // the other surfaces (no new feed, D5/WELCOME-LAUNCHER §6). Recents = a
  // distinct-workspace projection over the shared merged rows; trust = best-
  // effort per-cwd flags joined from live sessions' `workspace-trust.snapshot`
  // (only reporting sessions expose trust — a global projects-trust feed is out
  // of scope). The launcher renders at empty-state (no ACTIVE session), so the
  // account table reads the first available pool snapshot (the pool is global).
  const welcomeTrustByCwd = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const descriptor of visibleShellDescriptors) {
      const snap = selectWorkspaceTrustSnapshot(
        workspaceTrust,
        descriptor.appSessionId,
      )
      if (snap) map.set(descriptor.cwd, snap.trusted)
    }
    return map
  }, [visibleShellDescriptors, workspaceTrust])
  const welcomeRecents = useMemo(
    () => selectRecentWorkspaces(sessionCatalogRows, welcomeTrustByCwd),
    [sessionCatalogRows, welcomeTrustByCwd],
  )

  useEffect(() => {
    if (!hostSnapshotReady && paneSessionIds.length === 0) return
    const pendingExplicitSession = pendingExplicitSessionRef.current
    if (
      pendingExplicitSession !== null &&
      paneSessionIds.includes(pendingExplicitSession)
    ) {
      pendingExplicitSessionRef.current = null
    }
    if (
      pendingExplicitSession !== null &&
      pendingExplicitSession === activeSessionId &&
      !paneSessionIds.includes(pendingExplicitSession)
    ) {
      return
    }
    if (
      activeSessionId !== null &&
      pendingCloseRequestsRef.current.has(activeSessionId) &&
      !paneSessionIds.includes(activeSessionId)
    ) {
      return
    }
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
      visibleShellDescriptors
        .filter(descriptor => descriptor.restorable)
        .map(descriptor => descriptor.appSessionId),
    [visibleShellDescriptors],
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

  const focusCreatedSession = useCallback((sessionId: SessionId) => {
    pendingExplicitSessionRef.current = sessionId
    setWorkspaceLayoutState(current =>
      focusOrAssignWorkspaceSession(current, sessionId).state,
    )
    setActiveSessionId(sessionId)
    setActiveView('chat')
  }, [])

  const newSession = useCallback(async () => {
    const bridge = getBridge()
    try {
      // HC1 — the renderer never authors a path: pick → one-time token → create.
      const token = await bridge.pickDirectory(activeSessionId)
      if (!token) return // cancelled
      const result = await bridge.createSession({ cwdToken: token })
      if (result.ok) {
        focusCreatedSession(result.value.appSessionId)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [activeSessionId, focusCreatedSession])

  const newSessionInWorkspace = useCallback(async (repId: SessionId) => {
    const bridge = getBridge()
    try {
      // #15 — the per-workspace "+": the renderer names an EXISTING registry id
      // (a representative session in that workspace), NEVER a path. The host
      // re-derives + re-validates the cwd from its own registry (HC1) and spawns
      // a fresh session — no native picker, no renderer-authored cwd.
      const result = await bridge.createSessionInWorkspace(repId)
      if (result.ok) {
        focusCreatedSession(result.value.appSessionId)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [focusCreatedSession])

  /**
   * The sidebar's "New chat" (design source `components/sidebar/index.html`).
   * The design source leaves it unwired; here a session cannot exist without a
   * workspace, so it opens one in the workspace already on screen — no picker,
   * no prompt — and only falls back to the picker when nothing is open. The
   * Projects "+" is the deliberate picker path, so routing both there would give
   * the rail two identical buttons.
   */
  const newChat = useCallback(async () => {
    if (newChatInFlightRef.current) return
    newChatInFlightRef.current = true

    try {
      // Only a REGISTRY row can name a workspace to the host (HC1), so this asks
      // the merged catalog rather than trusting `activeSessionId` on its own.
      const repId = activeSessionRow?.appSessionId ?? null
      if (repId) {
        await newSessionInWorkspace(repId)
        return
      }
      await newSession()
    } finally {
      newChatInFlightRef.current = false
    }
  }, [activeSessionRow, newSession, newSessionInWorkspace])

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
    pendingExplicitSessionRef.current = null
    const result = focusOrAssignWorkspaceSession(workspaceLayout, sessionId)
    setWorkspaceLayoutState(result.state)
    setLayoutNotice(null)
    setActiveSessionId(sessionId)
    setActiveView('chat')
  }, [workspaceLayout])

  // Session-local account controls still address their pane's sidecar. Deleting
  // a saved profile is global durable state instead, so the Accounts page sends
  // those global mutations to main's session-independent engine worker.
  const sendAccountVerb = useCallback(
    (verb: AccountVerbMessage) => {
      if (verb.type === 'account.delete' || verb.type === 'account.logout') {
        const request =
          verb.type === 'account.delete'
            ? getBridge().deleteAccount(verb)
            : getBridge().signOutAccount(verb)
        // The host method has no session dependency, so Accounts remains
        // usable while every chat session is closed.
        void request
          .then(frame => {
            dispatchAccounts({ type: 'frame', frame })
          })
          .catch(() => {
            dispatchAccounts({
              type: 'frame',
              frame: {
                kind: 'account.result',
                protocolVersion: PROTOCOL_VERSION,
                sessionId: '',
                requestId: verb.requestId,
                verb: verb.type,
                ok: false,
                message:
                  verb.type === 'account.delete'
                    ? 'Could not delete that account.'
                    : 'Could not confirm account sign-out.',
              },
            })
          })
        return
      }
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

  // Flipping 7d/30d is a VIEW switch, not a fetch. The host `usage-stats` event
  // fills both ranges in one worker run precisely so the toggle needs no round
  // trip (`protocol.ts` `UsageStatsByRange`), and the store holds both.
  //
  // This used to also fire `queryStats(activeSessionId, range)` under an
  // `if (activeSessionId)` guard, which tests that an id EXISTS, not that its
  // session is LIVE. The Accounts page is reachable with no sidecar at all, so a
  // remembered id passed the guard, main answered `session_not_found`, and
  // because the preload mints a requestId for the query the error frame came
  // back correlated: the renderer toasted a raw session id at the user AND
  // `connectionState` moved that session to `dead`. A range toggle must not
  // touch session lifetime. No liveness check would fix it either, since the
  // session can die between the check and the send.
  const handleStatsRangeChange = useCallback((range: UsageStatsRange) => {
    dispatchAccounts({ type: 'set-stats-range', range })
  }, [])

  // P4-50 (O2a) — account health, pinned above the transcript instead of left to
  // scroll away inside it. Session-free by construction: it reads the global pool
  // view, so it is the same fact whichever tab is in front.
  const accountHealthBanner = selectAccountHealthBanner(
    selectGlobalAccountsSnapshot(accounts),
  )
  const accountHealthBannerId = accountHealthBanner?.id ?? null
  const [dismissedAccountHealthId, setDismissedAccountHealthId] = useState<
    string | null
  >(null)
  // Dismissal lasts exactly as long as the state that raised the bar. Nothing is
  // persisted (#12 deleted those keys and they stay deleted), so it cannot
  // outlive the run; and it is cleared the moment the pool recovers or escalates
  // to the other variant, so a dismissal can never hide a NEW problem. The two
  // failures to choose between were nagware and a silent failure; this drops the
  // first and refuses the second.
  useEffect(() => {
    if (accountHealthBannerId !== dismissedAccountHealthId) {
      setDismissedAccountHealthId(null)
    }
  }, [accountHealthBannerId, dismissedAccountHealthId])
  const accountHealthBanners =
    accountHealthBanner && accountHealthBanner.id !== dismissedAccountHealthId
      ? [accountHealthBanner]
      : EMPTY_BANNERS

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
  // Stop/kill action for a running `local_agent` worker. The
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

  // Retire a FINISHED worker row the engine's grace deadline will never retire on
  // its own (a blocked handoff carries no `evictAfter`). Same trust shape as the
  // stop above: the renderer names only the taskId, and the sidecar runs the
  // engine's own dismiss + eviction. The row's disappearance rides the resulting
  // `workers.snapshot` re-broadcast, not this call.
  const sendDismissTask = useCallback(
    (taskId: string) => {
      if (!activeSessionId) return
      getBridge().taskControlVerb(activeSessionId, {
        type: 'task.dismiss',
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

  const restorePromptIntoComposer = useCallback(
    (sessionId: SessionId, selectedPrompt: unknown): boolean => {
      const restored = restoreSelectedPrompt(selectedPrompt)
      if (!restored) return false
      updatePromptDrafts(current =>
        reducePromptDrafts(current, sessionId, restored.text),
      )
      setPasteState(current =>
        reduceSessionPastesCleared(current, sessionId),
      )
      setImageAttachmentState(current =>
        reduceSessionImagesReplaced(current, sessionId, restored.images),
      )
      setFileAttachmentState(current =>
        reduceFileAttachmentRemoved(current, sessionId),
      )
      setComposerFocusRequests(current => ({
        ...current,
        [sessionId]: (current[sessionId] ?? 0) + 1,
      }))
      return true
    },
    [],
  )

  // P4-35 (operator ruling 2026-07-30) — the app's only file write, reached the
  // one legal way: hand main the engine-rendered text plus a name SUGGESTION and
  // let it ask the user where the file goes (HC1 — the renderer names no path, and
  // learns none back). A dismissed dialog says nothing; a real failure carries
  // main's own message, never a guess.
  const saveTranscript = useCallback(
    async (text: string, suggestedName: string, savedMessage: string) => {
      try {
        const outcome = describeSaveOutcome(
          await getBridge().saveTextToFile({ text, suggestedName }),
          savedMessage,
        )
        if (outcome) toast(outcome.message, { tone: outcome.tone })
      } catch {
        // The preload's local bound, or a dead IPC channel. Either way the user
        // pressed a button and nothing happened, so say so.
        toast('The transcript could not be saved.', { tone: 'warn' })
      }
    },
    [toast],
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
  const handleMessageAction = useCallback<MessageActionHandler>(
    (sessionId, action, userMessageId) => {
      if (pendingMessageActionsRef.current.has(sessionId)) return
      const requestId = newRequestId()
      pendingMessageActionsRef.current.set(sessionId, {
        requestId,
        action,
        awaitingReconnect: false,
      })
      // Claim before the generic result effects can observe this id. Targeted
      // success is silent; its result drives composer restoration below.
      rememberToastedActionRequest(toastedActionRequestsRef.current, requestId)
      try {
        getBridge().sessionActionVerb(sessionId, {
          type:
            action === 'edit'
              ? 'session.editFromMessage'
              : 'session.branchFromMessage',
          requestId,
          userMessageId,
        })
      } catch (error) {
        pendingMessageActionsRef.current.delete(sessionId)
        toast(errorMessage(error), { tone: 'danger' })
      }
    },
    [toast],
  )

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
      rememberToastedActionRequest(
        toastedActionRequestsRef.current,
        result.requestId,
      )
      pendingTagWritesRef.current.delete(result.requestId)
      if (result.ok) entries.push(pending)
      toast(result.message, { tone: result.ok ? 'success' : 'danger' })
    }
    for (const error of Object.values(sessionActionRuntime.errorBySession)) {
      if (!error || toastedActionRequestsRef.current.has(error.requestId)) continue
      if (!pendingTagWritesRef.current.has(error.requestId)) continue
      rememberToastedActionRequest(
        toastedActionRequestsRef.current,
        error.requestId,
      )
      pendingTagWritesRef.current.delete(error.requestId)
      toast(error.message, { tone: 'danger' })
    }
    if (entries.length > 0) setSessionsTagEcho({ entries })
  }, [sessionActionRuntime, toast])

  // P4-35 — bulk export: one real `session.export` verb per live row (each runs
  // inside its OWN engine, N-process), folded into ONE file once every leg has
  // settled. The legs are claimed as toasted AT DISPATCH, so the general effect
  // below never pops a per-session outcome for a batch that reports itself once.
  //
  // Declared BEFORE that effect for the same reason the tag effect is: effects run
  // in declaration order, so this must have the ids first.
  const pendingBulkExportRef = useRef<BulkExportRequest[] | null>(null)
  useEffect(() => {
    const requests = pendingBulkExportRef.current
    if (!requests) return
    const engineBySession = Object.fromEntries(
      requests.map(request => [
        request.sessionId,
        connectionHasEngine(selectConnection(connection, request.sessionId).status),
      ]),
    )
    const outcome = selectBulkExportOutcome(
      requests,
      sessionActionRuntime.lastBySession,
      sessionActionRuntime.errorBySession,
      engineBySession,
    )
    if (outcome.status === 'waiting') return
    pendingBulkExportRef.current = null
    if (outcome.sections.length === 0) {
      toast('None of those sessions could be read.', { tone: 'warn' })
      return
    }
    void saveTranscript(
      buildBulkExportDocument(outcome.sections),
      exportFileName(`${outcome.sections.length} sessions`),
      bulkExportSavedMessage(outcome.sections.length, outcome.failed),
    )
  }, [connection, sessionActionRuntime, saveTranscript, toast])

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
    // P4-35 — and drop an unfinished bulk export with them. A leg whose session
    // dies before its very first result leaves no reset to observe, so the batch
    // can wait indefinitely; leaving the page is the point past which a save
    // dialog appearing would be a surprise rather than an answer.
    pendingBulkExportRef.current = null
  }, [activeView])

  const latestSessionActionResult = selectLatestSessionActionResult(
    sessionActionRuntime,
    activeSessionId,
  )
  useEffect(() => {
    const result = latestSessionActionResult
    if (!result) return
    if (toastedActionRequestsRef.current.has(result.requestId)) return
    rememberToastedActionRequest(
      toastedActionRequestsRef.current,
      result.requestId,
    )
    if (result.requestId === openExportRequestIdRef.current) return
    toast(result.message, { tone: result.ok ? 'success' : 'danger' })
  }, [latestSessionActionResult, toast])

  const latestSessionActionError = selectLatestSessionActionError(
    sessionActionRuntime,
    activeSessionId,
  )
  useEffect(() => {
    const error = latestSessionActionError
    if (!error || toastedActionRequestsRef.current.has(error.requestId)) return
    if (error.requestId === openExportRequestIdRef.current) return
    rememberToastedActionRequest(
      toastedActionRequestsRef.current,
      error.requestId,
    )
    toast(error.message, { tone: 'danger' })
  }, [latestSessionActionError, toast])

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
    const error = selectLatestSessionActionError(
      sessionActionRuntime,
      exportDialog.sessionId,
    )
    if (error?.requestId === exportDialog.requestId) {
      setLatchedExport(current =>
        current?.requestId === exportDialog.requestId
          ? current
          : {
              requestId: exportDialog.requestId,
              state: { status: 'failed', message: error.message },
            },
      )
      dispatchSessionActionRuntime({
        type: 'discard-result',
        sessionId: exportDialog.sessionId,
        requestId: exportDialog.requestId,
      })
      return
    }
    if (projected.status === 'pending') return
    setLatchedExport(current =>
      current?.requestId === exportDialog.requestId
        ? current
        : { requestId: exportDialog.requestId, state: projected },
    )
    dispatchSessionActionRuntime({
      type: 'discard-result',
      sessionId: exportDialog.sessionId,
      requestId: exportDialog.requestId,
    })
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
    // D1b — a recall is announced from the frame gate that owns its minted
    // request id, never from here. This dedupe is per page load, so a replayed
    // result would re-announce an outcome the user read before the reload.
    if (result.kind === 'prompt-recall.result') return
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

  // CC-16 — hand a parked prompt back to the composer. Called on every terminal
  // outcome of the spawn the user's keystroke started (a rejected/thrown
  // restore here, a terminal connection status in the drain effect below), so a
  // failed reconnect surfaces the text plus an error instead of eating it.
  const releasePendingSubmit = useCallback((sessionId: SessionId) => {
    const pending = selectPendingSubmit(pendingSubmitsRef.current, sessionId)
    if (pending === null) return
    setPendingSubmits(prev => reducePendingSubmitCleared(prev, sessionId))
    updatePromptDrafts(drafts =>
      reducePromptDrafts(
        drafts,
        sessionId,
        restoreDraftWithPending(
          selectPromptDraft(drafts, sessionId),
          pending.text,
        ),
      ),
    )
    setImageAttachmentState(state =>
      reduceSessionImagesRestored(state, sessionId, pending.images ?? []),
    )
    setFileAttachmentState(state =>
      reduceSessionFileAttachmentRestored(state, sessionId, pending.file),
    )
    setTransportErrors(prev =>
      reduceTransportErrorSet(prev, sessionId, PENDING_SUBMIT_RELEASED_MESSAGE),
    )
  }, [])

  // D5 — the composer half of a refused submit. No notice of its own: the
  // sidecar's typed error is already rendered directly above the composer and
  // says why the message bounced, and the message reappearing in the composer
  // is the rest of the story. A second red line restating it would be noise.
  //
  // Attachments restore in submission order, so the newest refused attachment
  // wins just as attaching them one after another would. Text is merged once,
  // so the original submit order stays ahead of a draft typed during the round
  // trip. Empty attachment lists leave the current draft's attachment alone.
  const restoreRefusedSubmits = useCallback((
    sessionId: SessionId,
    retained: readonly RetainedSubmit[],
  ) => {
    const restored = applyRefusedSubmitRestoration(
      promptDraftsRef.current,
      refusedSubmitPrefixesRef.current,
      sessionId,
      retained,
    )
    refusedSubmitPrefixesRef.current = restored.recovery
    updatePromptDrafts(() => restored.drafts)
    if (restored.images !== null) {
      setImageAttachmentState(state =>
        reduceSessionImagesRestored(state, sessionId, restored.images ?? []),
      )
    }
    if (restored.file !== null) {
      setFileAttachmentState(state =>
        reduceSessionFileAttachmentRestored(state, sessionId, restored.file),
      )
    }
  }, [])

  // D1b — the composer half of a recall, and deliberately the SAME shape as the
  // refused-submit restore above: text merges under whatever is being typed,
  // attachments replace (guarded the same way, via `reduceSessionImagesRestored`).
  // A recalled message is one the user is taking back to edit, so it must not
  // overwrite a draft they started while it waited.
  const restoreRecalledPrompts = useCallback(
    (sessionId: SessionId, prompts: readonly RecalledPrompt[]) => {
      const { text, images } = foldRecalledPrompts(prompts)
      if (text.length === 0 && images.length === 0) return
      updatePromptDrafts(drafts =>
        reducePromptDrafts(
          drafts,
          sessionId,
          restoreDraftWithPending(selectPromptDraft(drafts, sessionId), text),
        ),
      )
      setImageAttachmentState(state =>
        reduceSessionImagesRestored(state, sessionId, images),
      )
    },
    [],
  )

  // D1b — ask for every message still waiting on this session's running
  // response. Nothing is removed here: the sidecar owns the engine's queue and
  // answers with what it actually managed to take back, which is what the
  // restore above then applies.
  const recallQueuedPrompts = useCallback((sessionId: SessionId) => {
    const requestId = newRequestId()
    trackRecallRequest(recallRequestsRef.current, requestId, sessionId)
    try {
      getBridge().recallPrompts(sessionId, { type: 'prompt.recall', requestId })
    } catch (error) {
      releaseRecallRequest(recallRequestsRef.current, requestId)
      setTransportErrors(prev =>
        reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
      )
    }
  }, [])

  const navigateAfterClosedSession = useCallback(
    (sessionId: SessionId, openedOrder: readonly SessionId[]) => {
      pendingCloseRequestsRef.current.delete(sessionId)
      if (pendingExplicitSessionRef.current === sessionId) {
        pendingExplicitSessionRef.current = null
      }
      if (activeSessionIdRef.current !== sessionId) return

      const currentPaneOrder = selectPaneSessions(shellRef.current).map(
        descriptor => descriptor.appSessionId,
      )
      const paneOrder = currentPaneOrder.filter(
        candidate => candidate !== sessionId,
      )
      const openOrder = [
        ...openedOrder,
        ...currentPaneOrder.filter(candidate => !openedOrder.includes(candidate)),
      ]
      const next = activeAfterPaneChange(sessionId, paneOrder, openOrder)
      if (next === null) {
        setWorkspaceLayoutState(createWorkspaceLayout(null))
      } else {
        setWorkspaceLayoutState(current =>
          focusOrAssignWorkspaceSession(current, next).state,
        )
      }
      setActiveSessionId(next)
    },
    [],
  )

  const closeTab = useCallback(async (sessionId: SessionId) => {
    const shell = shellRef.current
    const openOrder = selectPaneSessions(shell).map(
      descriptor => descriptor.appSessionId,
    )
    if (openOrder.includes(sessionId)) {
      pendingCloseRequestsRef.current.set(sessionId, {
        openOrder,
      })
    }
    // Closing is the user saying they are done with this session, so a prompt
    // still queued for it is handed back rather than left to drain into a
    // session that is going away. The text lands in this session's draft, which
    // is renderer-local and survives the close, so reopening finds it intact.
    releasePendingSubmit(sessionId)
    // A submit awaiting its answer is DROPPED rather than handed back: it was
    // sent, and its retained copy holds base64 image data this closed session
    // would otherwise keep alive with nothing left to resolve it. A recall
    // still waiting for its answer goes the same way, for the same reason.
    retainedSubmitsRef.current = reduceRetainedSubmitCleared(
      retainedSubmitsRef.current,
      sessionId,
    )
    refusedSubmitPrefixesRef.current.delete(sessionId)
    forgetRecallRequests(recallRequestsRef.current, sessionId)
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
      if (!plan.closeLive) {
        navigateAfterClosedSession(sessionId, openOrder)
        return
      }
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
      if (!result.ok) {
        pendingCloseRequestsRef.current.delete(sessionId)
        setShellError(hostErrorMessage(result.error))
        return
      }

      const pendingClose = pendingCloseRequestsRef.current.get(sessionId)
      navigateAfterClosedSession(
        sessionId,
        pendingClose?.openOrder ?? openOrder,
      )
    } catch (error) {
      pendingCloseRequestsRef.current.delete(sessionId)
      setShellError(errorMessage(error))
    }
  }, [navigateAfterClosedSession, releasePendingSubmit])

  const setPeerWakeBlocked = useCallback(
    async (sessionId: SessionId, blocked: boolean) => {
      // PEER-SESSIONS §6 — the user's one control over the ruling that a peer
      // message may wake a closed session. Durable host state, so nothing is
      // written locally: the row re-renders from the host update that follows,
      // which is the only copy that survives a relaunch. A typed refusal is
      // surfaced instead of being swallowed, because a toggle that silently
      // fails would leave the menu showing a decision that was never saved.
      try {
        const result = await getBridge().setPeerWakeBlocked(sessionId, blocked)
        if (!result.ok) setShellError(hostErrorMessage(result.error))
      } catch (error) {
        setShellError(errorMessage(error))
      }
    },
    [],
  )

  const restartTab = useCallback(async (sessionId: SessionId) => {
    // The fixed control-plane response carries a typed refusal instead of relying
    // on a later lifecycle event that may never arrive.
    try {
      const result = await getBridge().restart(sessionId)
      if (!result.ok) setShellError(hostErrorMessage(result.error))
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  const restoreLiveSession = useCallback(
    async (sessionId: SessionId, options: { focus?: boolean } = {}) => {
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
            }
            return
          }
          // `focus: false` is the idle-park drain: the user typed into a pane
          // they were already reading, and by the time a ~seconds-long engine
          // boot finishes they may have moved on. Every OTHER caller is a click
          // on the session, where taking focus is the point.
          if (options.focus !== false) {
            setActiveSessionId(result.value.appSessionId)
            setActiveView('chat')
          }
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

  // IDLE-PARK — bring back the engine behind a parked session so its held prompt
  // can drain. Deliberately DELEGATES to `restoreLiveSession` rather than making
  // the same host call itself: the first version did, and immediately drifted
  // from its sibling, losing both the `cancelledRestoresRef` handshake (closing a
  // pane mid-restore could no longer cancel it) and the release-on-failure paths.
  // The only difference this path is entitled to is not stealing focus.
  //
  // The pane guard is the other half of the fix. A queued prompt outlives the
  // session it was typed into — nothing clears `pendingSubmits` on close — and a
  // parked session never receives a lifecycle frame when it is closed (the host
  // deregisters the record before the child dies, so the exit is dropped). So the
  // connection snapshot stays `'parked'` for a session that no longer has a pane,
  // the drain keeps answering `'restore'`, and without this the app would re-spawn
  // a real engine for a tab the user closed and send the message into it. Before
  // park existed the same stale entry was harmless: `'exited'` is terminal, so the
  // drain released it on the first pass.
  const restoreParkedSession = useCallback(
    (sessionId: SessionId) => {
      const shell = shellRef.current
      if (shell.tabs[sessionId] !== true && shell.previews[sessionId] !== true) {
        releasePendingSubmit(sessionId)
        return
      }
      if (!claimLazyRestore(lazyRestoreClaimsRef.current, sessionId)) return
      void restoreLiveSession(sessionId, { focus: false })
    },
    [releasePendingSubmit, restoreLiveSession],
  )

  const openPreviewPane = useCallback((sessionId: SessionId) => {
    swappedPreviewsRef.current.delete(sessionId)
    dispatchShell({ type: 'preview-open', sessionId })
    setWorkspaceLayoutState(current =>
      focusOrAssignWorkspaceSession(current, sessionId).state,
    )
    setActiveSessionId(sessionId)
    setActiveView('chat')
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
    async (engineSessionId: string): Promise<SessionDescriptor | null> => {
      const bridge = getBridge()
      try {
        const result = await bridge.openHistorySession(engineSessionId)
        if (!result.ok) {
          setShellError(hostErrorMessage(result.error))
          return null
        }
        const descriptor = result.value
        if (descriptor.restorable) {
          void performRestore(descriptor.appSessionId)
          return descriptor
        }
        setActiveSessionId(descriptor.appSessionId)
        setActiveView('chat')
        return descriptor
      } catch (error) {
        setShellError(errorMessage(error))
        return null
      }
    },
    [performRestore],
  )

  useEffect(() => {
    for (const [sessionId, pending] of pendingMessageActionsRef.current) {
      const error = sessionActionRuntime.errorBySession[sessionId]
      if (error?.requestId === pending.requestId) {
        pendingMessageActionsRef.current.delete(sessionId)
        dispatchSessionActionRuntime({
          type: 'discard-result',
          sessionId,
          requestId: pending.requestId,
        })
        toast(error.message, { tone: 'danger' })
        continue
      }
      const result =
        sessionActionRuntime.targetedByRequestId[pending.requestId]
      if (!result) {
        const hasEngine = connectionHasEngine(
          selectConnection(connection, sessionId).status,
        )
        if (!hasEngine) {
          pending.awaitingReconnect = true
        } else if (pending.awaitingReconnect) {
          pendingMessageActionsRef.current.delete(sessionId)
        }
        continue
      }
      const expectedVerb =
        pending.action === 'edit' ? 'editFromMessage' : 'branchFromMessage'
      if (
        result.sessionId !== sessionId ||
        result.verb !== expectedVerb
      ) {
        continue
      }
      pendingMessageActionsRef.current.delete(sessionId)
      dispatchSessionActionRuntime({
        type: 'discard-result',
        sessionId,
        requestId: pending.requestId,
      })
      if (!result.ok) {
        toast(result.message, { tone: 'danger' })
        continue
      }
      if (pending.action === 'edit') {
        if (!restorePromptIntoComposer(sessionId, result.selectedPrompt)) {
          toast('That message could not be restored.', { tone: 'danger' })
        }
        continue
      }
      if (
        !result.branchEngineSessionId ||
        result.selectedPrompt === undefined
      ) {
        toast('That message could not be restored.', { tone: 'danger' })
        continue
      }
      void openHistorySession(result.branchEngineSessionId).then(descriptor => {
        if (
          descriptor &&
          !restorePromptIntoComposer(
            descriptor.appSessionId,
            result.selectedPrompt,
          )
        ) {
          toast('That message could not be restored.', { tone: 'danger' })
        }
      })
    }
  }, [
    connection,
    openHistorySession,
    restorePromptIntoComposer,
    sessionActionRuntime,
    toast,
  ])

  // P4-29 — the ONE way a catalog row is opened, shared by the Sessions-page row
  // click and the ⋯ menu's Open/Restore verb. Those two had each re-derived the
  // routing, and the menu's copy was wrong: it ran a bare `selectTab` for a
  // restorable row, so a row whose own menu said "Restore" only re-focused a dead
  // pane. `resolveSessionOpenRoute` is now the single decision
  // (`sessionsCatalogState.ts`), so a new caller cannot reintroduce the split.
  const applyOpenRoute = useCallback(
    (route: SessionOpenRoute) => {
      if (route.kind === 'focus') selectTab(route.appSessionId)
      else if (route.kind === 'restore') void performRestore(route.appSessionId)
      else if (route.kind === 'history') void openHistorySession(route.engineSessionId)
    },
    [selectTab, performRestore, openHistorySession],
  )

  const openCatalogRow = useCallback(
    (row: MergedSessionRow) => {
      applyOpenRoute(resolveSessionOpenRoute(row))
    },
    [applyOpenRoute],
  )

  // P4-40 — the Welcome launcher opens a project through that same one decision.
  // It used to open by app id only, so a project whose sessions were all created
  // in the terminal had nothing to open with and its click was dropped here.
  // `resolveRecentOpenRoute` gives it the history route, which passes ONLY the
  // engine session id: main resolves the workspace from the engine-written
  // baseline cache (`app/main/openHistorySession.ts`), so HC1 still holds.
  const openRecentWorkspace = useCallback(
    (recent: RecentWorkspace) => {
      applyOpenRoute(resolveRecentOpenRoute(recent))
    },
    [applyOpenRoute],
  )

  function submitSession(
    sessionId: SessionId,
    event: FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault()
    const sessionLog = selectRawMessageLog(state, sessionId)
    const sessionConnection = selectConnection(connection, sessionId)
    const images = selectImageAttachments(imageAttachmentState, sessionId)
    const file = selectFileAttachment(fileAttachmentState, sessionId)
    // Collapsed-paste tokens are expanded back to their full text before submit
    // — the engine receives plain prompt text, never a `[Pasted text #N]` ref
    // (parity `expandPastedTextRefs`, src/history.ts:81 / handlePromptSubmit.ts:216).
    // CC-16 — a submit with no engine attached YET is parked, never dropped
    // (`connectPending`: a preview pane, an in-flight spawn, an idle park). A
    // mid-turn submit is NOT parked: it goes out and the engine queues it into
    // the running turn. Only a terminal session refuses outright.
    const action = planSessionSubmit({
      draft: selectPromptDraft(promptDrafts, sessionId),
      pasteEntries: selectSessionPasteState(pasteState, sessionId).entries,
      hasImages: images.length > 0 || file !== null,
      preview: hasPreviewTranscript(previewTranscript, sessionId),
      connectionStatus: sessionConnection.status,
      connectionInputEnabled: sessionConnection.inputEnabled,
      logInputEnabled: sessionLog.inputEnabled,
      alreadyParked: selectPendingSubmit(pendingSubmits, sessionId) !== null,
    })
    if (action.type === 'ignore') {
      // The one `ignore` the user can act on: they typed something and pressed
      // Enter, and it stayed put because a prompt is already waiting on the
      // spawn. The arrow greys out to say so, but Enter bypasses the arrow, so
      // without this the keystroke reads as swallowed.
      if (
        selectPendingSubmit(pendingSubmits, sessionId) !== null &&
        selectPromptDraft(promptDrafts, sessionId).trim().length > 0
      ) {
        toast('Only one message can be queued at a time.', { tone: 'info' })
      }
      return
    }
    const text = action.text
    const submitPrompt = buildSubmitPrompt(text, images)
    // Both paths retire the draft the same way: the prompt has left the
    // composer, so the pastes it expanded are spent and it joins ↑/↓ history.
    // A parked prompt that is later released comes back as its expanded text
    // (`restoreDraftWithPending`) — the pills are gone, the content is not.
    const retireDraft = (): void => {
      updatePromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, ''))
      setPasteState(prev => reduceSessionPastesCleared(prev, sessionId))
      setImageAttachmentState(prev =>
        reduceSessionImagesReplaced(prev, sessionId, []),
      )
      setFileAttachmentState(prev => reduceFileAttachmentRemoved(prev, sessionId))
      setHistoryState(prev => reduceHistoryPushed(prev, sessionId, text))
    }
    if (action.type === 'hold') {
      setPendingSubmits(prev =>
        reducePendingSubmitHeld(prev, sessionId, {
          text,
          images,
          file,
          showQueuedRow: action.showQueuedRow,
        }),
      )
      retireDraft()
      setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
      return
    }

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    // D5 — the correlation id for THIS submit. Minted here, before the send, and
    // carried back on the one answer this submit gets, which is what lets the
    // retained copy below be paired exactly rather than by position.
    const submitId = newRequestId()
    try {
      getBridge().submit(sessionId, submitPrompt, {
        submitId,
        ...(file ? { fileAttachmentToken: file.token } : {}),
      })
      // D5 — the clear below is OPTIMISTIC: the sidecar can still refuse this
      // (the mid-turn depth cap), and its answer arrives long after. Retain the
      // exact message, images included, until that answer says which way it went.
      // `↑` history keeps only the text, so without this the attachments are
      // unrecoverable in principle, not just in practice.
      retainedSubmitsRef.current = reduceRetainedSubmitHeld(
        retainedSubmitsRef.current,
        sessionId,
        { submitId, text, images: [...images], file },
      )
      retireDraft()
      setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
    } catch (error) {
      setTransportErrors(prev =>
        reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
      )
    }
  }

  // CC-16 drain — the parked prompt rides the SAME `app.submit` the moment an
  // engine is attached, which is the end of the ~0.6 s spawn. It does NOT wait
  // for a turn boundary: a spawn that lands on a session already mid-turn still
  // flushes, because the sidecar queues a mid-turn prompt into the engine.
  // A terminal status releases it back into the composer instead: a queued
  // prompt must never disappear on a spawn that never finishes.
  //
  // IDLE-PARK adds the `restore` arm: an idle-parked session has no spawn coming
  // and no turn to end, so the drain ASKS for the engine back and keeps holding.
  // That is what makes a reclaimed engine invisible — the user's Enter restores
  // and sends, and no Restart button is involved.
  useEffect(() => {
    for (const sessionId of Object.keys(pendingSubmits)) {
      const pending = pendingSubmits[sessionId]
      if (pending === undefined) continue
      const outcome = resolvePendingSubmit(selectConnection(connection, sessionId))
      if (outcome === 'wait') continue
      if (outcome === 'restore') {
        restoreParkedSession(sessionId)
        continue
      }
      if (outcome === 'release') {
        releasePendingSubmit(sessionId)
        continue
      }
      const submitId = newRequestId()
      try {
        getBridge().submit(
          sessionId,
          buildSubmitPrompt(pending.text, pending.images ?? []),
          {
            submitId,
            ...(pending.file
              ? { fileAttachmentToken: pending.file.token }
              : {}),
          },
        )
        // D5 — the drain hands over the SAME `app.submit`, so it can be refused
        // the same way; clearing the park below is as optimistic as the
        // composer clear in `submitSession`.
        retainedSubmitsRef.current = reduceRetainedSubmitHeld(
          retainedSubmitsRef.current,
          sessionId,
          {
            submitId,
            text: pending.text,
            images: [...(pending.images ?? [])],
            file: pending.file ?? null,
          },
        )
        setPendingSubmits(prev => reducePendingSubmitCleared(prev, sessionId))
        setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
      } catch (error) {
        releasePendingSubmit(sessionId)
        setTransportErrors(prev =>
          reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
        )
      }
    }
  }, [connection, pendingSubmits, releasePendingSubmit, restoreParkedSession])

  // IDLE-PARK §4(b) — tell main which sessions are on screen so its park policy
  // leaves them alone. The workspace panels ARE the visible set (one session per
  // panel, so a split shows several at once); `activeSessionId` rides along for
  // the window between a focus change and the layout catching up. Latest-wins at
  // main, so closing a pane un-protects it immediately.
  //
  // Sent only when the SET changes, not whenever the layout object does: dragging
  // a panel divider rewrites `workspaceLayout` on every mouse-move while the
  // visible sessions stay put, and those sends would burn the preload's shared
  // rate budget (`rendererIpcGuard`) to re-state a fact main already has.
  // `null`, not `''`: the empty set is a real, reportable state (every pane
  // closed, or the user on a non-chat page) and its key IS the empty string, so
  // seeding with `''` would make the one report that un-protects everything the
  // one report that can never be sent.
  const reportedVisibleRef = useRef<string | null>(null)
  useEffect(() => {
    // Panes render only under the chat view (`activeView === 'chat'` below), so
    // while the user is on Settings/Sessions/Accounts nothing is on screen and
    // nothing is protected. Without this, leaving the app parked on a non-chat
    // page would exempt every session from the TTL indefinitely, which is the
    // abandoned-tab case the TTL exists for.
    const visible = new Set<SessionId>()
    if (activeView === 'chat') {
      for (const panel of workspaceLayout.panels) visible.add(panel.sessionId)
      if (activeSessionId) visible.add(activeSessionId)
    }
    const sessionIds = [...visible].sort()
    const key = sessionIds.join(' ')
    if (key === reportedVisibleRef.current) return
    try {
      getBridge().reportVisibleSessions(sessionIds)
      // Recorded only once the send actually returned. `reportVisibleSessions`
      // throws through the preload's SHARED rate guard, and marking the key sent
      // before the call meant a throttled call was remembered as delivered — so
      // main stayed pinned to the previous set even after the user settled on a
      // new pane, which is the precise failure this hint exists to prevent.
      reportedVisibleRef.current = key
    } catch {
      // A hint, not a dependency: if it cannot be delivered the policy simply
      // runs as it did before this existed. Never break the render for it.
      //
      // Leaving the ref alone means the NEXT visible-set change re-sends; it is
      // not a retry of this one, because the effect re-runs only on its deps. A
      // report lost to the rate guard therefore leaves main on the previous set
      // until the user next moves. Accepted rather than papered over with a
      // timer: the guard is 120 renderer sends per second and every one of them
      // is a deliberate user action, so this is a bound, not a working regime,
      // and the failure direction is less protection, never a wrongful park.
    }
  }, [workspaceLayout, activeSessionId, activeView])

  const setSessionPrompt = useCallback(
    (
      sessionId: SessionId,
      value: string,
      reason: DraftWriteReason = 'edit',
    ) => {
      updatePromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, value))
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
    (
      sessionId: SessionId,
      currentDraft: string,
      entry: PasteEntry,
      at: number,
    ): void => {
      const token = formatPasteRef(entry.id, entry.numLines)
      // Cut the clicked occurrence only, and let the ordinary 'edit' prune
      // decide the stored text's fate: it drops the entry when no reference is
      // left, and keeps it while a duplicate token still stands. Dropping the
      // entry here outright would strand that surviving pill with nothing
      // behind it, so it would submit as the literal token.
      setSessionPrompt(
        sessionId,
        removePasteOccurrence(currentDraft, token, at),
      )
    },
    [setSessionPrompt],
  )

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
        setTransportErrors(prev => reduceTransportErrorSet(prev, sessionId, error))
      } else {
        setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
      }
    },
    [permissions],
  )

  // A request with its OWN dedicated renderer owns the keyboard while it is up:
  // AskQuestionFlow registers a `window` keydown listener (`AskQuestionFlow.tsx`),
  // and PlanPanel registers a `document` one through `useModalFocus`
  // (`overlayFocus.ts:345`). Either way, a permission card live alongside one of
  // them would let a single Enter resolve two unrelated requests — answering a
  // question would also allow a parallel Bash call. Nulling the target below is
  // what prevents it: the card never registers a listener at all.
  const dedicatedFlowOwnsKeyboard =
    selectAskQuestion(permissions, activeSessionId) !== null ||
    selectPlanReview(permissions, activeSessionId) !== null

  // The card that takes focus and advertises the keys, kept in lockstep with the
  // listener below so a card can never claim keys the listener does not deliver:
  // exactly the request the handler answers, and nothing while a dedicated flow
  // holds the keyboard.
  const permissionKeyTargetRequestId =
    pendingPermission && !dedicatedFlowOwnsKeyboard
      ? pendingPermission.requestId
      : null

  // The select list's cursor and its keyboard both live on the card that owns
  // them (`PermissionPrompt.tsx`), not here. They were App state + an App
  // `document` listener, which meant moving a highlight one row re-rendered the
  // whole shell. `permissionKeyTargetRequestId` above is the entire contract
  // between the two: exactly one card is ever handed it, so exactly one
  // listener exists, and it is never registered beside a dedicated flow's.

  // Shell keyboard: keyboard-first tab switching + create/close, matching the
  // prototype's chords (⌘T new · ⌘W close · ⌘1..9 jump-to-tab). Only fires on a
  // meta/ctrl chord, and the permission card's own list claims Ctrl for exactly
  // ⌃P/⌃N (`permissionKeyIntent`), which this handler does not use — so the two
  // key maps stay disjoint even where both accept Ctrl.
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
        // A new tab stays in the workspace you are already in: `newChat` reuses
        // the active row's registry workspace (HC1 — the host re-derives the
        // cwd, the renderer never names one) and only falls back to the native
        // picker when there is no active row to inherit from. "Add project" and
        // "Open folder" remain the deliberate pick-a-directory paths.
        event.preventDefault()
        void newChat()
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
  }, [shell, activeSessionId, newChat, closeTab, selectTab])

  function copyForLlm(sessionId: SessionId): void {
    const text = buildDebugExport(
      selectTranscriptRows(transcript, sessionId),
      selectRawMessageLog(state, sessionId),
    )
    void navigator.clipboard.writeText(text)
  }

  /**
   * The ⋯ menu's `copy-ids` verb: the two ids that address one session, in the
   * `app … / engine …` labelling the deleted composer debug line used, so a
   * paste into a log search or a `--resume` still reads the same. Missing id →
   * `none`, which is the honest answer and what that line printed too.
   */
  function copySessionIds(row: MergedSessionRow): void {
    const text =
      `app ${row.appSessionId ?? 'none'}\n` +
      `engine ${selectRowEngineSessionId(row) ?? 'none'}`
    void navigator.clipboard
      .writeText(text)
      .then(() => toast('Session ids copied to clipboard', { tone: 'success' }))
      .catch(() =>
        toast('Could not write to the clipboard', { tone: 'warn' }),
      )
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
	      // What the question card's kicker counts. NOT the generic queue plus
	      // one: that queue drops the plan review and every ask request, so a
	      // queued ExitPlanMode went uncounted while already-submitted rows were
	      // counted — the exact mistake `PermissionQueue`'s `awaitingAnswer`
	      // exists to avoid. This selector is the session-wide "still needs an
	      // answer" count, which is what the kicker means.
	      const sessionAskPendingCount = selectPendingPermissionCount(
	        permissions,
	        sessionId,
	      )
	      // The generic per-tool card queue = the pending queue minus both
	      // dedicated-renderer families (plan + ask).
	      const sessionDisplayQueue =
	        sessionConnection.status === 'ready'
	          ? selectGenericPermissionQueue(
	              selectNonPlanPermissionQueue(permissions, sessionId),
	            )
	          : []
	      const descriptor = tabDescriptorsById.get(sessionId)
          // Background cache admission must not replace a tab's fuller live
          // projection when its engine parks. Only an explicitly opened preview
          // pane reads the bounded cache and its related metadata.
          const panelTranscript = selectPaneTranscript({
            previewState: previewTranscript,
            sessionId,
            previewOpen: shell.previews[sessionId] === true,
            liveTranscript: transcript,
          })
	      // The whole composer rail's display-vs-capability split, derived in one
	      // testable place (`composerRailModel.ts`) rather than as a dozen
	      // expressions here. It owns which values outlive the session's engine
	      // and which controls stay armed.
	      const rail = selectComposerRail({
	        runControls,
	        permissions,
	        accounts,
	        connectionStatus: sessionConnection.status,
	        sessionId,
	      })
		      // In-session empty-state Welcome context (read-only): the pool view for
		      // THIS pane, freshest-first (see `railAccounts` for why a pane with no
		      // engine reads the polled global feed rather than its own frozen copy).
	      const panelAccounts = rail.accountsSnapshot
		      const panelWorkersSnapshot = selectLiveWorkersSnapshot(workersState, sessionId)
		      const panelWorkers = panelWorkersSnapshot?.workers ?? EMPTY_WORKERS
          const panelTasks = selectTasksSnapshot(tasks, sessionId)
	      // Read-only git branch for the empty-state meta strip. The SESSION's own
	      // snapshot leads: the catalog's `gitBranch` is only written when a
	      // message is persisted (`src/utils/sessionStorage.ts:1464`), so it is
	      // always absent in the one state this strip renders in — the empty
	      // transcript — and the column read "none" in every repo. The catalog
	      // stays as the fallback for a session whose sidecar snapshot has not
	      // landed yet (or a restored row with no live process). Matched on
	      // `appSessionId` for the same reason `activeSessionRow` is (:911):
	      // `row.sessionId` holds the engineSessionId once one is assigned, so
	      // matching on it misses every session that has reached ready.
	      const panelDiagnostics = selectDiagnosticsSnapshot(diagnostics, sessionId)
	      const panelBranch =
	        panelDiagnostics?.gitBranch ??
	        sessionCatalogRows.find(r => r.appSessionId === sessionId)?.gitBranch ??
	        null
	      // Where this session's tools actually run. "Locally" is not a constant:
	      // a sandboxed session does not run in the checkout the same way.
	      const panelSandboxed = panelDiagnostics?.sandboxEnabled ?? false
	      // P4-24c — the LIVE composer run-controls seam (Model/effort/fast + the
	      // real picker options), re-broadcast on every change so the faces reflect
	      // this session's current state with no respawn. Supersedes the P4-24 read
	      // from the spawn-frozen diagnostics snapshot for the composer faces.
	      // LIVE, so it disarms with the process; the values the faces DISPLAY come
	      // off `rail`, which does not.
	      const panelRunControls = rail.liveRunControls
	      // Per-category context occupancy for the donut popover; null until the
	      // sidecar has produced one for this session.
	      const panelContextBreakdown = selectContextBreakdown(
	        contextBreakdown,
	        sessionId,
	      )
	      const panelProvider = rail.provider
	      const panelLeases = selectLeaseSnapshot(leases, sessionId)
	      const panelLastMainFailoverAccountId = selectLastMainFailoverAccountId(
	        leases,
	        sessionId,
	      )
	      // The face names the account this session ROUTES through, which is its
	      // main lease, not the pool's persisted active row. See
	      // `selectSessionCodexAccount` for why the two drift.
	      const panelActiveCodexAccount =
	        panelProvider === 'openai'
	          ? selectSessionCodexAccount({
	              roster: panelAccounts,
	              leases: panelLeases,
	              lastMainFailoverAccountId: panelLastMainFailoverAccountId,
	              accounts,
	              sessionId,
	            })
	          : null
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
	            /* P4-32b read seam, reused: the agent card names the Codex account
	             * its worker holds. This pane's own session, not the active one. */
	            leases={panelLeases}
	            accountsSnapshot={panelAccounts}
	            activeAccount={panelActiveCodexAccount}
	            activeAnthropicAccount={panelActiveAnthropicAccount}
	            accountsLastResult={accounts.lastResult}
            turnStartedAt={turnStarts.get(sessionId) ?? null}
            onSwitchAccount={rail.canSwitchAccount ? verb => {
              // The composer profile popover's switch — the engine's own
              // `account.switch` verb to THIS pane's sidecar (its sessionId, not
              // the globally-active one), mirroring the run-control verbs. The
              // renderer only NAMES the id; the sidecar re-resolves it (T6).
              // The verb (with its correlation requestId) is minted by
              // SessionPane itself (ACCT-5) so it can track the same id it
              // dispatches here against `accounts.lastResult`.
              try {
                getBridge().accountVerb(sessionId, verb)
                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
              } catch (error) {
                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
              }
            } : undefined}
            onManageAccounts={() => setActiveView('accounts')}
            onOpenAccountSwitcher={() => getBridge().refreshAccountsPool()}
	            activeConnection={sessionConnection}
	            activeDescriptor={descriptor}
	            activeLog={sessionLog}
	            activeSessionId={sessionId}
                isActivePane={sessionId === activeSessionId}
                composerFocusRequest={composerFocusRequests[sessionId]}
                preview={panelTranscript.preview}
                onMessageAction={
                  !panelTranscript.preview &&
                  connectionHasEngine(sessionConnection.status)
                    ? handleMessageAction
                    : undefined
                }
                onPreviewEngage={() => engagePreview(sessionId)}
                previewRunFacts={panelTranscript.runFacts}
	            branch={panelBranch}
	            sandboxed={panelSandboxed}
	            model={rail.model}
	            modelLabel={rail.modelLabel}
	            reasoningEffort={rail.reasoningEffort}
	            fastMode={rail.fastMode}
	            contextWindow={rail.contextWindow}
	            lastPermissionMode={rail.lastPermissionMode}
	            runControls={panelRunControls}
	            contextBreakdown={panelContextBreakdown}
	            // Only a pane with an engine behind it can be asked. The donut is
	            // the one composer face that renders without one: it reads cached
	            // run facts on a preview, where every sibling face is blank because
	            // its live seam is null. So it is the only face that could send a
	            // verb to a session the supervisor does not have, and that reply is
	            // a `session_not_found` error frame, which the connection reducer
	            // maps to `dead`. Opening the popover on a previewed or finished
	            // session therefore raised "This session is no longer available"
	            // over a good cached transcript and released any parked prompt. The
	            // percentage still shows; only the recompute is withheld.
	            //
	            // The gate asks `connectionHasEngine`, not "is it terminal": an
	            // idle-PARKED session is deliberately non-terminal and still has no
	            // process, so the terminal test alone would have re-opened this exact
	            // bug on the one state that most looks fine.
	            onRequestContextBreakdown={
		              panelTranscript.preview ||
		              !connectionHasEngine(sessionConnection.status)
	                ? undefined
	                : () => {
	                    // Best-effort: the analysis is expensive and its absence
	                    // degrades to the aggregate row, so a transport failure
	                    // must not raise a transport-error banner the way a
	                    // user-initiated WRITE verb does.
	                    try {
	                      getBridge().contextBreakdownVerb(sessionId, {
	                        type: 'context-breakdown.request',
	                        requestId: newRequestId(),
	                      })
	                    } catch {
	                      // no-op: the popover keeps the snapshot it already has
	                    }
	                  }
	            }
            // The donut's Compact row. `/compact` is an ordinary slash submit:
            // the sidecar loads the real command catalog and the engine parses
            // and runs it (`sessionController.ts:306`), and the composer's own
            // picker only ever fills draft TEXT (`pickSlashCommand`), so this
            // string is byte-identical to a typed one.
            //
            // It deliberately does NOT go through the composer draft.
            // `submitSession` sends whatever the draft holds and then retires it
            // — clearing the text, DROPPING that session's collapsed-paste
            // entries, and pushing the sent string into ↑/↓ history. Routing a
            // button through it would destroy a half-typed prompt and its
            // attachments to send a word the user never typed. Appending is not
            // an option either: `parseSlashDraft` matches a whole-draft `/token`
            // only, so `text /compact` would reach the model as prose.
            //
            // Unconditional here: the pane gates it on the same `composerGate`
            // the send arrow reads, which is strictly tighter than the
            // preview/has-engine test its sibling `onRequestContextBreakdown`
            // needs (that one is reachable on a preview pane; this is not).
            onCompact={() => {
              try {
                getBridge().submit(sessionId, '/compact')
                setTransportErrors(prev =>
                  reduceTransportErrorCleared(prev, sessionId),
                )
              } catch (error) {
                // User-initiated, so a failure surfaces the way a failed send
                // does rather than vanishing.
                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
              }
            }}
            slashCatalog={panelSlashCatalog}
	            onSetModel={model => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'model.set',
	                  requestId: newRequestId(),
	                  model,
	                })
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
	              }
	            }}
	            onSetEffort={effort => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'effort.set',
	                  requestId: newRequestId(),
	                  effort,
	                })
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
	              }
	            }}
	            onSetFast={active => {
	              try {
	                getBridge().runControlVerb(sessionId, {
	                  type: 'fast.set',
	                  requestId: newRequestId(),
	                  active,
	                })
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
	              }
	            }}
			            workers={panelWorkers}
		            tasksSnapshot={panelTasks}
		            onBackgroundSubagent={toolUseId => {
		              try {
		                getBridge().taskControlVerb(sessionId, {
		                  type: 'task.background.one',
		                  requestId: newRequestId(),
		                  toolUseId,
		                })
		                setTransportErrors(prev =>
		                  reduceTransportErrorCleared(prev, sessionId),
		                )
		              } catch (error) {
		                setTransportErrors(prev =>
		                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
		                )
		              }
		            }}
	            onOpenTasks={openTasksDialog}
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
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
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
	            askPendingCount={sessionAskPendingCount}
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
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                dispatchPermission({
	                  type: 'submissionFailed',
	                  sessionId,
	                  requestId,
	                })
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
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
	            permissionContext={selectPermissionContext(permissions, sessionId)}
	            permissionKeyTargetRequestId={
	              sessionId === activeSessionId
	                ? permissionKeyTargetRequestId
	                : null
	            }
	            permissionQueue={sessionDisplayQueue}
	            snoozePermission={requestId => {
	              dispatchPermission({
	                type: 'dismissed',
	                sessionId,
	                requestId,
	              })
	            }}
	            planReview={sessionPlanReview}
	            prompt={selectPromptDraft(promptDrafts, sessionId)}
	            restorePermission={requestId => {
	              dispatchPermission({
	                type: 'restored',
	                sessionId,
	                requestId,
	              })
	            }}
	            revealHidden={revealHiddenSessions[sessionId] === true}
	            scrollAnchor={selectTranscriptScrollAnchor(
	              transcriptScrollMemoryRef.current,
	              sessionId,
	            )}
	            onScrollAnchorChange={anchor =>
	              rememberTranscriptScroll(sessionId, anchor)
	            }
	            historyLoadEarlierPending={selectHistoryLoadEarlierPending(
	              historyLoadEarlier,
	              sessionId,
	            )}
	            historyLoadEarlierFailure={selectHistoryLoadEarlierFailure(
	              historyLoadEarlier,
	              sessionId,
	            )}
	            // The same gate its sibling `onRequestContextBreakdown` uses, and
	            // for the same reason: only a pane with a process behind it can be
	            // asked anything. A cached preview and a parked or dead session
	            // both keep the truncation row — the row states a fact about the
	            // transcript — and neither gets the control, because there is
	            // nobody to send the ask to. Engaging with the session is what
	            // gains it (decisions/HISTORY-LOAD-EARLIER.md).
	            onLoadEarlierHistory={
	              panelTranscript.preview ||
	              !connectionHasEngine(sessionConnection.status)
	                ? undefined
	                : () => {
	                    const requestId = newRequestId()
	                    setHistoryLoadEarlier(prev =>
	                      reduceHistoryLoadEarlierState(prev, {
	                        type: 'requested',
	                        sessionId,
	                        requestId,
	                      }),
	                    )
	                    try {
	                      getBridge().loadEarlierHistory(sessionId, {
	                        type: 'history.loadEarlier',
	                        requestId,
	                      })
	                    } catch {
	                      // User-initiated, so it says so where it was pressed
	                      // instead of leaving the control spinning forever. No
	                      // retry from here: pressing again is the retry.
	                      setHistoryLoadEarlier(prev =>
	                        reduceHistoryLoadEarlierState(prev, {
	                          type: 'unreachable',
	                          sessionId,
	                          requestId,
	                        }),
	                      )
	                    }
	                  }
	            }
	            setPermissionMode={mode => {
	              try {
	                getBridge().setPermissionMode(sessionId, mode)
	                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
	              } catch (error) {
	                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
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
	            images={selectImageAttachments(imageAttachmentState, sessionId)}
            fileAttachment={selectFileAttachment(fileAttachmentState, sessionId)}
	            pendingSubmit={selectPendingSubmit(pendingSubmits, sessionId)}
	            queuedPrompts={selectQueuedPrompts(queuedPrompts, sessionId)}
	            onRecallQueuedPrompts={() => recallQueuedPrompts(sessionId)}
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
	            onRemovePaste={(entry, at) =>
	              removeSessionPaste(
	                sessionId,
	                selectPromptDraft(promptDrafts, sessionId),
	                entry,
	                at,
	              )
	            }
	            onAttachImage={attachment =>
	              setImageAttachmentState(prev =>
	                reduceImageAttachmentAdded(prev, sessionId, attachment),
	              )
	            }
	            onRemoveImage={id =>
	              setImageAttachmentState(prev =>
	                reduceImageAttachmentRemoved(prev, sessionId, id),
	              )
	            }
            onAttachFile={attachment =>
              setFileAttachmentState(prev =>
                reduceFileAttachmentSelected(prev, sessionId, attachment),
              )
            }
            onRemoveFile={() =>
              setFileAttachmentState(prev =>
                reduceFileAttachmentRemoved(prev, sessionId),
              )
            }
		            transcript={panelTranscript.transcript}
	            transportError={selectTransportError(transportErrors, sessionId)}
	            releasePendingSubmit={() => releasePendingSubmit(sessionId)}
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
        rows: visibleShellDescriptors,
        activeSessionId,
        hasPanels: workspacePanels.length > 0,
        slashCatalog: selectSlashCatalog(slashCatalog, activeSessionId) ?? [],
        recentItemIds: recentPaletteItemIds,
        handlers: {
          // Labelled ⌘T in the palette, so it must match the chord exactly.
          newSession: () => void newChat(),
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
          openTasks: () => openTasksDialog(),
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
    <AgentFaceRegistryStoreContext.Provider value={faceRegistries}>
    <AgentFaceRegistryContext.Provider value={faceRegistry}>
      {/* `data-window-ground`: this frame repeats the page ground that `html`
       * and `body` already paint. Harmless while they are opaque, and marked so
       * glass mode can stop the three from compounding (`theme.css`). */}
      <div
        className="flex h-screen flex-col bg-app-bg font-sans text-text-primary"
        data-window-ground
      >
        {/* The window's top row, and the app's title bar: `hiddenInset`
         * (`main.ts` `createWindow`) removes the OS strip, so the tab bar spans
         * the full width at y=0 and reserves the well the traffic lights are
         * drawn into. It sits ABOVE the rail rather than beside it for that
         * reason alone — the lights own the top-left corner, which the rail
         * cannot yield while it is also a full-height column. */}
        <TabBar
          tabs={tabs}
          activeSessionId={activeSessionId}
          onSelect={selectTab}
          onClose={closeTab}
          onRestart={restartTab}
          onNewTab={newChat}
          onOpenActions={(sessionId, anchor) =>
            setSessionActionsTarget({ sessionId, anchor, origin: 'tab' })
          }
          panelCount={workspaceLayout.panels.length}
          canAddPanel={paneSessionIds.length > workspaceLayout.panels.length}
          onAddPanel={addWorkspacePanel}
          onRemovePanel={removeWorkspacePanel}
        />

        <div className="flex min-h-0 flex-1">
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
          onNewChat={() => void newChat()}
          /* The Projects header's "+": the native picker, so the renderer never
           * authors a cwd (HC1). The session created in the chosen folder is what
           * makes the group appear — there is no empty-workspace record to keep. */
          onAddProject={() => void newSession()}
          accountAlias={
            selectActiveAccount(selectGlobalAccountsSnapshot(accounts))?.alias ??
            null
          }
          /* The passive half of the account-health treatment. The pinned bar
           * above the transcript stays reserved for a pool with nothing left to
           * fail over to (STARTUP-GATES #12); one dead account among healthy ones
           * is marked here instead, where acting on it is one click away. */
          accountsNeedingSignIn={selectAccountsNeedingSignIn(
            selectGlobalAccountsSnapshot(accounts),
          )}
        />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* P4-6b — the tab ⋯ actions overflow + its MetadataInspector drawer +
           * inline rename editor. The menu resolves and acts against the row it was
           * OPENED for (`sessionActionsTarget.sessionId`), never the active tab.
           * rename/export dispatch the real WRITE verbs to that session's
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
                    items={(() => {
                      // The shared menu component stays presentation-only; the
                      // per-entry-point hide list is a resolver decision
                      // (`selectSessionsPageActions`, which is where it is tested).
                      const items = resolveSessionActions(targetRow, {
                        isActiveOpen: targetId === activeSessionId,
                        hasEngine: connectionHasEngine(
                          selectConnection(connection, targetId).status,
                        ),
                        hasActiveTurn:
                          selectConnection(connection, targetId).status === 'ready' &&
                          !selectConnection(connection, targetId).inputEnabled,
                        // P4-36 — read the tier straight off the transcript slice, so
                        // the row appears only for a session that really has hidden
                        // messages (and only while the menu is open, which is the
                        // only time this is computed).
                        hasHiddenRows: selectHasHiddenRows(transcript, targetId),
                        hiddenRevealed: revealHiddenSessions[targetId] === true,
                      })
                      return sessionActionsTarget.fromSessionsPage
                        ? selectSessionsPageActions(items)
                        : items
                    })()}
                    anchor={sessionActionsTarget.anchor}
                    onAction={kind => {
                      if (kind === 'metadata') setMetadataOpen(true)
                      // `copy` is the flyout HOST and is never dispatched; P4-30
                      // split the real action out as `copy-text`.
                      else if (kind === 'copy-text') copyForLlm(targetId)
                      // Reads the catalog row only, so it answers for ANY row —
                      // including a closed or history one the renderer holds no
                      // transcript for.
                      else if (kind === 'copy-ids') copySessionIds(targetRow)
                      // P4-36 — transcript mode for THIS session. Purely a read
                      // preference; nothing is sent to the engine.
                      else if (kind === 'reveal-hidden')
                        setRevealHiddenSessions(current => ({
                          ...current,
                          [targetId]: true,
                        }))
                      else if (kind === 'hide-hidden')
                        setRevealHiddenSessions(current => {
                          const next = { ...current }
                          delete next[targetId]
                          return next
                        })
                      // PEER-SESSIONS §6 — the user's standing decision about
                      // whether a peer may reopen this session. Sends the id and
                      // the OPPOSITE of the state the row is showing, and nothing
                      // else; the new state comes back on the row's own host
                      // update, so there is no optimistic local write to disagree
                      // with what was actually persisted.
                      else if (kind === 'peer-wake-blocked')
                        void setPeerWakeBlocked(
                          targetId,
                          targetRow.peerWakeBlocked !== true,
                        )
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
                      }
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
                          // P4-35 — the file sink. The renderer hands over the
                          // engine-rendered text plus the derived name as a
                          // SUGGESTION; main asks the user where it goes (HC1).
                          onDownload: () => {
                            void saveTranscript(
                              preview.text,
                              exportFileName(exportDialog.title),
                              'Transcript saved',
                            ).finally(() =>
                              dispatchSessionActionRuntime({
                                type: 'discard-result',
                                sessionId: exportDialog.sessionId,
                                requestId: exportDialog.requestId,
                              }),
                            )
                          },
                        }
                      : {})}
                    onClose={() => {
                      dispatchSessionActionRuntime({
                        type: 'discard-result',
                        sessionId: exportDialog.sessionId,
                        requestId: exportDialog.requestId,
                      })
                      setLatchedExport(null)
                      setExportDialog(null)
                    }}
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
                runControls: selectRunControlsSnapshot(
                  runControls,
                  activeSessionId,
                ),
              })}
              log={selectRawMessageLog(state, activeSessionId)}
              tasks={selectTasksSnapshot(tasks, activeSessionId)}
              onClose={() => setMetadataOpen(false)}
            />
          ) : null}

          {shellError ? (
            <div className="flex items-center gap-3 border-b border-shell-seam bg-shell-chrome px-6 py-1.5 text-xs text-tone-danger">
              <span className="min-w-0 flex-1">{shellError}</span>
              <button
                type="button"
                onClick={() => setShellError(null)}
                title="Dismiss"
                aria-label="Dismiss shell error"
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-sm leading-none text-text-subtle transition-colors hover:text-text-primary"
              >
                ×
              </button>
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
              agentsSnapshot={selectAgentConfigSnapshot(agentConfig, activeSessionId)}
              cwd={activeSessionId ? tabDescriptorsById.get(activeSessionId)?.cwd ?? null : null}
              extensionsSnapshot={selectExtensionsSnapshot(extensions, activeSessionId)}
              initialCategory="agents"
              memorySnapshot={selectMemorySnapshot(goalMemory, activeSessionId)}
              onRemoteVerb={sendRemoteSettingsVerb}
              onOpenLogs={() => getBridge().openLogsFolder()}
              onSaveDiagnostics={() => void getBridge().saveDiagnosticsBundle()}
              onSettingWrite={sendSettingWrite}
              remoteLastResult={remoteSettings.lastResult}
              remoteSnapshot={selectRemoteSettingsSnapshot(remoteSettings, activeSessionId)}
              projectBinding={settingsProjectBinding}
              snapshot={selectSettingsSnapshot(settings, activeSessionId)}
            />
          ) : activeView === 'goals' ? (
            <GoalsPage rows={selectThreadGoalRows(goalMemory, sessionCatalogRows)} />
          ) : activeView === 'accounts' ? (
            <AccountsPage
              snapshot={selectGlobalAccountsSnapshot(accounts)}
              lastResult={accounts.lastResult}
              usageStats={selectUsageStatsForRange(accounts)}
              activeStatsRange={accounts.activeStatsRange}
              signOutOverlays={accounts.signOutOverlays}
              onRangeChange={handleStatsRangeChange}
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
              // The row `⋯` menu gates Rename/Export on this same frame-plane
              // check (`App.tsx` `hasEngine:` above, `sessionActions.ts`
              // `resolveSessionActions`); the page's own write boundary
              // (`isWritableSessionRow`) needs it too, so a row the host still
              // calls live but whose socket has gone `disconnected` is not
              // offered a write the supervisor will refuse.
              hasEngine={appSessionId =>
                connectionHasEngine(selectConnection(connection, appSessionId).status)
              }
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
                  if (!isWritableSessionRow(row)) continue
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
              onExportRows={targets => {
                // P4-35 — one verb per LIVE row, which is what the bar's own
                // disabled reason already tells the user. Each export is rendered by
                // that session's OWN engine (N-process, LOCKED); the results are
                // folded into one file by the effect above.
                const requests: BulkExportRequest[] = []
                for (const row of targets) {
                  if (!isWritableSessionRow(row)) continue
                  const requestId = newRequestId()
                  requests.push({
                    sessionId: row.appSessionId,
                    requestId,
                    title: row.title ?? null,
                  })
                  // Claimed here so the general result effect stays silent: this
                  // batch reports itself ONCE, when the file is written.
                  rememberToastedActionRequest(
                    toastedActionRequestsRef.current,
                    requestId,
                  )
                  sendSessionActionVerb(row.appSessionId, {
                    type: 'session.export',
                    requestId,
                  })
                }
                // Bounded by MAX_LIVE_SESSIONS (32) live engines, comfortably under
                // the inbound rate cap, so a select-all cannot trip T7.
                pendingBulkExportRef.current = requests.length > 0 ? requests : null
                if (requests.length === 0) {
                  toast('Open or restore a session to export it.', { tone: 'warn' })
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
            // derived recents (D5) + the P4-5 pool, and wires open/restore/
            // open-from-history (HC1 id-only, P4-40) and the HC1 folder picker
            // (post-spawn trust gate).
            <WelcomeScreen
              recents={welcomeRecents}
              accounts={activeAccountsSnapshot ?? selectGlobalAccountsSnapshot(accounts)}
              onOpenRecent={openRecentWorkspace}
              onOpenFolder={() => void newSession()}
              rosterFailure={
                rosterBootstrap.status === 'failure'
                  ? {
                      retrying: rosterBootstrap.retrying,
                      onRetry: () => void hydrateHostRoster(),
                    }
                  : undefined
              }
            />
          ) : (
            /* P4-50 (O2a) — the account-health bar is pinned HERE, above the
             * transcript, rather than left to scroll away inside it. It sits in
             * the chat branch alone, so it never doubles the Accounts page's own
             * cap row, and OUTSIDE `WorkspaceLayout`, so a split view shows one
             * bar rather than one per pane. It is a sibling of the transcript and
             * never of the composer: nothing here can gate a send. Shell lifecycle
             * errors keep their own surface (`shellError` above) and are not
             * routed into this plane. */
            <div className="flex min-h-0 flex-1 flex-col">
              <BannerStack
                banners={accountHealthBanners}
                onAction={() => setActiveView('accounts')}
                onDismiss={banner => setDismissedAccountHealthId(banner.id)}
              />
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
            </div>
          )}

          {/* In-session background-task strip (P4-9). The prototype's `TasksPanel`
           * is unanchored GUI (⚓0, INVENTORY §W4), not this dialog's entry point.
           * This pill is the grounded analog: the real
           * footer summary pill (`BackgroundTaskStatus.tsx`, `getPillLabel`),
           * scoped to the active session, opening the same TasksDialog ⌘K does. */}
          {activeView === 'chat' && activeSessionId ? (
            <TasksStrip
              snapshot={selectTasksSnapshot(tasks, activeSessionId)}
              workers={activeLiveWorkersSnapshot?.workers ?? EMPTY_WORKERS}
              onOpen={() => openTasksDialog()}
            />
          ) : null}
        </div>
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
          onClose={closeTasksDialog}
          snapshot={selectTasksSnapshot(tasks, activeSessionId)}
          hasActiveSession={activeSessionId !== null}
          onStopTask={activeSessionId ? sendStopTask : undefined}
          onDismissTask={activeSessionId ? sendDismissTask : undefined}
          /* P4-32b — the Workers + Leases tabs of the same dialog: the read-only
           * worker drilldown (inspection ruling D1) and the session-scoped Codex
           * lease roster (L1). Both are read seams; no verb rides them. */
          workers={selectLiveWorkersSnapshot(workersState, activeSessionId)}
          leases={selectLeaseSnapshot(leases, activeSessionId)}
          /* CC-84 — the worker the docked roster was clicked on, so the dialog
           * opens on that worker's detail instead of the generic list. Null for
           * every other entry point (⌘K, the footer pill). */
          focusAgentId={tasksFocusAgentId}
        />
      </div>
    </AgentFaceRegistryContext.Provider>
    </AgentFaceRegistryStoreContext.Provider>
  )
}

/**
 * The real `BackgroundTaskStatus.tsx` footer pill, adapted: a compact count of
 * active background tasks for the current session, opening `TasksDialog` on
 * click. Renders nothing when there is nothing active (same as the source
 * component returning `null`, `BackgroundTaskStatus.tsx:195-197`).
 *
 * P4-32a (ruling P1) — this ONE strip also carries the prototype's `bgTaskPill`
 * attention semantics; the slot has an owner, so there is no second pill (CC-5
 * rule #10). A worker waiting on the assistant stays neutral.
 *
 * The two feeds overlap, so they are reconciled rather than summed: a delegated
 * `local_agent` shows up in the tasks snapshot AND in the worker list,
 * so the task half counts only NON-worker task types and the worker half comes
 * from the worker feed alone. Nothing is counted twice.
 *
 * Two prototype gaps are inherited from the P4-9 shell that P1 said to KEEP, and
 * are recorded on the ledger row rather than fixed here: the prototype's pill
 * inverts on hover (fills with its own colour, text going dark,
 * `TasksPanel` hover treatment) where this one only lifts its text; and its
 * neutral tone is the agent purple `#c084fc` where this one uses the theme
 * `accent`. Changing either would restyle P4-9's button, not extend its semantics.
 */
export function TasksStrip({
  snapshot,
  workers,
  onOpen,
}: {
  snapshot: ReturnType<typeof selectTasksSnapshot>
  workers: readonly LiveWorkerItem[]
  onOpen: () => void
}) {
  const pill = workersPill(workers)
  const hasBackgroundWorker =
    summarizeWorkers(workers).background > 0
  const backgroundTasks = groupTaskItems(snapshot).active.filter(
    item => item.type !== 'local_agent',
  )
  if (!pill && backgroundTasks.length === 0) return null
  return (
    <button
      className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-shell-seam bg-shell-chrome px-3 py-1.5 text-xs text-text-muted shadow-[var(--elev-popover)] hover:text-text-primary"
      onClick={onOpen}
      type="button"
    >
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
        aria-hidden="true"
      />
      {pill ? (
        <>
          {hasBackgroundWorker ? (
            <>
              <span className="text-accent">Background</span>
              <span aria-hidden="true" className="text-text-ghost">
                ·
              </span>
            </>
          ) : null}
          <span>{pill.label}</span>
        </>
      ) : null}
      {pill && backgroundTasks.length > 0 ? (
        <span aria-hidden="true" className="text-text-ghost">
          ·
        </span>
      ) : null}
      {backgroundTasks.length > 0 ? (
        <span>
          {backgroundTasks.length} background{' '}
          {backgroundTasks.length === 1 ? 'task' : 'tasks'}
        </span>
      ) : null}
    </button>
  )
}


/** Stable empty inventory for the closed palette — a fresh `[]` each render would
 * bust the palette's `useMemo(filter)` identity check for no reason. */
const EMPTY_PALETTE_ITEMS: PaletteItem[] = []

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
    return mergeRosterSnapshot(state, action.sessions, action.removed)
  }
  if (action.type === 'event') return reduceShellState(state, action.event)
  return reduceShellState(state, action)
}
