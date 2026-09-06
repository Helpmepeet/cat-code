/**
 * SessionPane — one session's pane: transcript, composer, and the per-session
 * chrome around them.
 *
 * Split out of `App.tsx` (2026-09-06). `App` owns the shell: the host roster,
 * focus transitions, and the inbound frame fan-out. This file owns what one
 * pane renders once a session is selected. The boundary is deliberate — pane
 * work lands here so the shell does not keep absorbing it.
 *
 * Focus and roster ownership did NOT move. `App` still owns focus transitions
 * so a background frame or host event cannot steal the active pane, and
 * `shellState.ts` still owns roster ordering.
 */

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { getBridge } from './bridge.js'
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
  selectPermissionContext,
  selectPermissionQueue,
} from './permissionState.js'
import {
  type PlanApprovalMode,
  type PlanReview,
} from './planState.js'
import {
  type AskQuestionReview,
} from './askQuestionState.js'
import { AskQuestionFlow } from './AskQuestionFlow.js'
import { PlanBar, PlanPanel } from './PlanPanel.js'
import { useToast } from './toastContext.js'
import {
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  selectIsCompacting,
  selectNestedTranscriptRows,
  selectSlashCommands,
  type TranscriptState,
} from './transcriptProjector.js'
import {
  type PreviewRunFacts,
} from './previewTranscriptState.js'
import {
  TranscriptView,
  type AgentBackgroundControl,
  type MessageActionHandler,
  type RestorePhase,
} from './TranscriptView.js'
import { observePaneBottomLock } from './markdownScrollCoordinator.js'
import {
  captureTranscriptScrollAnchor,
  createTranscriptScrollCapturePump,
  restoreTranscriptScroll,
  type TranscriptScrollAnchor,
  type TranscriptScrollCapturePump,
} from './transcriptScrollMemory.js'
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
  caretAtHistoryEdge,
  canSendUntypedSubmit,
  composerPlaceholderParts,
  composerPromptPlaceholder,
  EMPTY_HISTORY_NAV,
  navigateHistory,
  parseMentionQuery,
  pasteTokenBeforeCaret,
  selectComposerGate,
  shouldCollapsePaste,
  shouldRecallWaitingMessages,
  shouldReleasePendingSubmitOnStop,
  type DraftWriteReason,
  type FileAttachment,
  type HistoryNav,
  type ImageAttachment,
  type PasteEntry,
  type PendingSubmit,
} from './composerState.js'
import {
  ACCEPTED_IMAGE_TYPES,
  prepareImageAttachment,
} from './imageAttachment.js'
import {
  connectionRecoveryMessage,
  connectionTone,
  type ConnectionSnapshot,
} from './connectionState.js'
import {
  selectDockedOrchestratorWorkers,
} from './orchestratorState.js'
import {
  AgentFaceRegistryContext,
  AgentFaceRegistryStoreContext,
} from './agentFace.js'
import { OrchestratorRoster } from './OrchestratorRoster.js'
import {
  resultToastTone,
  switchVerb,
} from './accountsPageModel.js'
import type {
  AccountResultFrame,
  AccountStatus,
  AccountsSnapshot,
  AnthropicAccountStatus,
  AccountSwitchMessage,
  AgentModeWorkerItem,
  AskUserQuestionAnswer,
  LeaseSnapshot,
  PermissionSetModeMode,
  QueuedPromptItem,
  RunControlsSnapshot,
  ContextBreakdownSnapshot,
  SessionId,
  SlashCatalogEntry,
  TasksSnapshot,
} from '../../shared/protocol.js'
import type {
  SessionDescriptor,
} from '../../shared/hostApi.js'
import {
  deriveActivity,
  fmtElapsed,
  fmtTok,
  isTurnRunning,
  restartConnection,
  selectLiveTokenEstimate,
} from './appModel.js'
import { errorMessage } from './appModel.js'

/** Stable empty list so a session with nothing waiting keeps one identity. */
const EMPTY_QUEUED_PROMPTS: readonly QueuedPromptItem[] = []
/** Stable empty catalog so an omitted `slashCatalog` prop keeps one identity. */
const EMPTY_SLASH_CATALOG: readonly SlashCatalogEntry[] = []
/** Stable identity so a session with no orchestrator snapshot never re-renders. */
const EMPTY_WORKERS: readonly AgentModeWorkerItem[] = []

/** Renderer-minted correlation id for a run-control verb (T5a-analog; echoed on
 * `run-control.result`). A UX field, not a security one — the sidecar bounds it.
 * Declared locally, as `accountsPageModel.ts` and `RemoteSettingsPage.tsx` do. */
const newRequestId = (): string => crypto.randomUUID()

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
  onBackgroundSubagent,
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
    if (!activeSessionId || pickingFile) return
    setPickingFile(true)
    try {
      const selection = await getBridge().pickAttachmentFile(activeSessionId)
      if (!selection) return
      if (selection.kind === 'error') {
        setTransportErrorFromImage(selection.message)
        return
      }
      if (selection.kind === 'image') {
        const bytes = new ArrayBuffer(selection.bytes.byteLength)
        new Uint8Array(bytes).set(selection.bytes)
        await attachImage(
          new File([bytes], selection.name, {
            type: selection.mediaType,
          }),
        )
        return
      }
      onAttachFile?.({ name: selection.name, token: selection.token })
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
  // A named session is addressed by its own name (PEER-SESSIONS §6): the user
  // is talking to Bear, not to "Cat Code" in general, and the name is what its
  // peers use for it too. A row with no name (one that predates the field and
  // has not been spawned since) keeps the original prompt verbatim. The
  // connection copy is untouched either way.
  const composerPlaceholder = composerGate.editable
    ? composerPromptPlaceholder(activeDescriptor?.name ?? null)
    : 'Connecting…'
  // The name carries the peer colour; the connection copy has no name in it.
  const composerPlaceholderName = composerGate.editable
    ? composerPlaceholderParts(activeDescriptor?.name ?? null)
    : null
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
  // Which worker cards may offer Background: the live snapshot's subagents that
  // are NOT already backgrounded. `subagents` is the only list carrying a
  // foreground worker at all — `items` filters it out — which is why the verb is
  // keyed by `toolUseId` (`TaskBackgroundOneMessage`). Null when there is nothing
  // to offer, so a settled transcript re-renders no control and every card keeps
  // the geometry it has today.
  const subagents = tasksSnapshot?.subagents
  const agentBackground = useMemo<AgentBackgroundControl | null>(() => {
    if (!onBackgroundSubagent || !subagents) return null
    const backgroundable = new Set(
      subagents.filter(item => !item.isBackgrounded).map(item => item.toolUseId),
    )
    return backgroundable.size === 0
      ? null
      : { backgroundable, onBackground: onBackgroundSubagent }
  }, [onBackgroundSubagent, subagents])
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
            agentBackground={agentBackground}
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
              // the ⌘V and native-picker paths use; other dropped file kinds stay
              // ignored because only main may turn a chosen path into an opaque
              // file token (HC1).
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
              placeholderParts={composerPlaceholderName}
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
 * elapsed clock stranded itself against the far side of the transcript column
 * (`--transcript-width`, `theme.css`) with a hole in the middle. `target` keeps
 * `min-w-0 truncate` so a long tool name shrinks instead of pushing the clock
 * out of the row.
 *
 * ONE EXCEPTION, and it does reintroduce that hole: the todo readout carries its
 * own `ml-auto` and sits at the right edge (operator choice, 2026-08-29, from
 * `docs/design-html/2026-08-29-todo-surface-options.html`). It is a hover target,
 * and the verb and target either side of it re-measure as the turn moves from one
 * tool to the next, so anchoring it to the row's end is what stops it sliding
 * under the cursor. (The clock re-ticks every second but is `tabular-nums`, so it
 * only changes width at a digit-count boundary.) The clock itself stays
 * left-packed, which is the half the original ruling was about.
 *
 * NO INTERACTIVE CONTROL LIVES HERE. A `Foreground` pill and a `Background`
 * button briefly did (CC-85), and both facts about this row defeated them: they
 * were left-packed, so they slid as the verb and clock re-measured, and the row
 * unmounts whenever `askQuestion` is non-null while the work they acted on keeps
 * running. Backgrounding is a per-worker action now and belongs on the worker's
 * own card (`TranscriptView.tsx`, `AgentBackgroundContext`), which is where the
 * terminal has always put it (`BackgroundHint`, `src/tools/BashTool/UI.tsx:78`,
 * mounted per tool call by `AgentTool.tsx:1597`).
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
  /**
   * Move ONE running subagent to the background, named by the `tool_use` id its
   * transcript card carries. The card owns this affordance, not the activity
   * byline — see `ActivityIndicator`'s header for why the byline cannot hold it.
   */
  onBackgroundSubagent?: (toolUseId: string) => void
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

