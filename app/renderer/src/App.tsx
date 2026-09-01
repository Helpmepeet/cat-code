import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import { PermissionQueue } from './PermissionQueue.js'
import { selectContextUsage } from './contextUsage.js'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import { focusFirstComposerFace } from './composerActionsBarModel.js'
import { ComposerInput } from './ComposerInput.js'
import { TodoStepReadout } from './TodoPlanPanel.js'
import { selectTodoPlan, selectTodoReadout } from './todoPlan.js'
import type { TodoPlan } from './todoPlan.js'
import type { ComposerInputHandle } from './ComposerInput.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectLastPermissionMode,
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
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  createTranscriptState,
  selectHasHiddenRows,
  selectIsCompacting,
  selectNestedTranscriptRows,
  selectSlashCommands,
  selectTranscriptRows,
  type NestedTranscriptRow,
  type TranscriptRow,
  type TranscriptState,
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
  type PreviewRunFacts,
} from './previewTranscriptState.js'
import {
  STARTUP_PRELOAD_MAX_SESSIONS,
  calculateStartupPreloadCapacity,
  estimateProjectedPreviewBytes,
  runStartupTranscriptPreload,
  selectStartupPreloadCandidates,
} from './sessionPreload.js'
import {
  TranscriptView,
  type MessageActionHandler,
  type RestorePhase,
} from './TranscriptView.js'
import { observePaneBottomLock } from './markdownScrollCoordinator.js'
import {
  captureTranscriptScrollAnchor,
  createTranscriptScrollCapturePump,
  createTranscriptScrollMemoryState,
  reduceTranscriptScrollMemoryState,
  restoreTranscriptScroll,
  selectTranscriptScrollAnchor,
  type TranscriptScrollAnchor,
  type TranscriptScrollCapturePump,
  type TranscriptScrollMemoryState,
} from './transcriptScrollMemory.js'
import {
  createHistoryLoadEarlierState,
  reduceHistoryLoadEarlierState,
  selectHistoryLoadEarlierFailure,
  selectHistoryLoadEarlierPending,
  type HistoryLoadEarlierState,
} from './historyLoadEarlierState.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import {
  MENTION_LISTBOX_ID,
  SLASH_COMMAND_LISTBOX_ID,
  mentionOptionId,
  slashCommandOptionId,
} from './composerTypeaheadA11y.js'
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
  buildSubmitPrompt,
  createFileAttachmentState,
  caretAtHistoryEdge,
  createHistoryState,
  createImageAttachmentState,
  createPasteState,
  canSendUntypedSubmit,
  createPendingSubmitState,
  createRetainedSubmitState,
  createTransportErrorState,
  EMPTY_HISTORY_NAV,
  foldRecalledPrompts,
  formatPasteRef,
  navigateHistory,
  parseMentionQuery,
  pasteTokenBeforeCaret,
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
  restoreDraftWithPending,
  selectAgentMentionItems,
  selectComposerGate,
  selectFileAttachment,
  selectHistory,
  selectImageAttachments,
  selectPendingSubmit,
  selectSessionPasteList,
  selectSessionPasteState,
  selectTransportError,
  shouldCollapsePaste,
  shouldRecallWaitingMessages,
  shouldReleasePendingSubmitOnStop,
  type DraftWriteReason,
  type FileAttachment,
  type FileAttachmentState,
  type HistoryNav,
  type HistoryState,
  type ImageAttachment,
  type ImageAttachmentState,
  type PasteEntry,
  type PasteState,
  type PendingSubmit,
  type PendingSubmitState,
  type RetainedSubmit,
  type RetainedSubmitState,
  type TransportErrorState,
} from './composerState.js'
import {
  ACCEPTED_IMAGE_TYPES,
  prepareImageAttachment,
} from './imageAttachment.js'
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
  connectionRecoveryMessage,
  connectionTone,
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
  selectFirstAccountsSnapshot,
  selectLastAccountsSnapshot,
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
  selectLastRunControlsSnapshot,
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
  createOrchestratorState,
  orchestratorPill,
  reduceOrchestratorState,
  selectAgentModeSnapshot,
  selectDockedOrchestratorWorkers,
  summarizeOrchestratorWorkers,
} from './orchestratorState.js'
import {
  AgentFaceRegistryContext,
  AgentFaceRegistryStoreContext,
  useAgentFaceRegistryStore,
} from './agentFace.js'
import {
  createLeaseState,
  reduceLeaseState,
  selectLeaseSnapshot,
} from './leaseState.js'
import { OrchestratorRoster } from './OrchestratorRoster.js'
import { GoalsPage } from './GoalsPage.js'
import { AccountsPage } from './AccountsPage.js'
import {
  loginVerb,
  oauthAliasVerb,
  oauthCancelVerb,
  oauthPasteCodeVerb,
  resultToastTone,
  selectAccountsNeedingSignIn,
  switchVerb,
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
  AccountResultFrame,
  AccountStatus,
  AccountsSnapshot,
  AnthropicAccountStatus,
  AccountSwitchMessage,
  AccountVerbMessage,
  AgentModeWorkerItem,
  AskUserQuestionAnswer,
  LeaseSnapshot,
  PermissionResponseInput,
  PermissionSetModeMode,
  QueuedPromptItem,
  RecalledPrompt,
  RemoteVerbMessage,
  RunControlsSnapshot,
  ContextBreakdownSnapshot,
  SessionActionVerbMessage,
  SessionId,
  SlashCatalogEntry,
  TasksSnapshot,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../../shared/protocol.js'
import type {
  HostEvent,
  SessionDescriptor,
} from '../../shared/hostApi.js'
import {
  buildDebugExport,
  claimOAuthContextForAccountLogin,
  deriveActivity,
  fmtElapsed,
  fmtTok,
  hostErrorMessage,
  isTurnRunning,
  reducePromptDrafts,
  reduceTurnStarts,
  restartConnection,
  selectLiveTokenEstimate,
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
const reduceLeaseStateBatched = withBatch(reduceLeaseState)
const reduceAccountsStateBatched = withBatch(reduceAccountsState)
const reduceWorkspaceTrustStateBatched = withBatch(reduceWorkspaceTrustState)
const reduceDiagnosticsStateBatched = withBatch(reduceDiagnosticsState)
const reduceRunControlsStateBatched = withBatch(reduceRunControlsState)
const reduceContextBreakdownStateBatched = withBatch(reduceContextBreakdownState)
const reduceSlashCatalogStateBatched = withBatch(reduceSlashCatalogState)
const reduceQueuedPromptsStateBatched = withBatch(reduceQueuedPromptsState)
/** Stable empty list so a session with nothing waiting keeps one identity. */
const EMPTY_QUEUED_PROMPTS: readonly QueuedPromptItem[] = []
/** Stable empty catalog so an omitted `slashCatalog` prop keeps one identity. */
const EMPTY_SLASH_CATALOG: readonly SlashCatalogEntry[] = []
/** Stable empty notice list so a healthy pool re-renders nothing (P4-50). */
const EMPTY_BANNERS: readonly BannerNotice[] = []
/** Stable identity so a session with no orchestrator snapshot never re-renders. */
const EMPTY_WORKERS: readonly AgentModeWorkerItem[] = []
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
  const [orchestrator, dispatchOrchestrator] = useReducer(
    reduceOrchestratorStateBatched,
    undefined,
    createOrchestratorState,
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
  // list. The docked roster raises its `agentId` (`OrchestratorRoster.tsx`
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
              dispatchOrchestrator,
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
      for (const { sessionId, retained } of answers.restored) {
        restoreRefusedSubmit(sessionId, retained)
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
        dispatchOrchestrator({ type: 'session-removed', sessionId: event.appSessionId })
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
  // P4-32a — the active session's orchestrator snapshot, read once for the docked
  // roster and the footer strip so both read one truth (never two derivations of
  // the same workers).
  const activeAgentModeSnapshot = selectAgentModeSnapshot(
    orchestrator,
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
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

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
    const result = focusOrAssignWorkspaceSession(workspaceLayout, sessionId)
    setWorkspaceLayoutState(result.state)
    setLayoutNotice(null)
    setActiveSessionId(sessionId)
    setActiveView('chat')
  }, [workspaceLayout])

  // Session-local account controls still address their pane's sidecar. Deleting
  // a saved profile is global durable state instead, so the Accounts page sends
  // that one verb to main's session-independent engine worker.
  const sendAccountVerb = useCallback(
    (verb: AccountVerbMessage) => {
      if (verb.type === 'account.delete') {
        void getBridge()
          .deleteAccount(verb)
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
                verb: 'account.delete',
                ok: false,
                message: 'Could not delete that account.',
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

  // Retire a FINISHED worker row the engine's grace deadline will never retire on
  // its own (a blocked handoff carries no `evictAfter`). Same trust shape as the
  // stop above: the renderer names only the taskId, and the sidecar runs the
  // engine's own dismiss + eviction. The row's disappearance rides the resulting
  // `agent-mode.snapshot` re-broadcast, not this call.
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
      setPromptDrafts(current =>
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
    setPromptDrafts(drafts =>
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
  // The attachments REPLACE whatever is attached now, the same way a released
  // parked prompt does: only one image is ever held
  // (`reduceImageAttachmentAdded`), and the refused one is the one the user is
  // waiting on. Text is merged instead, so a draft typed during the round trip
  // survives underneath it. `reduceSessionImagesRestored` is the guarded form:
  // an EMPTY `retained.images` means this submit never carried one, so it must
  // leave an image attached to the CURRENT draft alone rather than clear it.
  // The copy is handed IN rather than looked up: `reduceSubmitAnswers` already
  // retired exactly the entry this answer named, so there is nothing left here to
  // find and no head to take by mistake.
  const restoreRefusedSubmit = useCallback((
    sessionId: SessionId,
    retained: RetainedSubmit,
  ) => {
    setPromptDrafts(drafts =>
      reducePromptDrafts(
        drafts,
        sessionId,
        restoreDraftWithPending(
          selectPromptDraft(drafts, sessionId),
          retained.text,
        ),
      ),
    )
    setImageAttachmentState(state =>
      reduceSessionImagesRestored(state, sessionId, retained.images),
    )
    setFileAttachmentState(state =>
      reduceSessionFileAttachmentRestored(state, sessionId, retained.file),
    )
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
      setPromptDrafts(drafts =>
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

  const closeTab = useCallback(async (sessionId: SessionId) => {
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
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [releasePendingSubmit])

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
      setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, ''))
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
	      const panelPartialCount = sessionLog.messages.filter(
	        message => message.type === 'stream_event',
	      ).length
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
	      // engine reads the polled global feed rather than its own frozen copy) +
	      // its agent-mode active flag. Both are the SAME domain seams the reauth
	      // banner / WelcomeScreen already read.
	      const panelAccounts = rail.accountsSnapshot
	      const panelAgentMode = selectAgentModeSnapshot(orchestrator, sessionId)
	      const panelOrchestratorActive = panelAgentMode?.active ?? false
	      // P4-32a — this panel's OWN workers (never the globally-active session's),
	      // mirroring how the mode toggle dispatches per panel.
	      const panelOrchestratorWorkers = panelAgentMode?.workers ?? EMPTY_WORKERS
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
	            /* P4-32b read seam, reused: the agent card names the Codex account
	             * its worker holds. This pane's own session, not the active one. */
	            leases={selectLeaseSnapshot(leases, sessionId)}
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
	            orchestratorActive={panelOrchestratorActive}
		            orchestratorWorkers={panelOrchestratorWorkers}
		            tasksSnapshot={panelTasks}
		            onBackgroundTask={
		              panelTasks?.hasForegroundTask
		                ? () => {
		                    try {
		                      getBridge().taskControlVerb(sessionId, {
		                        type: 'task.background',
		                        requestId: newRequestId(),
		                      })
		                      setTransportErrors(prev =>
		                        reduceTransportErrorCleared(prev, sessionId),
		                      )
		                    } catch (error) {
		                      setTransportErrors(prev =>
		                        reduceTransportErrorSet(
		                          prev,
		                          sessionId,
		                          errorMessage(error),
		                        ),
		                      )
		                    }
		                  }
		                : undefined
		            }
	            onOpenTasks={openTasksDialog}
		            onToggleOrchestrator={next => {
		              // P4-8b — toggle THIS panel's session (its own sessionId, not
		              // the globally-active one), mirroring setPermissionMode's
		              // per-panel dispatch. The sidecar re-broadcasts
		              // agent-mode.snapshot, which flips the reflected `active`.
		              //
		              // Gated on there being an engine to ask. Every sibling control
		              // is gated implicitly, by going dead when its per-session
		              // snapshot nulls out on the lifecycle frame; this one is
		              // supplied unconditionally, so on an idle-PARKED pane (whose
		              // composer is deliberately live) it was the one click that
		              // could still reach a session with no process behind it.
		              if (!connectionHasEngine(sessionConnection.status)) return
		              try {
		                getBridge().setAgentMode(sessionId, next)
		                setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId))
		              } catch (error) {
		                setTransportErrors(prev =>
                  reduceTransportErrorSet(prev, sessionId, errorMessage(error)),
                )
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
	            partialCount={panelPartialCount}
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
          /* The row subtitle's "· model" reads the LIVE run-controls seam, which is
           * re-broadcast on every model change (P4-24c). The diagnostics snapshot is
           * spawn-frozen, so on its own it kept printing the model a session started
           * with after the picker moved it — it stays only as the pre-snapshot
           * fallback.
           *
           * `currentLabel` before `current`: the engine's own marketing name
           * ("Opus 5", "GPT-5.6 Sol"), the same string the composer face and the
           * picker row show, so a row and the chip above it never disagree. Only a
           * model the engine has no name for (a custom model, a Foundry deployment
           * id) falls back to the raw id. Operator ruling 2026-08-09: the row used
           * to print the id's last hyphen segment, which reads as a bare "5" for
           * every claude-* model. */
          modelForSession={id => {
            const live = selectRunControlsSnapshot(runControls, id)?.model
            return (
              live?.currentLabel ??
              live?.current ??
              selectDiagnosticsSnapshot(diagnostics, id)?.mainLoopModelForSession ??
              null
            )
          }}
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
            // derived recents (D5) + the P4-5 pool + agent-mode, wires open/restore/
            // open-from-history (HC1 id-only, P4-40) and the HC1 folder picker
            // (post-spawn trust gate).
            <WelcomeScreen
              recents={welcomeRecents}
              accounts={activeAccountsSnapshot ?? selectGlobalAccountsSnapshot(accounts)}
              orchestratorActive={
                selectAgentModeSnapshot(orchestrator, activeSessionId)?.active ?? false
              }
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
           * (OrchestratorMode.jsx) is unanchored GUI (⚓0, INVENTORY §W4) — it's
           * really P4-8's unbuilt orchestrator worker/lease roster, not this
           * dialog's entry point. This pill is the grounded analog: the real
           * footer summary pill (`BackgroundTaskStatus.tsx`, `getPillLabel`),
           * scoped to the active session, opening the same TasksDialog ⌘K does. */}
          {activeView === 'chat' && activeSessionId ? (
            <TasksStrip
              snapshot={selectTasksSnapshot(tasks, activeSessionId)}
              workers={activeAgentModeSnapshot?.workers ?? EMPTY_WORKERS}
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
          agentMode={selectAgentModeSnapshot(orchestrator, activeSessionId)}
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
 * rule #10). Amber ONLY when the human owns the next action: a worker waiting on
 * an active orchestrator is that orchestrator's problem and stays neutral (D2 C2).
 *
 * The two feeds overlap, so they are reconciled rather than summed: a delegated
 * `local_agent` shows up in the tasks snapshot AND in the agent-mode worker list,
 * so the task half counts only NON-worker task types and the worker half comes
 * from the worker feed alone. Nothing is counted twice.
 *
 * Two prototype gaps are inherited from the P4-9 shell that P1 said to KEEP, and
 * are recorded on the ledger row rather than fixed here: the prototype's pill
 * inverts on hover (fills with its own colour, text going dark,
 * `OrchestratorMode.jsx:396-397`) where this one only lifts its text; and its
 * neutral tone is the agent purple `#c084fc` where this one uses the theme
 * `accent`. Changing either would restyle P4-9's button, not extend its semantics.
 */
export function TasksStrip({
  snapshot,
  workers,
  onOpen,
}: {
  snapshot: ReturnType<typeof selectTasksSnapshot>
  workers: readonly AgentModeWorkerItem[]
  onOpen: () => void
}) {
  const pill = orchestratorPill(workers)
  const hasBackgroundWorker =
    summarizeOrchestratorWorkers(workers).background > 0
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

/**
 * One session pane — the P2 transcript spine + prompt + permission surfaces.
 * App supplies one instance per visible workspace panel, scoped to that panel's
 * session id; switching focus never tears down a background session's state.
 */
export function SessionPane({
  leases = null,
  accountsSnapshot,
  activeAccount,
  activeAnthropicAccount,
  onSwitchAccount,
  onManageAccounts,
  onOpenAccountSwitcher,
  accountsLastResult,
  activeConnection,
  turnStartedAt = null,
  activeDescriptor,
  branch,
  sandboxed,
  activeLog,
  activeSessionId,
  isActivePane,
  composerFocusRequest,
  preview = false,
  onPreviewEngage,
  onMessageAction,
  previewRunFacts = null,
  allowPermission,
  model,
  modelLabel = null,
  reasoningEffort,
  fastMode,
  contextWindow = null,
  lastPermissionMode = null,
  runControls,
  contextBreakdown = null,
  onRequestContextBreakdown,
  onCompact,
  slashCatalog = EMPTY_SLASH_CATALOG,
  onSetModel,
  onSetEffort,
  onSetFast,
  copyForLlm,
  denyPermission,
  history,
  images = [],
  mentionItems,
  onApprovePlan,
  onAttachImage,
  onPaste,
  onAttachFile,
  fileAttachment = null,
  onRemoveFile,
  onRemoveImage,
  onRemovePaste,
  onRevisePlan,
  askQuestion,
  askPendingCount,
  onAnswerQuestions,
  onCancelQuestions,
  orchestratorActive,
  onToggleOrchestrator,
  orchestratorWorkers = EMPTY_WORKERS,
  onOpenTasks,
  onBackgroundTask,
  tasksSnapshot = null,
  partialCount,
  pastes,
  pendingSubmit = null,
  onRecallQueuedPrompts = null,
  queuedPrompts = EMPTY_QUEUED_PROMPTS,
  permissionContext,
  permissionKeyTargetRequestId = null,
  permissionQueue,
  snoozePermission,
  planReview,
  prompt,
  releasePendingSubmit,
  restorePermission,
  revealHidden = false,
  scrollAnchor = null,
  onScrollAnchorChange,
  historyLoadEarlierPending = false,
  historyLoadEarlierFailure = null,
  onLoadEarlierHistory,
  setPermissionMode,
  setPrompt,
  submit,
  transcript,
  transportError,
}: SessionPaneProps) {
  const toast = useToast()
  // THIS pane's face registry, keyed on the pane's own session and never the
  // globally-active one. Split view renders up to MAX_WORKSPACE_PANELS panes
  // side by side on different sessions, and a single shell registry made them
  // spend one pool of ten identity colours between them, so a worker's face
  // depended on what an unrelated session had drawn first. Focusing a pane also
  // re-minted that registry without unmounting anyone, which re-rolled faces on
  // rows the reader had already settled on.
  //
  // No store above means this pane is standing alone (a test, or any future
  // mount outside the shell). Then it inherits whatever registry it was given,
  // which is what it did before, and null keeps the undeduped fallback.
  const faceStore = useContext(AgentFaceRegistryStoreContext)
  const inheritedFaces = useContext(AgentFaceRegistryContext)
  const paneFaces =
    faceStore === null ? inheritedFaces : faceStore.registryFor(activeSessionId)
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
  // The raw-log `error` field (rawMessageLog.ts) is never cleared by the store
  // itself — the retention notice it carries (e.g. history-replay truncation)
  // is informational, not a live fault, but nothing re-derives it false once
  // set. Dismissal is display-only and local to this pane, keyed by the exact
  // message so a genuinely NEW notice (different text) still shows.
  const [dismissedLogError, setDismissedLogError] = useState<string | null>(
    null,
  )
  useEffect(() => {
    setDismissedLogError(null)
  }, [activeSessionId])
  const showLogError =
    activeLog.error !== null && activeLog.error !== dismissedLogError
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
  const composerTypeahead = slashOpen
    ? {
        listboxId: SLASH_COMMAND_LISTBOX_ID,
        activeOptionId: slashCommandOptionId(slashIndex),
      }
    : mentionOpen
      ? {
          listboxId: MENTION_LISTBOX_ID,
          activeOptionId: mentionOptionId(mentionIndex),
        }
      : null

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
  // (parity `Chat.jsx:716`, `src/hooks/useTextInput.ts`). The field is a
  // contentEditable (`ComposerInput`) so a collapsed paste renders as an inline
  // pill; the handle keeps the textarea-shaped selection API these handlers use.
  const composerRef = useRef<ComposerInputHandle>(null)
  const handledComposerFocusRequestRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (
      !isActivePane ||
      composerFocusRequest === undefined ||
      handledComposerFocusRequestRef.current === composerFocusRequest
    ) {
      return
    }
    handledComposerFocusRequestRef.current = composerFocusRequest
    composerRef.current?.focus()
  }, [composerFocusRequest, isActivePane])
  const imagePreparationInFlightRef = useRef(false)
  const [preparingImage, setPreparingImage] = useState(false)
  const [pickingFile, setPickingFile] = useState(false)
  const attachImage = async (file: File): Promise<void> => {
    if (!onAttachImage || imagePreparationInFlightRef.current) {
      if (imagePreparationInFlightRef.current) {
        toast('Wait for the image to finish attaching.', { tone: 'info' })
      }
      return
    }
    imagePreparationInFlightRef.current = true
    setPreparingImage(true)
    try {
      onAttachImage(await prepareImageAttachment(file))
      setTransportErrorFromImage(null)
    } catch (error) {
      setTransportErrorFromImage(errorMessage(error))
    } finally {
      imagePreparationInFlightRef.current = false
      setPreparingImage(false)
    }
  }
  const [transportErrorFromImage, setTransportErrorFromImage] = useState<
    string | null
  >(null)
  const attachFile = async (): Promise<void> => {
    if (!activeSessionId || !onAttachFile || pickingFile) return
    setPickingFile(true)
    try {
      const selection = await getBridge().pickAttachmentFile(activeSessionId)
      if (selection) onAttachFile(selection)
      setTransportErrorFromImage(null)
    } catch (error) {
      setTransportErrorFromImage(errorMessage(error))
    } finally {
      setPickingFile(false)
    }
  }
  // P4-24 — where the caret belongs after a PROGRAMMATIC draft rewrite (at-caret
  // paste, whole-token Backspace). A rewritten draft rebuilds the field's nodes,
  // so without this the next keystroke lands at the end of the draft instead of
  // where the edit happened — and a second Backspace eats the last character
  // rather than continuing.
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
  // No auto-resize effect: a contentEditable already grows with its content, so
  // the field needs only the static `max-h-[38vh]` cap and its own scroll
  // (`ComposerInput`). The measured-height dance a textarea required is gone
  // with the textarea (prototype `Chat.jsx:1402` is a contentEditable for the
  // same reason).

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
  // (the same gate the composer uses). `paused` = a generic permission request;
  // AskQuestionFlow is already the complete visible waiting state for questions.
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // Mirrored into a ref because the pane coordinator asks for this answer from
  // an animation frame, where React state is a render old. The scroll handler
  // writes the ref during the event itself, so a reader who has just scrolled up
  // is never pulled back by a correction landing in the frame that follows.
  const atBottomRef = useRef(true)
  const applyAtBottom = (next: boolean): void => {
    atBottomRef.current = next
    setAtBottom(next)
  }
  // One pump for the pane's lifetime, built on first use so a render that never
  // scrolls (every server render among them) builds nothing.
  const scrollCapturePumpRef = useRef<TranscriptScrollCapturePump | null>(null)
  const scrollCapturePump = (): TranscriptScrollCapturePump =>
    (scrollCapturePumpRef.current ??= createTranscriptScrollCapturePump())
  const [stopError, setStopError] = useState<string | null>(null)
  const generating = !!activeSessionId && isTurnRunning(activeConnection)
  // CC-16 — the composer's three gates, kept apart: `engineInputEnabled` sends
  // now, `connectPending` is "no engine attached yet, and your own
  // focus/keystroke is what attaches one", `turnPending` is "attached, a turn is
  // running". Typing and attaching are allowed in all three; only the SUBMIT
  // waits (parked by `submitSession`, drained in App's CC-16 effect) — the same
  // mid-turn queueing the terminal REPL has always had.
  const composerGate = selectComposerGate({
    hasSession: !!activeSessionId,
    preview,
    connectionStatus: activeConnection.status,
    connectionInputEnabled: activeConnection.inputEnabled,
    logInputEnabled: activeLog.inputEnabled,
  })
  // One decision drives both the textarea attribute and its copy. Ready,
  // previewed, connecting and mid-turn panes are all editable with the ordinary
  // prompt; only terminal/no-session states keep the separate connection copy.
  const composerReadOnly = !composerGate.editable
  const composerPlaceholder = composerGate.editable
    ? 'Ask Cat Code anything or describe a task…'
    : 'Connecting…'
  const paused = permissionQueue.length > 0
  // Slice-cached: stable ref while the session's rows are unchanged, so both
  // `deriveActivity` and the token estimate share one projection.
  const nestedRows = selectNestedTranscriptRows(transcript, activeSessionId)
  // Compaction is the one activity the rows cannot report: it runs between
  // turns of the loop and mints nothing until its boundary lands at the end.
  const compacting = selectIsCompacting(transcript, activeSessionId)
  const activity = deriveActivity(nestedRows, compacting)
  // Same slice-cached projection `deriveActivity` reads, so the plan cannot
  // disagree with the verb beside it (`todoPlan.ts`).
  const todoPlan = selectTodoPlan(nestedRows)
  // The scroll memory anchors on row IDENTITY, so nothing here names the head
  // of the list any more: rows recovered above the reader renumber every row
  // below them, and an index-based anchor would have been discarded at exactly
  // the moment the reader asked to read further back
  // (`docs/migration/decisions/HISTORY-LOAD-EARLIER.md` B5). The identity is
  // published on each row wrapper by `TranscriptView` and read back off the DOM,
  // which is also what lets it survive the grouping passes the pane applies
  // (delegate groups, reasoning runs, tool runs) without this file knowing them.

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

  // Elapsed clock: tick once per second from the turn start App recorded for
  // this session. The start is NOT stamped here — a pane is mounted only while
  // its session is on screen, so owning it here restamped it on every tab
  // switch: the count restarted at 0s and took the token byline (gated on 30s
  // of turn time) with it.
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!generating || turnStartedAt === null) {
      setElapsedMs(0)
      return
    }
    const tick = (): void => setElapsedMs(Date.now() - turnStartedAt)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [generating, turnStartedAt])

  // Live per-turn token count for the activity byline: real output tokens for
  // the turn's finished messages, a character estimate for the one still
  // streaming. Both halves are needed — see `selectLiveTokenEstimate`. Rows
  // supply the turn boundary and the raw log supplies the usage; the two join
  // on the API message id. Recomputed when the transcript slice changes
  // (streaming deltas) or the 1s elapsed tick fires, so its cadence matches the
  // elapsed clock without a second timer. Gated on the SAME 30s threshold the
  // byline itself uses, so the two cannot drift: `ActivityIndicator` shows this
  // only past `SHOW_TOKENS_AFTER_MS`, and computing it earlier walked the whole
  // retained raw log once per streaming delta to produce a number nothing could
  // display yet.
  const liveTokens = useMemo(
    () =>
      generating && elapsedMs > SHOW_TOKENS_AFTER_MS
        ? selectLiveTokenEstimate(nestedRows, activeLog.messages)
        : 0,
    [generating, nestedRows, activeLog.messages, elapsedMs],
  )

  // Stop → the real `app.abort` boundary. The requestId is a message envelope
  // (the sidecar aborts the current turn regardless — `sidecarServer.ts:642`),
  // so a fresh id is correct; no engine-minted turn id is needed.
  //
  // Bug fix — Stop must cancel a queued prompt along with the turn it
  // interrupts, not leave it for the CC-16 drain (`App.tsx`) to fire as a
  // fresh turn: the abort's `turn.status(activeTurn:false)` re-enables input
  // on a connection snapshot indistinguishable from a natural turn end. This
  // session is `generating` for Stop to even be reachable, so a prompt parked
  // here was queued because of THIS turn; releasing it synchronously, before
  // the abort round-trip can produce that frame, is enough (see
  // `shouldReleasePendingSubmitOnStop` in `composerState.ts`).
  const stopTurn = (): void => {
    if (!activeSessionId) return
    if (shouldReleasePendingSubmitOnStop(pendingSubmit)) {
      releasePendingSubmit()
    }
    try {
      getBridge().abort(activeSessionId, `abort-${Date.now()}`, 'user-stop')
      setStopError(null)
    } catch (error) {
      setStopError(errorMessage(error))
    }
  }
  const forceQueuedPrompt = (): void => {
    const promptId = queuedPrompts[0]?.id
    if (!activeSessionId || !promptId) return
    try {
      getBridge().forcePrompt(activeSessionId, {
        type: 'prompt.force',
        requestId: newRequestId(),
        promptId,
      })
      setStopError(null)
    } catch (error) {
      setStopError(errorMessage(error))
    }
  }

  // Instant placement when the pane binds to a session (prototype: no slow crawl
  // on open). A session this window has already shown opens where its reader
  // left off; one that was left following the end opens at the end, including
  // whatever streamed in meanwhile, and live-turn content then follows the
  // bottom while stuck. `transcriptScrollMemory` explains why the place is a row
  // and not a pixel offset.
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    const restored = restoreTranscriptScroll(el, { anchor: scrollAnchor })
    applyAtBottom(restored.kind === 'bottom')
    // Read at bind only: the pane is remounted per session (`WorkspacePanels`
    // keys each panel by session id), so a later anchor is this pane reporting
    // its own position, not a new place to jump to.
  }, [activeSessionId])

  // The pane's stick-to-bottom owner. A restored transcript binds with every
  // off-window body still an estimate, and a streaming one commits with an
  // estimate for the body being written, so the height worth following changes
  // AFTER the commit that rendered it. The row count below cannot see that
  // change; the bodies that cause it report it to the pane, and the pane re-pins
  // from the same signal. Both paths are needed: rows that carry no measured
  // body still only move the height at commit time.
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    return observePaneBottomLock(el, () => atBottomRef.current)
  }, [])

  // Unbinding is the one moment the anchor is READ, so a capture still waiting
  // on a frame has to happen first, or the last stretch of a drag is the part
  // that gets forgotten. A LAYOUT effect for the reason the scroll handler
  // measures at all: React removes a deleted subtree's nodes after running this
  // cleanup, so the rows are still there to measure here, and gone by the time
  // a passive cleanup or the frame itself would have run.
  useLayoutEffect(() => {
    const pump = scrollCapturePump()
    return () => {
      pump.flush()
    }
  }, [activeSessionId])
  // Derived from the RENDERED transcript, never from `activeLog`: the raw log is
  // capped per session, so once it fills, `messages.length` pins at the cap and
  // any message that does not also move `partialCount` yields an identical
  // signature, silently stranding the pane above the newest row.
  const renderedRowCount = activeSessionId
    ? (transcript.sessions[activeSessionId]?.rows.length ?? 0)
    : 0
  // Waiting messages are part of this document too (they render at the end of
  // the scroller, see the D1a block below), and they are the one part of it the
  // row count cannot see. Without them in the signature, queuing a message while
  // parked at the end grows the content and leaves the new row below the fold.
  const contentSignature = `${renderedRowCount}:${partialCount}:${queuedPrompts.length}`
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
  // The live snapshot leads and the retained one is the FALLBACK, rather than
  // the other way round: a caller that passes `runControls` without the retained
  // prop must still get its denominator, or the donut silently drops to the flat
  // 200k default. (It did — a pre-existing test caught exactly that.) The
  // retained value then covers the case the live one cannot: a session whose
  // engine went away keeps its real window instead of having the percentage move
  // under a transcript that has not changed.
  const runControlsContextWindow =
    runControls?.model.contextWindow ?? contextWindow ?? null
  const liveContextUsage = useMemo(
    () => selectContextUsage(activeLog.messages, model, runControlsContextWindow),
    [activeLog.messages, model, runControlsContextWindow],
  )
  /*
   * The rail answers from whatever source still knows, in this order.
   *
   * A PREVIEWED session never had a sidecar in this window, so its facts come
   * from its own cached traffic (`previewRunFacts`). A session that HAD one and
   * lost it — disconnected, parked, crashed — keeps reporting from the last
   * snapshot its engine sent (the `model`/`reasoningEffort`/`lastPermissionMode`
   * props, sourced from the display selectors). Only where no source says
   * anything does a face render nothing, which is the same rule the live rail
   * follows before its first snapshot lands.
   *
   * What none of them do is turn a face into a CONTROL. That is `runControls` /
   * `permissionContext`, which do not outlive the process, so each face falls
   * back to its read-only form rather than offering a picker with no engine
   * behind it.
   */
  const railModel = preview ? (previewRunFacts?.model ?? null) : model
  // The cache stores only the id, so a PREVIEW has no label to show and falls
  // back to the id exactly as before. A detached live session does have one.
  const railModelLabel = preview ? null : modelLabel
  const railEffort = preview ? (previewRunFacts?.effort ?? null) : reasoningEffort
  const railPermissionMode = preview
    ? (previewRunFacts?.permissionMode ?? null)
    : lastPermissionMode
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
  // The REF, not the state, and the difference is a bug not a style choice. On
  // mount this effect and the restore above run in one flush, in declaration
  // order, so this closure still holds the mount-time `atBottom` — `true`, from
  // `useState` — even though the restore has just placed the reader on a
  // remembered row and reported that they are not at the end. Reading the state
  // therefore threw every restored pane to the bottom of its transcript, which
  // is precisely what the restore exists to prevent. `applyAtBottom` writes the
  // ref synchronously, so the ref already knows.
  //
  // `atBottom` stays in the deps: the effect must still re-run when the reader
  // returns to the end, and a ref change schedules nothing on its own.
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el || !atBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [contentSignature, atBottom])

  const onTranscriptScroll = (): void => {
    const el = transcriptScrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const nextAtBottom = gap <= 1
    applyAtBottom(nextAtBottom)
    // Measured from a scroll event rather than at unmount, because a pane's DOM
    // is already gone by the time its ordinary cleanup runs — but COALESCED to
    // one measurement per frame (`createTranscriptScrollCapturePump` states the
    // cost it is dropping). Nothing reads the anchor between frames, so of the
    // several events a single dragged frame delivers only the last one is real.
    if (!activeSessionId || !onScrollAnchorChange) return
    const report = onScrollAnchorChange
    scrollCapturePump().request(() => {
      // A frame that survived past the rows measures a detached box, which is
      // zeros: the previously reported position, at most a frame old, is the
      // truer answer.
      if (!el.isConnected) return
      report(
        captureTranscriptScrollAnchor(el, { atBottom: nextAtBottom }),
      )
    })
  }
  const jumpToBottom = (): void => {
    const el = transcriptScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    applyAtBottom(true)
  }

  // A large paste collapses to a pill (App holds the full text aside and inserts
  // the `[Pasted text #N]` token); a small one is inserted as literal text. Both
  // land at the caret, replacing whatever the paste selected.
  //
  // The default is ALWAYS prevented, unlike the textarea version that let small
  // pastes through: the browser's own paste into a contentEditable carries the
  // clipboard's rich HTML (and images) into the field, and the draft is a plain
  // string. An empty text/plain payload therefore inserts nothing rather than
  // dropping foreign markup in.
  const handlePaste = (event: ReactClipboardEvent<HTMLFormElement>): void => {
    const composer = composerRef.current
    const target = event.target
    if (
      !composer?.element ||
      !(target instanceof Node) ||
      !composer.element.contains(target)
    ) {
      return
    }
    event.preventDefault()
    const files = Array.from(event.clipboardData.files)
    const image = files.find(file =>
      ACCEPTED_IMAGE_TYPES.some(type => type === file.type),
    )
    if (image) {
      void attachImage(image)
      return
    }
    const unsupportedImage = files.find(file => file.type.startsWith('image/'))
    if (unsupportedImage) {
      void attachImage(unsupportedImage)
      return
    }
    const text = event.clipboardData.getData('text')
    if (!text) return
    const start = composer.selectionStart
    const end = composer.selectionEnd
    pendingCaretRef.current = { base: end, prevLength: prompt.length }
    setHistoryNav(EMPTY_HISTORY_NAV)
    if (shouldCollapsePaste(text)) {
      onPaste(text, start, end)
      return
    }
    setPrompt(prompt.slice(0, start) + text + prompt.slice(end))
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    // IME guard: a composition-commit Enter/arrow must never submit, recall, or
    // drive a picker — it belongs to the input method (parity `Chat.jsx:716`).
    if (isComposingRef.current || event.nativeEvent.isComposing) return
    // Feature #4 — keydowns bubbling from the composer action bar (a focused chip
    // face) are owned by that toolbar's own handler; never treat them as textarea
    // input here (Enter on a face must not submit, Backspace must not edit the
    // draft, ↑/↓ must not recall). This form handler is composer-field-only.
    if (event.target !== composerRef.current?.element) return
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
    // No typeahead open — Escape interrupts an in-flight turn. It is the
    // keyboard path only: it is bound on this form, so it is unreachable once
    // focus leaves the composer, and a focused permission card consumes Escape
    // as its own dismiss. The always-visible mount is the send-slot Stop below.
    // Mirrors the TUI Ctrl+C/Esc cancel.
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
    // Enter submits; Shift/Alt/Meta+Enter insert a newline (the field does not
    // submit a form on Enter the way the old `<input>` did, so submit is driven
    // explicitly via the form's own `requestSubmit`). Parity: Shift+Enter and
    // Alt/Meta+Enter → newline (`src/hooks/useTextInput.ts:257-264`).
    //
    // The newline is written into the DRAFT rather than left to the browser.
    // Letting the default run was right for a textarea, but a contentEditable
    // answers a modified Enter by authoring block containers (`<div>`/`<p>`),
    // and the serializer emits a newline only for `<br>` — so the line break
    // would render once and then vanish from the draft. Shift+Enter usually
    // does produce a `<br>`; Alt/Meta+Enter is where it silently did not.
    if (event.key === 'Enter') {
      const el = composerRef.current
      if (event.shiftKey || event.altKey || event.metaKey) {
        if (!el) return
        event.preventDefault()
        const start = el.selectionStart
        const end = el.selectionEnd
        pendingCaretRef.current = { base: end, prevLength: prompt.length }
        setPrompt(`${prompt.slice(0, start)}\n${prompt.slice(end)}`)
        return
      }
      event.preventDefault()
      event.currentTarget.requestSubmit()
      return
    }
    // Backspace immediately after a `[Pasted text #N]` token deletes the WHOLE
    // token in one keystroke. `contenteditable="false"` makes browsers mostly do
    // this already; keeping it explicit makes the DRAFT the single source of the
    // edit. A genuine 'edit' write, so the paste entry is pruned with it.
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
      // D1b, terminal parity — waiting messages come back before history does,
      // the way `↑` behaves in the terminal. The reasoning, and what CC-67's
      // rejection of this binding got right, is on `shouldRecallWaitingMessages`.
      // Same handler the button fires, so the two paths cannot drift.
      if (
        shouldRecallWaitingMessages(
          direction,
          queuedPrompts.length,
          onRecallQueuedPrompts !== null,
        )
      ) {
        event.preventDefault()
        onRecallQueuedPrompts?.()
        return
      }
      const result = navigateHistory(history, historyNav, direction, prompt)
      if (result) {
        event.preventDefault()
        setHistoryNav(result.nav)
        // A recalled entry puts the caret at its END, ready to keep typing
        // (prototype `Chat.jsx:762` `setInputAtCaret(next, next.length)`). Base
        // = the old length, so the shift by the length delta lands on the new
        // one; the field rebuilds around a recalled draft and would otherwise
        // restore the caret to wherever it happened to sit.
        pendingCaretRef.current = {
          base: prompt.length,
          prevLength: prompt.length,
        }
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
    /* Wrapped without re-indenting the pane below, the same way the composer
     * dock's own column wrapper is. */
    <AgentFaceRegistryContext.Provider value={paneFaces}>
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-8 pb-8">
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
          <TranscriptView
            accounts={accountsSnapshot}
            activeSessionId={activeSessionId}
            cwd={activeDescriptor?.cwd ?? null}
            branch={branch}
            sandboxed={sandboxed}
            orchestratorActive={orchestratorActive}
            onToggleOrchestrator={onToggleOrchestrator}
            restorePhase={restorePhase}
            revealHidden={revealHidden}
            state={transcript}
            compacting={compacting}
            leases={leases}
            loadEarlierPending={historyLoadEarlierPending}
            loadEarlierFailure={historyLoadEarlierFailure}
            onLoadEarlier={onLoadEarlierHistory}
            onOpenAccounts={onManageAccounts}
            onSaveDiagnostics={() => void getBridge().saveDiagnosticsBundle()}
            onMessageAction={onMessageAction}
          />

          {/* D1a — a message sent during a response waits here until the engine
            * takes it, exactly as the terminal shows it above its own composer.
            * It is deliberately not transcript STATE: the model has not received
            * it, so it is not in `transcriptProjector` and it never becomes a
            * row. What it is is the last thing in the scrolling document, so it
            * sits under the conversation while the reader is at the end and
            * scrolls away with everything else when they read back.
            *
            * The dock is where this used to live, and the dock is the one place
            * it cannot go. The dock is a flex sibling of the transcript and the
            * transcript is the only child that gives, so a docked block spends
            * the transcript's height: caption, row and control are ~110px of
            * fixed cost whether the waiting message is a paragraph or one
            * letter, and that height is full-width dead space above the
            * composer for as long as anything is waiting. Rejected on sight
            * (2026-08-26). Nothing here may reintroduce a docked band.
            *
            * AFTER `TranscriptView`, never before it: `readTranscriptRowGeometry`
            * reads the scroller's FIRST element child as the row list, so this
            * block ahead of the rows would make the scroll memory anchor on it.
            * Its own column repeats `TranscriptView`'s measure so the waiting
            * bubble's right edge lands on the delivered ones.
            *
            * The pane re-pins to the end when this list changes
            * (`contentSignature`): the bottom lock only answers measured-body
            * corrections, so growth here would otherwise leave the newest
            * waiting message below the fold.
            *
            * One caption over the stack, inside the live region so the
            * announcement still names what these rows are. It is not repeated
            * per row: three waiting messages used to print the word `Queued`
            * three times and truncate the text that actually distinguishes
            * them.
            *
            * D1b — and the way back out. Compact icon controls sit BELOW the
            * rows: force-send advances the oldest waiting message, while recall
            * takes back everything the way the terminal's `↑` does. They remain
            * real buttons with accessible labels, so both are keyboard reachable.
            *
            * ONE live region around the ROWS, not one per row: three waiting
            * messages are one change to announce, and a region each made a
            * screen reader read three. The button sits OUTSIDE it, because a
            * live region re-announces everything inside it on every change, so
            * the controls remain outside it and are not re-announced as news.
            */}
          {queuedPrompts.length > 0 ? (
            <div className="mx-auto flex w-full max-w-[var(--transcript-width)] flex-col items-end gap-1.5 px-8 pt-2.5">
              <div className="flex w-full flex-col items-end gap-1.5" role="status">
                <span className="pr-1 text-[11px] text-text-ghost">Queued</span>
                {queuedPrompts.map(queued => (
                  <QueuedRow key={queued.id} text={queued.text} />
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  aria-label="Send next queued message now"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-subtle transition-colors hover:bg-white/[0.05] hover:text-text-primary"
                  onClick={forceQueuedPrompt}
                  title="Stop the current response and send the next queued message"
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                  >
                    <path d="m7 11 5-5 5 5" />
                    <path d="m7 17 5-5 5 5" />
                  </svg>
                </button>
                {onRecallQueuedPrompts ? (
                  <button
                    aria-label={
                      queuedPrompts.length === 1
                        ? 'Take back queued message'
                        : 'Take back all queued messages'
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-subtle transition-colors hover:bg-white/[0.05] hover:text-text-primary"
                    onClick={onRecallQueuedPrompts}
                    title={
                      queuedPrompts.length === 1
                        ? 'Take back queued message'
                        : 'Take back all queued messages'
                    }
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 5v14" />
                      <path d="m6 13 6 6 6-6" />
                    </svg>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
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
       * their existing indent (wrapped without re-indentation).
       *
       * The dock GIVES rather than overflows. It used to be `shrink-0`, which
       * made it the one thing in an `overflow-hidden` column that could not
       * yield: the transcript is the only `flex-1` child, so it collapses to
       * zero first, and everything the dock needed past that was clipped with
       * no scrollbar to reach it. The composer is the last child, so the
       * composer was what vanished. Measured at the 495px window floor
       * (`main.ts` `minHeight`) with a question card and two permission cards
       * docked: 839px of dock in 455px of pane, composer 400px below the
       * viewport, nothing scrollable anywhere.
       *
       * `min-h-0` is load-bearing, not decoration: without it the dock's
       * automatic minimum size is its min-content height, which a scrolling
       * child does NOT reduce, so the dock freezes at 448px and clips again.
       * With it, the panel region below is the only child that can give (the
       * composer is `shrink-0`, the roster and activity rows stop at their own
       * min-content), so squeeze lands there and turns into scroll. */}
      <div className="mx-auto flex min-h-0 w-full max-w-[var(--transcript-width)] flex-col">
      {/* P4-32a (R1) — the orchestrator worker roster is the prototype's declared
       * host for this block: above the composer, in the transcript's own measure,
       * ahead of the permission/question stack. It dims while the assistant is
       * itself generating, and renders nothing when there are no workers.
       *
       * OUTSIDE the scrolling region below, deliberately: it is at most one row
       * tall (a second worker collapses it to a summary line), and its full
       * roster opens as an `absolute bottom-full` popover that a scroll
       * container would clip. */}
      <OrchestratorRoster
        compact={generating}
        onOpen={onOpenTasks}
        workers={selectDockedOrchestratorWorkers(orchestratorWorkers)}
      />

      {/* Everything docked that can grow without limit — the question card, the
       * permission stack, notices, and the waiting-prompt rows — scrolls here
       * instead of pushing the composer off screen. Empty when nothing is
       * docked, so the resting layout is byte-identical to before this wrapper
       * existed. No ceiling of its own: the height it gets is whatever the dock
       * has left after the composer, which is the bound that matters, and a
       * fixed ceiling on top of that would make this region scroll in tall
       * windows where the stack already fits. */}
      <div className="min-h-0 overflow-y-auto">

      {/* Docked above the composer, in Chat.jsx order — live permission-request
       * cards and any error/notice sit directly above the input, then the
       * in-turn activity row hugs the composer. */}
      {askQuestion ? (
        <AskQuestionFlow
          key={askQuestion.request.requestId}
          isActivePane={isActivePane}
          onAnswer={onAnswerQuestions}
          onCancel={onCancelQuestions}
          pendingCount={askPendingCount}
          questions={askQuestion.questions}
          requestId={askQuestion.request.requestId}
          submitted={askQuestion.submitted}
        />
      ) : null}

      <PermissionQueue
        items={permissionQueue}
        keyboardTargetRequestId={permissionKeyTargetRequestId}
        onAllow={allowPermission}
        onDeny={denyPermission}
        onRestore={restorePermission}
        onSnooze={snoozePermission}
        workers={orchestratorWorkers}
      />

      {showLogError ? (
        <div className="flex items-center gap-3 text-sm text-tone-danger">
          <span className="min-w-0 flex-1">{activeLog.error}</span>
          <button
            type="button"
            onClick={() => setDismissedLogError(activeLog.error)}
            title="Dismiss"
            aria-label="Dismiss message log notice"
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-sm leading-none text-text-subtle transition-colors hover:text-text-primary"
          >
            ×
          </button>
        </div>
      ) : null}

      {transportError ? (
        <div className="text-sm text-tone-danger">{transportError}</div>
      ) : null}
      {transportErrorFromImage ? (
        <div className="text-sm text-tone-danger">{transportErrorFromImage}</div>
      ) : null}

      {/* CC-16 — a genuine cold-spawn prompt needs this row because the composer
       * cleared before any engine was ready to receive it. IDLE-PARK restore is
       * deliberately silent: it keeps the same held prompt and failure recovery,
       * but must not narrate the reclaimed engine while it reconnects. */}
      {pendingSubmit?.showQueuedRow ? (
        <div className="flex flex-col items-end gap-1.5" role="status">
          <span className="pr-1 text-[11px] text-text-ghost">Queued</span>
          <QueuedRow text={pendingSubmit.text} />
          <span className="pr-1 text-[11.5px] text-text-ghost">
            Sends when the session is ready.
          </span>
        </div>
      ) : null}

      </div>

      {/* Outside the scroller: one row, fixed height, and it is the row that
       * hugs the composer. Scrolling it away from the input it belongs to would
       * be the opposite of what it is for. */}
      {generating && askQuestion === null ? (
        <ActivityIndicator
          verb={activity.verb}
          target={activity.target}
          elapsedMs={elapsedMs}
          liveTokens={liveTokens}
          paused={paused}
          compacting={compacting}
          stopError={stopError}
          todoPlan={todoPlan}
          hasForegroundTask={tasksSnapshot?.hasForegroundTask === true}
          onBackgroundTask={onBackgroundTask}
        />
      ) : null}

      {/* P4-24 composer, trued to Chat.jsx:1318's "minimal, borderless" input:
       * a transparent auto-growing field (no box), a pink up-arrow SEND icon
       * (not a "Send" button), a focus-rule underline that lights on focus, and
       * an icon-only actions row (attach + the context donut).
       *
       * Paste is handled here rather than on the field itself so the guard that
       * keeps this form's key handling composer-only covers it too. */}
      <form
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-label="Composer"
        // `shrink-0`: the one child of the dock that never gives. A multi-line
        // draft would otherwise be squeezed back toward a single line before
        // the panel scroller above had finished giving up its own height.
        className="flex shrink-0 flex-col"
        onKeyDown={onComposerKeyDown}
        onPaste={handlePaste}
        onSubmit={event => {
          if (preparingImage) {
            event.preventDefault()
            toast('Wait for the image to finish attaching.', { tone: 'info' })
            return
          }
          // CC-16 — a submit is intent too. Focus/pointer-down normally fired
          // the spawn already (`claimLazyRestore` makes a repeat a no-op), but
          // a send-arrow click on a pre-filled draft never touched the
          // textarea; without this the parked prompt would wait on a spawn
          // nobody started.
          engagePreviewPane()
          submit(event)
        }}
      >
        {images.length > 0 || fileAttachment ? (
          <div
            aria-label="Attachments"
            className="mb-2 flex items-center gap-2 px-1"
          >
            {images.map(image => (
              <div
                className="group relative overflow-hidden rounded-lg border border-accent/20 bg-accent/[0.06] p-1.5"
                key={image.id}
              >
                <img
                  alt={image.name}
                  className="max-h-24 max-w-36 rounded-md object-contain"
                  src={`data:${image.mediaType};base64,${image.data}`}
                />
                <button
                  aria-label={`Remove ${image.name}`}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-shell-chrome/85 text-xs text-text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={() => onRemoveImage?.(image.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
            {fileAttachment ? (
              <div className="group relative flex max-w-56 items-center gap-2 rounded-lg border border-accent/20 bg-accent/[0.06] px-2 py-1.5 text-sm text-text-primary">
                <svg
                  aria-hidden
                  className="shrink-0 text-text-muted"
                  fill="none"
                  height="16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                  width="16"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                <span className="truncate">{fileAttachment.name}</span>
                <button
                  aria-label={`Remove ${fileAttachment.name}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs text-text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={onRemoveFile}
                  type="button"
                >
                  ×
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {/* No bottom padding, deliberately. The prototype has 11px here
         * (Chat.jsx:1395 `padding: '0 4px 11px'`); the operator chose 0 on
         * 2026-08-02 to close the idle composer's dead band. A parity sweep
         * should not restore it without asking. */}
        <div className="peer relative flex items-end gap-[14px] px-1">
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
            {/* Multi-line, auto-growing, BORDERLESS (Chat.jsx:1402-1409):
             * transparent, 16px light text, accent caret. Enter submits,
             * Shift/Alt/Meta+Enter insert a newline; grows to ~38vh then
             * scrolls. A contentEditable, matching the prototype, so a
             * collapsed paste can render as an inline pill at its token —
             * which also makes the field block-level, closing the descender
             * strip a textarea's `inline-block` line box left under it (the
             * gap that used to float the send arrow ~7px low). */}
            <ComposerInput
              ref={composerRef}
              ariaLabel="Prompt"
              disabled={!activeSessionId}
              readOnly={composerReadOnly}
              onFocus={engagePreviewPane}
              // CC-84 — a Finder drag carries its payload on
              // `dataTransfer.files`, so the field's text-only drop handler
              // ignored it. A dropped image goes through the SAME `attachImage`
              // the ⌘V and picker paths use; other file kinds stay ignored (HC1).
              onAttachImageFile={file => void attachImage(file)}
              onPointerDown={engagePreviewPane}
              onValueChange={next => {
                // A genuine keystroke abandons any active ↑/↓ recall cursor
                // (parity with the prototype resetting historyIdx on input) and
                // prunes pastes whose token was actually deleted (reason 'edit').
                // A real keystroke also abandons any caret a programmatic
                // rewrite was about to restore: the browser already placed it.
                pendingCaretRef.current = null
                setHistoryNav(EMPTY_HISTORY_NAV)
                setPrompt(next)
              }}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              onRemovePaste={onRemovePaste}
              pastes={pastes}
              placeholder={composerPlaceholder}
              typeahead={composerTypeahead}
              value={prompt}
            />
          </div>
          {/* The send slot holds SEND or STOP, never both (Chat.jsx:1413-1423
           * `isGenerating ? Stop : Send`). This is the interrupt's only
           * always-visible mount: Escape is bound on the form
           * (`onComposerKeyDown`), so it reaches nothing once focus leaves the
           * composer, and while a permission card holds focus Escape is that
           * card's dismiss instead. A control that is only reachable when the
           * user happens to be in the textarea is not an interrupt. */}
          {generating ? (
            <button
              aria-label="Stop the turn"
              title="Stop (Esc)"
              aria-keyshortcuts="Escape"
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center self-end rounded-lg text-tone-danger transition-colors hover:bg-tone-danger/10"
              onClick={stopTurn}
              type="button"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              aria-label="Send prompt"
              title="Send"
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center self-end rounded-lg text-accent transition-colors disabled:text-text-ghost"
              disabled={
                !composerGate.editable ||
                preparingImage ||
                (prompt.trim().length === 0 &&
                  images.length === 0 &&
                  fileAttachment === null) ||
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
          )}
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
          attachDisabled={!composerGate.editable || preparingImage || pickingFile}
          onAttach={() => void attachFile()}
          model={railModel}
          modelLabel={railModelLabel}
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
          onOpenAccountSwitcher={onOpenAccountSwitcher}
          contextUsage={contextUsage}
          contextBreakdown={contextBreakdown}
          onRequestContextBreakdown={onRequestContextBreakdown}
          // No engine to take it, no row. `canSendUntypedSubmit` owns which gate
          // arms qualify and why `editable` is not one of them.
          onCompact={canSendUntypedSubmit(composerGate) ? onCompact : undefined}
          toolbarRef={actionBarRef}
          onFocusComposer={() => composerRef.current?.focus()}
        />
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
    </AgentFaceRegistryContext.Provider>
  )
}

/**
 * One waiting message. Two surfaces show one: the CC-16 cold-spawn park, which
 * is docked above the composer, and the D1a staged rows, which end the
 * transcript's own scroller. They were the same markup typed twice and free to
 * drift apart. The row itself is placement-agnostic, which is what let D1a move
 * without touching it.
 *
 * It is `UserBubble` (`TranscriptView.tsx`) unfilled: same geometry, same
 * bottom-right notch, same 82% measure, with a dashed accent hairline instead
 * of the solid one and no fill. That is the whole point of the shape. What is
 * waiting here IS the user's own turn, carrying the same uuid the transcript
 * row will carry, so it reads as their message before it is delivered and then
 * simply fills in when the engine takes it. The previous flat gray line said
 * "system text" about a message the user wrote. Clamped to two lines: a queued
 * prompt is a reminder of what is waiting, not a place to re-read it.
 *
 * The caption and the cold-spawn promise belong to the CALLER, not here: one
 * caption over a stack, not the word `Queued` repeated down the left of every
 * row.
 *
 * NOT exported, and not exportable: this is a production `.tsx` module under
 * the Fast Refresh boundary rule, so a second component export would break HMR.
 * The live region belongs to the CALLER, so a group of rows is announced once
 * (`role="status"` per row made a screen reader read one change several times).
 */
function QueuedRow({ text }: { text: string }) {
  return (
    <div className="line-clamp-2 max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-dashed border-accent/30 bg-accent/[0.035] px-4 py-2.5 text-sm leading-relaxed text-text-subtle">
      {text || 'Image attachment'}
    </div>
  )
}

/** Parity with the engine's `SHOW_TOKENS_AFTER_MS` (`SpinnerAnimationRow.tsx:19`):
 * the estimated token byline is gated behind 30s of turn time so quick turns
 * stay quiet — it appears only on genuinely long turns, exactly as the TUI. */
const SHOW_TOKENS_AFTER_MS = 30_000

/**
 * P4-18c activity indicator (`Chat.jsx` SpinnerWithVerb): pulse dots + verb +
 * active target + elapsed clock + optional per-turn token byline. Paused (a
 * pending permission request) tints amber and reads "Waiting for approval". The
 * token byline is `selectLiveTokenEstimate` — the real `output_tokens` of the
 * turn's finished messages plus a character estimate for the one still
 * streaming — gated on `elapsed > 30s && tokens > 0` like the engine. Never a
 * mocked count, and the estimated part is what the tooltip names.
 *
 * No fill and no seam: the row floats on the pane background so it reads as a
 * byline over the conversation rather than a band separating it from the
 * composer. Interrupting the turn is Escape (handled on the composer, not
 * here); `stopError` stays so a failed interrupt is never silent.
 *
 * Everything sits left-packed with no `flex-1` spacer. The spacer only earned
 * its keep while the Stop button anchored the right edge; without it the
 * elapsed clock stranded itself against the far side of the 740px column with
 * a hole in the middle. `target` keeps `min-w-0 truncate` so a long tool name
 * shrinks instead of pushing the clock out of the row.
 *
 * ONE EXCEPTION, and it does reintroduce that hole: the todo readout carries its
 * own `ml-auto` and sits at the right edge (operator choice, 2026-08-29, from
 * `docs/design-html/2026-08-29-todo-surface-options.html`). It is a hover
 * target, and the verb and clock either side of it re-measure every second, so
 * anchoring it to the row's end is what stops it sliding under the cursor. The
 * clock itself stays left-packed, which is the half the original ruling was
 * about.
 */
function ActivityIndicator({
  verb,
  target,
  elapsedMs,
  liveTokens,
  paused,
  compacting,
  stopError,
  todoPlan,
  hasForegroundTask,
  onBackgroundTask,
}: {
  verb: string
  target: string | null
  elapsedMs: number
  liveTokens: number
  paused: boolean
  /** Swaps the pulse dots for the compaction glyph (see `CompactingGlyph`). */
  compacting?: boolean
  stopError: string | null
  /** The session's live plan, or null when it has none (`todoPlan.ts`). */
  todoPlan: TodoPlan | null
  hasForegroundTask: boolean
  onBackgroundTask?: () => void
}) {
  const tone = paused ? 'text-tone-warn' : 'text-accent'
  const dot = paused ? 'bg-tone-warn' : 'bg-accent'
  const showTokens = liveTokens > 0 && elapsedMs > SHOW_TOKENS_AFTER_MS
  const todoReadout = selectTodoReadout(todoPlan)
  return (
    <div className="flex items-center gap-2.5 bg-transparent px-1 py-1.5 text-xs">
      {compacting && !paused ? (
        <CompactingGlyph />
      ) : (
      <span className="flex items-center gap-1" aria-hidden>
        <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot}`} />
        <span
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot} [animation-delay:150ms]`}
        />
        <span
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot} [animation-delay:300ms]`}
        />
      </span>
      )}
      <span className={`font-semibold ${tone}`}>
        {paused ? 'Waiting for approval' : verb}
      </span>
      {target ? (
        <span className="min-w-0 truncate font-mono text-[11.5px] text-text-subtle">
          {target}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
        {fmtElapsed(elapsedMs)}
        {showTokens ? (
          <span
            title="Output tokens this turn, with the message still streaming estimated; arrow shows phase, not direction"
          >
            {' · ↓ '}
            {fmtTok(liveTokens)} tokens
          </span>
        ) : null}
      </span>
      {stopError ? (
        <span className="shrink-0 text-[11px] text-tone-danger">{stopError}</span>
      ) : null}
      {hasForegroundTask ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-accent/25 px-2 py-0.5 text-[10.5px] font-medium text-accent">
            Foreground
          </span>
          {onBackgroundTask ? (
            <button
              className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-text-subtle transition-colors hover:border-white/[0.14] hover:text-text-primary"
              onClick={onBackgroundTask}
              title="Keep running work in the background"
              type="button"
            >
              Background
            </button>
          ) : null}
        </span>
      ) : null}
      {/* The plan's readout owns the row's right edge (`ml-auto` on the
       * readout itself), the one part of this byline that is not left-packed.
       * A fixed anchor is what makes it a stable hover target while the verb
       * and the clock either side of it change width every second. Absent
       * whenever the session has no plan, or has one with nothing yet in
       * progress — see `selectTodoReadout`. */}
      {todoReadout === null || todoPlan === null ? null : (
        <TodoStepReadout plan={todoPlan} readout={todoReadout} />
      )}
    </div>
  )
}

/**
 * The compaction verb's own motion: three marks travelling into one that
 * absorbs them. Compaction is the one activity the pulse dots misrepresent —
 * they say "a turn is running", and what is running is the conversation being
 * folded into a summary.
 *
 * Occupies the same 30px the three dots do, so swapping it in does not shift
 * the verb. The motion lives in `theme.css` as named classes
 * (`animate-compact-ingest` / `animate-compact-absorb`), NOT as interpolated
 * arbitrary-value utilities: an `[animation:name_1.5s_…]` class silently
 * no-ops unless Tailwind saw that exact literal, and `codeTheme.test.ts`
 * enforces that every renderer animation class is neutralised under
 * `prefers-reduced-motion`, which only sees named classes.
 */
function CompactingGlyph() {
  return (
    <span className="relative block h-1.5 w-[30px] shrink-0" aria-hidden>
      <span className="animate-compact-absorb absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="animate-compact-ingest absolute top-px h-1 w-1 rounded-full bg-accent opacity-0" />
      <span className="animate-compact-ingest absolute top-px h-1 w-1 rounded-full bg-accent opacity-0 [animation-delay:500ms]" />
      <span className="animate-compact-ingest absolute top-px h-1 w-1 rounded-full bg-accent opacity-0 [animation-delay:1000ms]" />
    </span>
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
  // shared two-tone grammar decides this rather than a local status list: the
  // danger tone is the gate, and a transient reads neutral, which mounts
  // nothing. A status added to the union inherits that by construction.
  const tone = connectionTone(connection.status)
  const message = connectionRecoveryMessage(connection.status)
  if (!sessionId || tone !== 'danger' || message === null) {
    return null
  }

  return (
    <div className="flex items-center gap-3 text-sm text-tone-danger">
      <span>{message}</span>
      <button
        className="rounded border border-tone-danger px-3 py-1 text-xs"
        onClick={() => {
          void restartConnection(getBridge(), sessionId).then(setRestartError)
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

type SessionPaneProps = {
  /**
   * This session's Codex leases (the P4-32b read seam), forwarded to the
   * transcript so an agent card can name the account its worker holds. Null on
   * an Anthropic-path session, which holds no Codex lease at all.
   */
  leases?: LeaseSnapshot | null
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
  /** Request a fresh host-owned account pool when the composer switcher opens. */
  onOpenAccountSwitcher?: () => void
  /** Global most-recent `account.result` (ACCT-5) — SessionPane correlates it by
   * requestId + sessionId against its own in-flight composer switch and toasts
   * the real outcome; no optimistic UI, mirrors AccountsPage's `pendingRef`. */
  accountsLastResult: AccountResultFrame | null
  activeConnection: ConnectionSnapshot
  /** When this session's running turn started, or null when no turn is running.
   * Owned by App (`reduceTurnStarts`) because a pane is unmounted while its
   * session is off screen, and the elapsed clock must survive that. */
  turnStartedAt?: number | null
  activeDescriptor: SessionDescriptor | undefined
  activeLog: RawMessageSessionLog
  /** Read-only git branch for the empty-state meta strip — this session's own
   * `diagnostics.snapshot`, falling back to the session log's `gitBranch`. */
  branch: string | null
  /** Whether this session's tools run sandboxed (`diagnostics.snapshot`), read by
   * the empty-state meta strip's "Start in" column. */
  sandboxed?: boolean
  activeSessionId: SessionId | null
  /** This pane is the operator's focused one — gates window-level keyboard ownership in a split. */
  isActivePane: boolean
  /** Monotonic request to focus this pane's composer after a historical rewrite. */
  composerFocusRequest?: number
  /** Cache-backed transcript is currently painted; operational stores stay live-only. */
  preview?: boolean
  /** First focus, pointer-down, or pane dwell lazily restores the real session. */
  onPreviewEngage?: () => void
  /** Stable App-owned message action dispatcher, absent without a live engine. */
  onMessageAction?: MessageActionHandler
  /** What the cached transcript says this session ran on; feeds the rail while
   * no engine exists to report it live. */
  previewRunFacts?: PreviewRunFacts | null
  allowPermission: (requestId: string, applySuggestions?: number[]) => void
  /**
   * The RESOLVED model this session runs, or last ran
   * (`RunControlsSnapshot.model.current`); null before the first snapshot.
   *
   * These four are the DISPLAY seam and deliberately survive the session's
   * engine: they come from `selectLastRunControlsSnapshot`, not the live one, so
   * a disconnected or parked pane still says what it ran on. `runControls` below
   * is the capability seam and does NOT survive it, which is what turns each
   * face read-only instead of blank.
   */
  model: string | null
  /** The model's product name, when the engine gave one. The face shows THIS;
   * `model` above stays the resolved id, which is what `selectContextUsage`
   * matches `modelUsage` on. */
  modelLabel?: string | null
  /** The session's reasoning-effort tier, or null when running at the provider default. */
  reasoningEffort: string | null
  /** Fast state for the read-only face: true/false when known, null when nothing
   * has reported it or the model cannot do fast (no face either way). */
  fastMode: boolean | null
  /** The engine-resolved window for `model`, the donut's denominator before any
   * turn reports one. Null falls back to `contextUsage.ts`'s default. */
  contextWindow?: number | null
  /** The mode this session is in, or was last in. Display only — the picker is
   * armed by `permissionContext`, which a dead session does not have. */
  lastPermissionMode?: string | null
  /** P4-24c — the live run-controls snapshot (current + real picker options + availability). */
  runControls?: RunControlsSnapshot | null
  /** Per-category context occupancy for the donut popover. */
  contextBreakdown?: ContextBreakdownSnapshot | null
  /** Ask the sidecar to recompute the breakdown (the popover was opened). */
  onRequestContextBreakdown?: () => void
  /** Submit `/compact` for this session. Gated again below by `composerGate`. */
  onCompact?: () => void
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
  /** P4-32a (R1) — this session's real worker roster, docked above the composer. */
  orchestratorWorkers?: readonly AgentModeWorkerItem[]
  /** P4-32a — open the workers/tasks list (the roster's click-through). */
  onOpenTasks?: (agentId?: string) => void
  /** Live engine task mode. Kept outside transcript cards so task state never mutates transcript history. */
  tasksSnapshot?: TasksSnapshot | null
  /** Terminal Ctrl+B parity over this session's live foreground tasks. */
  onBackgroundTask?: () => void
  partialCount: number
  permissionContext: ReturnType<typeof selectPermissionContext>
  /** P4-43 — the request the shortcuts act on in THIS pane, or null. A split
   * workspace renders one queue per pane, and only the active pane's card may
   * take focus and register the listener, which acts solely on that request.
   * Absent = no card here owns the keyboard, which is the safe default. */
  permissionKeyTargetRequestId?: string | null
  permissionQueue: ReturnType<typeof selectPermissionQueue>
  /** Hide a card locally, keeping the request live engine-side (the card's
   * "Keep pending" footer lane). Esc refuses instead, per the prototype.
   * Absent = the card offers no such lane. */
  snoozePermission?: (requestId: string) => void
  /** P4-11 — the pending ExitPlanMode review, or `null`; drives PlanBar/PlanPanel. */
  planReview: PlanReview | null
  /** Composes `setPermissionMode` + a C1 allow on the plan-review request. */
  onApprovePlan: (mode: PlanApprovalMode) => void
  /** Denies the plan-review request with feedback (real "keep planning"). */
  onRevisePlan: (message: string) => void
  /** P4-20 — the pending AskUserQuestion request, or `null`; drives AskQuestionFlow. */
  askQuestion: AskQuestionReview | null
  /** Session-wide requests still awaiting an answer, this question included.
   * Optional like the sibling card's `pendingCount`; absent reads as "nothing
   * queued behind this", which is what the kicker shows below two. */
  askPendingCount?: number
  /** Sends the answer via the `answerQuestions` verb (index selection + freeform). */
  onAnswerQuestions: (answers: AskUserQuestionAnswer[]) => void
  /** Declines the AskUserQuestion request (reuses the permission deny path). */
  onCancelQuestions: () => void
  prompt: string
  restorePermission: (requestId: string) => void
  /**
   * P4-36 transcript mode: show THIS pane's hidden tier (`isSynthetic` rows),
   * dimmed. Owned by App per session and toggled from the session actions menu;
   * defaults to the ordinary transcript.
   */
  revealHidden?: boolean
  /**
   * Where this session's reader was when the pane last held it, or null for a
   * session this window has not shown yet. Owned by App (`transcriptScrollMemory`)
   * because a pane is unmounted while its session is off screen, exactly like
   * `turnStartedAt`. Read once, at bind.
   */
  scrollAnchor?: TranscriptScrollAnchor | null
  /** Report the reading position back, on every scroll of this pane. */
  onScrollAnchorChange?: (anchor: TranscriptScrollAnchor) => void
  /** A read further back is running for this session. */
  historyLoadEarlierPending?: boolean
  /** What to say about this session's last read that did not work. */
  historyLoadEarlierFailure?: string | null
  /**
   * Read further back into this session's transcript. Owned by App because the
   * answer arrives as a frame, and a pane is unmounted while its session is off
   * screen. ABSENT on a pane with no engine to ask, which is what withholds the
   * control from the boundary row.
   */
  onLoadEarlierHistory?: () => void
  setPermissionMode: (mode: PermissionSetModeMode) => void
  setPrompt: (value: string, reason?: DraftWriteReason) => void
  submit: (event: FormEvent<HTMLFormElement>) => void
  /** Real @-mention sources for this session (agents; files need a read-seam). */
  mentionItems: MentionItem[]
  /** Collapsed pastes held aside for this session, oldest first. */
  pastes: PasteEntry[]
  /** Images attached from the clipboard or picker for this session. */
  images?: ImageAttachment[]
  onAttachImage?: (attachment: Omit<ImageAttachment, 'id'>) => void
  onRemoveImage?: (id: number) => void
  /** One native-picker file, held as a main-issued opaque token. */
  fileAttachment?: FileAttachment | null
  onAttachFile?: (attachment: FileAttachment) => void
  onRemoveFile?: () => void
  /** CC-16 — a prompt submitted before the engine could accept it. The cold-spawn
   * row is presentation metadata; every pending prompt still blocks a second hold. */
  pendingSubmit?: PendingSubmit | null
  /** D1a — messages this session has waiting for its running response, oldest
   * first. Display only: they stay out of the transcript until delivered. */
  queuedPrompts?: readonly QueuedPromptItem[]
  /** D1b — take every waiting message back into the composer. The pane always
   * passes it; what hides the control is having nothing waiting, since the rows
   * and the control are rendered together. */
  onRecallQueuedPrompts?: (() => void) | null
  /** Bug fix — hands `pendingSubmit` back to the composer without sending it.
   * `stopTurn` calls this so Stop cancels a queued prompt along with the turn,
   * instead of the CC-16 drain firing it as a fresh turn the instant the
   * abort's `turn.status(false)` re-enables input. */
  releasePendingSubmit: () => void
  /** Prior submitted prompts for ↑/↓ recall (per session, newest last). */
  history: string[]
  /** Store a large paste as a collapsed chip and splice its token in at the
   * composer caret (`selectionStart`/`selectionEnd`); absent selection appends. */
  onPaste: (
    content: string,
    selectionStart?: number,
    selectionEnd?: number,
  ) => void
  /** Remove ONE collapsed paste: cut the occurrence starting at `at` (the live
   * position of the pill the user clicked, so a duplicated token removes the
   * right one). Pruning drops the stored text once no reference is left. */
  onRemovePaste: (entry: PasteEntry, at: number) => void
  transcript: TranscriptState
  transportError: string | null
}
