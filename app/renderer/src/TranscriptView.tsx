/**
 * Renders the projector's view models (transcriptProjector.ts — §5 layer 2).
 * P1-3: structure over polish — a markdown text row and a bare tool card
 * styled with the P0-2 tokens only. P2-2 extends the tool card with its
 * derived status, family, and (when the result narrowed to one)
 * DiffView/MultiDiffCard — still structural, not the prototype's pixel
 * design; subagent rows nest via `NestedTranscriptRow.children`, never
 * interleaved at top level (D2/C4).
 *
 * P4-18a (the functional-fix slice): the row dispatch is now an EXHAUSTIVE
 * switch over `NestedTranscriptRow['kind']`, so every projected non-tool-card
 * kind (user turns, thinking, boundary/lifecycle seams, notices, command
 * echoes, images) draws a visible row instead of the old `return null`
 * fall-through that silently dropped user messages (`TranscriptView.tsx`
 * pre-18a line 61). Display degrades gracefully: an unknown/schema-drifted
 * runtime kind renders a tolerant fallback row, never throws. The `default`
 * branch carries the compile-time `never` tripwire — SDK/projector union
 * growth breaks the build here until the new kind gets a case. Tool-card
 * FAMILIES (18b) and prose/markdown + activity/scroll polish (18c) are later
 * slices; their cases slot into this same switch.
 */

import {
  Component,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AccountsSnapshot, SessionId } from '../../shared/protocol.js'
import { WelcomeScreen } from './WelcomeScreen.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import {
  renderMarkdownTree,
  type MarkdownComponents,
  type MountedMarkdownLeaf,
} from './markdownRenderPlan.js'
import { VirtualLineList } from './VirtualLineList.js'
import {
  observePaneScroll,
  reportPaneHeightCorrection,
} from './markdownScrollCoordinator.js'
import {
  createCompositeChildState,
  reduceCompositeChildState,
  sameCompositeChildWindow,
  selectCompositeChildEntries,
  selectCompositeChildWindow,
  selectInitialCompositeChildWindow,
  INITIAL_CHILD_VIEWPORT_HEIGHT,
  type CompositeChildMeasurement,
  type CompositeChildWindow,
} from './compositeChildWindow.js'
import { REHYPE_PLUGINS } from './markdownPlugins.js'
import { useModalFocus } from './overlayFocus.js'
import { useToast } from './toastContext.js'
import {
  groupAgentDelegates,
  selectNestedTranscriptRows,
  type AgentCompletionProjection,
  type NestedToolUseRow,
  type NestedTranscriptRow,
  type TranscriptDisplayItem,
  type TranscriptState,
  type ToolCardStatus,
  type ToolDiffProjection,
  type ToolFamily,
  type ToolResultProjection,
  type UserImageSource,
} from './transcriptProjector.js'
import { selectBashCardText } from './bashCommandLabel.js'
import { withoutTodoRows } from './todoPlan.js'
import {
  TOOL_CARD_BAND_CLASS,
  TOOL_CARD_BODY_CLASS,
  TOOL_CARD_BODY_INNER_CLASS,
  TOOL_CARD_DIVIDER_CLASS,
  TOOL_CARD_HEADER_CLASS,
  TOOL_CARD_INSET_CLASS,
  TOOL_CARD_ORPHAN_SHELL_CLASS,
  TOOL_CARD_PLAIN_HEADER_CLASS,
  TOOL_CARD_SHELL_CLASS,
  TOOL_CARD_SUB_CLASS,
  ToolCardStyleContext,
  type ToolCardStyle,
} from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import {
  MAX_PROSE_ARRIVAL_STAGGER_MS,
  PROSE_ARRIVAL_WORD_CLASS,
  PROSE_ARRIVAL_WORD_STAGGER_MS,
  ProseArrivalContext,
} from './proseArrival.js'
import { markArrivedText } from './proseArrivalMark.js'
import type { Root as HastRoot } from 'hast'
import {
  groupReasoningRuns,
  ReasoningLayoutContext,
  REASONING_WITHHELD_TEXT,
  reasoningStepsForRow,
  toDisplayItems,
  type ReasoningLayoutItem,
  type ReasoningLayoutMode,
  type ReasoningStepModel,
} from './reasoningLayout.js'
import {
  agentFacePulse,
  deriveAgentDisplayVocabulary,
  type AgentStateKey,
  type AgentToolSource,
} from './agentIdentity.js'
import {
  useAgentFaceRegistry,
  useSessionAgentFaceRegistry,
  AgentFaceRegistryContext,
  type FaceAxes,
} from './agentFace.js'
import { AgentFace } from './AgentChrome.js'
import {
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './agentChromeModel.js'
import { formatModelDisplayName } from './statsState.js'
import {
  leaseAccountShortLabel,
  LeaseSnapshotContext,
  selectLeaseForLabel,
  selectLeaseForOwner,
} from './leaseState.js'
import type { LeaseSnapshot } from '../../shared/protocol.js'
import { ToolInspector } from './ToolInspector.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import {
  FilePathMenuContext,
  type FilePathActionsAnchor,
} from './filePathActions.js'
import {
  ActionBranchIcon,
  ActionCopyIcon,
  ActionFileIcon,
  ActionRewindIcon,
} from './SessionActionIcons.js'
import { parseToolAck, type ToolAck } from './toolAck.js'
import {
  AdditionSourceRow,
  GrepSourceRow,
  ReadSourceRow,
} from './ReadSourceLines.js'
import {
  parseReadSource,
  readLineNumbers,
  readSourceLanguage,
} from './readSource.js'
import { highlightedWordSegments } from './diffHighlight.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import {
  selectDiffRows,
  selectRowWordSegments,
  type DiffLineKind,
  type DiffRow,
  type WordDiffSide,
} from './diffRowModel.js'
import {
  selectGrepHighlightedRows,
  selectGrepRows,
  type GrepRow,
} from './grepRowModel.js'
import { basename, commonDirPrefix, dirname } from './pathUtils.js'
import {
  createToolCardExpansionStore,
  ToolCardExpansionContext,
  type ToolCardExpansionStore,
  useAnyToolCardOpened,
  useToolCardExpanded,
  useToolCardExpansionStore,
} from './toolCardExpansion.js'
import {
  groupToolRuns,
  type ToolRunFamily,
  type ToolRunMember,
  type TranscriptLayoutItem,
} from './toolRunLayout.js'
import {
  formatGrepDigest,
  grepDigest,
  totalGrepDigest,
  type GrepDigest,
} from './grepResult.js'
import {
  dequote,
  findNestedToolUseRow,
  logLineClass,
  resolveToolCardExpanded,
  selectPeekLines,
  type QuotePosition,
} from './transcriptViewModel.js'
import {
  INLINE_HEAD_LINES,
  revealMoreLines,
  selectInlineOutputWindow,
} from './inlineOutputWindow.js'

/**
 * P4-1 open-from-card handle: the truncation reveal band calls this with its
 * card's own REAL projected row to open the `ToolInspector` drawer. Provided by
 * `TranscriptRowsView`, which owns the selected-row state and renders the
 * overlay. Default `null` so a tool card rendered outside a transcript (a direct
 * unit test) simply omits the band's button. The published value is a stable
 * `useCallback` handle, so exposing it via context never defeats the memoized
 * row subtree.
 *
 * The band is now the ONLY route in. The always-present `Inspector` card footer
 * that also held this handle was removed 2026-08-13
 * (`docs/reports/2026-08-12-tool-inspector-ux-review.md`): it was a second
 * always-visible entry to a destination that repeated the card, so the drawer is
 * reached only for output a card had to cut.
 */
/**
 * Backgrounding one running subagent, from its own transcript card.
 *
 * A context rather than a prop drilled through the row tree, mirroring
 * `ToolInspectorContext` right below: an agent card sits an unknown number of
 * levels down (top-level row, delegate-group member, nested sub-agent branch),
 * and every level between here and it is generic over row kind.
 *
 * `backgroundable` is the set of `tool_use` ids whose worker is running in the
 * FOREGROUND right now, derived from `TasksSnapshot.subagents`. It gates display
 * only — the sidecar re-resolves the id against its live store and fails closed,
 * so a stale set can never background the wrong worker (see
 * `TaskBackgroundOneMessage`).
 */
export type AgentBackgroundControl = {
  backgroundable: ReadonlySet<string>
  onBackground: (toolUseId: string) => void
}

// Not exported: only this module reads it, and a runtime export from a `.tsx`
// would break the Fast Refresh boundary (`lint:fast-refresh`). The TYPE above is
// exported so a pane can build the value; type-only exports are allowed.
const AgentBackgroundContext = createContext<AgentBackgroundControl | null>(null)

/**
 * Where the card's Background control pins itself: the identity line's right
 * edge, in whichever card style is drawn. It is positioned rather than laid out
 * because the identity line lives INSIDE the collapse `<button>` and interactive
 * content may not nest there, so the control has to be a sibling of that button
 * while still reading as part of the row it acts on.
 *
 * The heights are the identity line's own: `TOOL_CARD_INSET_CLASS` padding either
 * side of a 19px `AgentFace` (33px in `cards`, 25px in `lines`).
 */
const AGENT_BACKGROUND_ANCHOR_CLASS: Record<ToolCardStyle, string> = {
  cards: 'right-3 h-[33px]',
  lines: 'right-0 h-[25px]',
}

const ToolInspectorContext = createContext<((row: ToolUseNestedRow) => void) | null>(
  null,
)
const TurnErrorActionsContext = createContext<{
  openAccounts?: () => void
  saveDiagnostics?: () => void
}>({})

/**
 * Re-derive the inspected tool row from the CURRENT rows by id (review F1). The
 * inspector stores only the id; deriving the row each render means a late-arriving
 * tool_result updates the open drawer instead of pinning the stale open-time
 * snapshot, and a vanished id (row pruned / session switched) resolves to null →
 * the drawer closes.
 */
/**
 * IS-C (M5) — how a restore reads while it is NOT yet a live session. App
 * derives this from the preview flag + connection status (never a frame):
 * - `preview` — cached transcript shown, not engaged.
 * - `resuming` — a lazy restore is in flight over the still-shown cached rows.
 * - `connecting` — a restore is spawning with NO cache to preview (the no-cache
 *   path that used to render an empty pane and read as a hang, report F4); the
 *   pane shows the restore skeleton until live replay lands.
 */
export type RestorePhase = 'preview' | 'resuming' | 'connecting'
export type MessageActionKind = 'edit' | 'branch'
export type MessageActionHandler = (
  sessionId: SessionId,
  action: MessageActionKind,
  userMessageId: string,
) => void

// Perf (2026-07-08, F3): memoized so an App re-render that did NOT change this
// session's transcript slice (a keystroke in the composer, another session's
// frame) skips the whole subtree. `state`/`activeSessionId` are referentially
// stable across those, and `selectNestedTranscriptRows` is slice-cached, so the
// `rows` handed to TranscriptRowsView keep identity when nothing changed.
export const TranscriptView = memo(function TranscriptView({
  state,
  compacting,
  activeSessionId,
  accounts,
  orchestratorActive,
  onToggleOrchestrator,
  cwd,
  branch,
  sandboxed,
  restorePhase,
  revealHidden,
  loadEarlierPending,
  loadEarlierFailure,
  onLoadEarlier,
  onOpenAccounts,
  onSaveDiagnostics,
  onMessageAction,
  agentBackground = null,
}: {
  state: TranscriptState
  /** A compaction is running in this session (`selectIsCompacting`). */
  compacting?: boolean
  activeSessionId: SessionId | null
  /** In-session empty-state Welcome context (Chat.jsx:1272) — the real P4-5 Codex
   * pool snapshot + agent-mode active flag + fixed cwd + git branch; read-only (HC1). */
  accounts?: AccountsSnapshot | null
  orchestratorActive?: boolean
  /** P4-8b — toggle THIS session's agent mode from the empty-state Orchestrator
   * switch (the session variant is interactive; the launcher stays read-only). */
  onToggleOrchestrator?: (next: boolean) => void
  cwd?: string | null
  branch?: string | null
  /** Whether this session's tools run sandboxed, read by the empty state's
   * "Start in" column. */
  sandboxed?: boolean
  /** IS-C (M5) — restore affordance phase; null for an ordinary live pane. */
  restorePhase?: RestorePhase | null
  /**
   * P4-36 — transcript mode: keep the engine's hidden tier (`isSynthetic`) in
   * the pane, dimmed. Owned by App per session and toggled from the session
   * actions menu; false is the ordinary transcript.
   */
  revealHidden?: boolean
  /** A read further back is running for this session. */
  loadEarlierPending?: boolean
  /** What to say about the last read that did not work. */
  loadEarlierFailure?: string | null
  /**
   * Read further back into this session. ABSENT is the whole gate on the
   * control: a pane with no engine behind it (a cached preview, a session whose
   * process is gone) still shows the boundary row, and has nothing to ask.
   */
  onLoadEarlier?: () => void
  onOpenAccounts?: () => void
  onSaveDiagnostics?: () => void
  /** Present only for an ordinary live pane. */
  onMessageAction?: MessageActionHandler
  /**
   * This session's Codex leases, so an agent card can name the account its worker
   * holds. Optional and null-tolerant: the plane is Codex-only and per-process.
   */
  leases?: LeaseSnapshot | null
  /** Per-worker backgrounding, or null when this pane cannot issue the verb. */
  agentBackground?: AgentBackgroundControl | null
}) {
  return (
    <TranscriptRowsView
      rows={withoutTodoRows(
        selectNestedTranscriptRows(state, activeSessionId, revealHidden),
      )}
      compacting={compacting ?? false}
      accounts={accounts ?? null}
      orchestratorActive={orchestratorActive ?? false}
      onToggleOrchestrator={onToggleOrchestrator}
      cwd={cwd ?? null}
      branch={branch ?? null}
      sandboxed={sandboxed ?? false}
      restorePhase={restorePhase ?? null}
      loadEarlierPending={loadEarlierPending ?? false}
      loadEarlierFailure={loadEarlierFailure ?? null}
      onLoadEarlier={onLoadEarlier}
      onOpenAccounts={onOpenAccounts}
      onSaveDiagnostics={onSaveDiagnostics}
      onMessageAction={onMessageAction}
      agentBackground={agentBackground}
    />
  )
})

export const TranscriptRowsView = memo(function TranscriptRowsView({
  rows,
  compacting = false,
  leases = null,
  accounts = null,
  orchestratorActive = false,
  onToggleOrchestrator,
  cwd = null,
  branch = null,
  sandboxed = false,
  restorePhase = null,
  loadEarlierPending = false,
  loadEarlierFailure = null,
  onLoadEarlier,
  onOpenAccounts,
  onSaveDiagnostics,
  onMessageAction,
  agentBackground = null,
}: {
  rows: NestedTranscriptRow[]
  /** A compaction is running: mounts the live seam under the last row. */
  compacting?: boolean
  /** This session's Codex leases; null on an Anthropic path and after a restore. */
  leases?: LeaseSnapshot | null
  /** Per-worker backgrounding, or null when this pane cannot issue the verb. */
  agentBackground?: AgentBackgroundControl | null
  accounts?: AccountsSnapshot | null
  orchestratorActive?: boolean
  onToggleOrchestrator?: (next: boolean) => void
  cwd?: string | null
  branch?: string | null
  sandboxed?: boolean
  restorePhase?: RestorePhase | null
  loadEarlierPending?: boolean
  loadEarlierFailure?: string | null
  onLoadEarlier?: () => void
  onOpenAccounts?: () => void
  onSaveDiagnostics?: () => void
  onMessageAction?: MessageActionHandler
}) {
  // P4-1: the tool row a card asked to inspect (null = drawer closed). Owned here
  // — above the memoized rows — so opening the drawer never mutates a row and the
  // overlay is a sibling of the transcript column, not nested in a scrolling row.
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const openInspector = useCallback((row: ToolUseNestedRow) => setInspectedId(row.id), [])
  const closeInspector = useCallback(() => setInspectedId(null), [])
  const [filePathMenuState, setFilePathMenuState] = useState<{
    anchor: FilePathActionsAnchor
    rawPath: string
    sessionId: SessionId
  } | null>(null)
  const openFilePathMenu = useCallback(
    (anchor: FilePathActionsAnchor, rawPath: string, sessionId: SessionId) => {
      setFilePathMenuState({ anchor, rawPath, sessionId })
    },
    [],
  )
  const closeFilePathMenu = useCallback(() => setFilePathMenuState(null), [])
  const { style: cardStyle } = useContext(ToolCardStyleContext)
  const filePathMenuContextValue = useMemo(
    () => ({ cwd: cwd ?? null, openFilePathMenu }),
    [cwd, openFilePathMenu],
  )
  const { mode: reasoningMode } = useContext(ReasoningLayoutContext)
  // Owned ABOVE the derivations below, which is the whole point: a card that gets
  // re-keyed or re-typed when rows regroup finds its own expansion again through
  // the engine's `toolUseId` (`toolCardExpansion.ts`). A ref, not state — a toggle
  // must re-render the clicked card, never the whole transcript.
  //
  // An ancestor's store WINS when there is one. This is a TEST SEAM, not a planned
  // lift: the renderer suite is SSR-only, so "the user's content survives a
  // regroup" can only be shown by driving ONE store through two different row
  // shapes, and without an injection point the fix would ship with no evidence for
  // the property it exists for. Nothing mounts a store today.
  const inheritedStore = useContext(ToolCardExpansionContext)
  const expansionRef = useRef<ToolCardExpansionStore | null>(null)
  expansionRef.current ??= createToolCardExpansionStore()
  const expansionStore = inheritedStore ?? expansionRef.current
  // One face registry per SESSION, so every worker on screen is deduped against
  // every other one and none of them changes silhouette mid-session.
  //
  // The SHELL owns it now (`App.tsx`), because the same worker is drawn outside
  // this pane as well — the docked roster, the Workers list, a relayed
  // permission card. A registry mounted here was invisible to all of them, so
  // they fell back to the raw hash and the roster disagreed with the transcript
  // about any worker the dedupe had moved.
  //
  // The own-registry fallback below is what keeps this component standalone (it
  // renders alone in tests, and is exported). It keys off the rows' own session
  // rather than a prop: `selectNestedTranscriptRows` already filtered to one
  // session, and it survives the transient empty `rows` of a restore.
  const inheritedFaces = useContext(AgentFaceRegistryContext)
  const ownFaces = useSessionAgentFaceRegistry(
    rows.length === 0 ? null : rows[0].sessionId,
  )
  const faceRegistry = inheritedFaces ?? ownFaces
  // Re-derive from the LIVE rows so a late tool_result updates the drawer and a
  // vanished row closes it, instead of pinning the open-time snapshot (F1).
  const inspected = inspectedId === null ? null : findNestedToolUseRow(rows, inspectedId)

  let content: ReactNode
  if (rows.length === 0) {
    // IS-C (M5) — a restore in flight must never read as an empty pane / hang.
    // The no-cache `connecting` path and a cached preview that distilled to zero
    // rows (truncation-only edge) both render the restore skeleton instead of
    // the live WelcomeScreen.
    content =
      restorePhase !== null ? (
        <PreviewSkeleton />
      ) : (
        // Empty session → the rich WelcomeScreen (Chat.jsx:1272 renders the SAME
        // WelcomeScreen when `isEmpty`): the cat|wordmark hero + the REAL Codex
        // pool table (P4-5) + the orchestrator reflect. HC1 session variant —
        // Project is the read-only cwd (no picker), and no recents launcher/"Open
        // folder…" (you are already in a project). Real data only: a null pool
        // snapshot degrades to "No Codex account data for this view yet.", never a
        // mock.
        <WelcomeScreen
          variant="session"
          cwd={cwd}
          branch={branch}
          sandboxed={sandboxed}
          accounts={accounts}
          orchestratorActive={orchestratorActive}
          onToggleOrchestrator={onToggleOrchestrator}
        />
      )
  } else {
    // D2/§3 DelegateGroup: coalesce co-spawned parallel agents into ONE grouped
    // card at read time — a pure derivation over the already-nested rows, never a
    // new frame or message type (C3). Non-agent rows and lone agents pass through.
    // The `trail` reasoning mode layers a second read-time derivation on top
    // (adjacent reasoning rows → one run); `blocks` leaves the rows alone.
    // The tool-run fold runs LAST and outside the reasoning-mode switch: a run of
    // reads or searches is a tool-card concern, not a reasoning-display
    // preference, so it must survive `blocks` mode too.
    const items: readonly TranscriptLayoutItem[] = groupToolRuns(
      groupDisplayItems(groupAgentDelegates(rows), reasoningMode),
    )
    // Intentional: cached/restoring transcripts render without a divider or pulse.
    // The operator rejected the startup pink hairline + dot (2026-07-29).
    content = (
      // P4-24 fidelity: content is centered, full-bleed (no bordered box), with
      // 24px top / 32px side padding (Chat.jsx:1282 `margin: '0 auto'`).
      //
      // WIDTH IS A DELIBERATE DEVIATION (operator, 2026-08-07). The prototype
      // caps this at 740 (`Chat.jsx:402` MSG_MAX) and `px-8` sits INSIDE that,
      // so the real content column was 676px — on a maximized window that left
      // ~60% of the screen empty while tool rows, paths and diffs truncated
      // against it. Do not "restore" it to 740 as a parity fix.
      //
      // The value now lives in `--transcript-width` (theme.css), which the
      // composer dock and its banner in `App.tsx` read too: those edges have to
      // line up with these, and two hand-synced literals is how they stop.
      //
      // EVERY row shares this width, prose included, and that is load-bearing:
      // two attempts to give running text its own narrower measure inside this
      // column were both rejected on sight (2026-08-09), because a transcript
      // built from full-width rows reads a narrower text column as a seam no
      // matter how it is aligned. A line of prose is therefore as long as the
      // column allows, which is still longer than is comfortable — but no width
      // fixes both that and the truncation this column was widened for, so the
      // cost is taken here knowingly rather than paid for with a mismatched
      // edge. See the `.md-prose` header in `theme.css`.
      //
      // Prose weight also moved (light to medium) at `AssistantProse` below,
      // for legibility on this near-black background. It stays scoped to
      // assistant prose, NOT the whole column.
      <div
        className="mx-auto flex w-full max-w-[var(--transcript-width)] flex-col gap-2.5 px-8 pt-6"
        data-card-style={cardStyle}
      >
        {items.map(item => {
          // The wrapper publishes the row's identity to the pane's scroll memory
          // (`transcriptScrollMemory.ts`): the reading position is remembered as
          // a row rather than a place in the list, so recovering earlier
          // messages above the reader moves nothing they were looking at.
          //
          // P4-36 — a revealed hidden row reads dimmed (`Chat.jsx:1285`
          // `opacity: 0.55`), so transcript mode never passes engine bookkeeping
          // off as ordinary conversation. `isHidden` is only ever present when
          // the caller asked for the revealed view.
          const key = displayItemKey(item)
          return (
            <div
              data-row-key={key}
              data-tool-row={isContainerlessToolItem(item) ? '' : undefined}
              key={key}
              className={isRevealedHiddenItem(item) ? 'opacity-55' : undefined}
            >
              {isHistoryBoundaryItem(item) ? (
                <HistoryBoundaryRow
                  pending={loadEarlierPending}
                  failure={loadEarlierFailure}
                  onLoad={onLoadEarlier}
                />
              ) : (
                <DisplayItemView
                  item={item}
                  onMessageAction={onMessageAction}
                />
              )}
            </div>
          )
        })}
        {compacting ? <CompactingSeam /> : null}
      </div>
    )
  }

  return (
    <ToolCardExpansionContext.Provider value={expansionStore}>
      <AgentFaceRegistryContext.Provider value={faceRegistry}>
        <LeaseSnapshotContext.Provider value={leases}>
          <AgentBackgroundContext.Provider value={agentBackground}>
          <ToolInspectorContext.Provider value={openInspector}>
            <TurnErrorActionsContext.Provider
              value={{ openAccounts: onOpenAccounts, saveDiagnostics: onSaveDiagnostics }}
            >
              <FilePathMenuContext.Provider value={filePathMenuContextValue}>
                {content}
                <ToolInspectorOverlay row={inspected} onClose={closeInspector} />
                {filePathMenuState ? (
                  <FilePathActionsMenu
                    anchor={filePathMenuState.anchor}
                    rawPath={filePathMenuState.rawPath}
                    cwd={cwd}
                    sessionId={filePathMenuState.sessionId}
                    onClose={closeFilePathMenu}
                  />
                ) : null}
              </FilePathMenuContext.Provider>
            </TurnErrorActionsContext.Provider>
          </ToolInspectorContext.Provider>
          </AgentBackgroundContext.Provider>
        </LeaseSnapshotContext.Provider>
      </AgentFaceRegistryContext.Provider>
    </ToolCardExpansionContext.Provider>
  )
})

/**
 * P4-1 mount: the `ToolInspector` drawer as a right-side overlay (prototype
 * OutputInspector, Messages.jsx:254 — `position: fixed`, dimmed backdrop, Esc to
 * close). Rendered by `TranscriptRowsView` from the REAL projected row a card's
 * reveal band handed to `openInspector`; a null row renders nothing. Fixed
 * positioning keeps
 * it off the transcript's own scroller (App owns `transcriptScrollRef`), so
 * opening the drawer never perturbs stick-to-bottom. Display degrades gracefully:
 * `ToolInspector` renders text nodes only and never throws on a malformed input.
 */
export function ToolInspectorOverlay({
  row,
  onClose,
}: {
  row: ToolUseNestedRow | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus({
    open: row !== null,
    containerRef: dialogRef,
    onEscape: onClose,
  })
  if (!row) return null
  return (
    <div className="fixed inset-0 z-[200] flex justify-end">
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        className="relative flex h-full shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Full output"
        tabIndex={-1}
      >
        <ToolInspector row={row} onClose={onClose} />
      </div>
    </div>
  )
}

const SKELETON_BAR_WIDTHS = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3', 'w-4/5'] as const

/**
 * IS-C (M5) — restore skeleton for a pane with no rows yet: the no-cache
 * `connecting` path (report F4's "reads as a hang") and the empty-cache preview
 * fallback. A pulsing dot + shimmer bars signal work in flight; it never shows
 * the live/empty WelcomeScreen while a restore is pending.
 */
function PreviewSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[var(--transcript-width)] flex-col gap-3 px-8 pt-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      <div className="flex flex-col gap-2.5" aria-hidden>
        {SKELETON_BAR_WIDTHS.map((width, index) => (
          <div
            key={index}
            className={`h-3 animate-pulse rounded bg-shell-hover ${width}`}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The `trail` reasoning mode's grouping pass. `blocks` returns the items
 * untouched, so selecting it restores exactly the pre-existing row-per-block
 * rendering — the two modes differ by this one derivation plus the row
 * components they dispatch, nothing else.
 */
function groupDisplayItems(
  items: readonly TranscriptDisplayItem[],
  mode: ReasoningLayoutMode,
): readonly ReasoningLayoutItem[] {
  // `blocks` returns the input array BY REFERENCE — copying it would throw away
  // the identity `groupAgentDelegates` caches per rows-slice.
  return mode === 'trail' ? groupReasoningRuns(items) : items
}

function displayItemKey(item: TranscriptLayoutItem): string {
  return item.kind === 'single' ? item.row.id : item.id
}

/**
 * P4-36 — is this item a revealed hidden-tier row? Only single rows can be:
 * the hidden tier is user frames, and every grouped item (agent DelegateGroup,
 * reasoning run, tool run) is built from assistant rows, which the engine never
 * hides.
 */
function isRevealedHiddenItem(item: TranscriptLayoutItem): boolean {
  return item.kind === 'single' && item.row.isHidden === true
}

/**
 * Is this the top of an incomplete transcript? Only a single row can be: no
 * grouping pass ever folds the boundary in with a message, and the row is
 * synthesized at the head of the list.
 */
function isHistoryBoundaryItem(item: TranscriptLayoutItem): boolean {
  return item.kind === 'single' && item.row.kind === 'history-boundary'
}

/**
 * One display item — an agent DelegateGroup, a reasoning run, a tool run, or a
 * single row. The `default` branch carries the same compile-time `never` tripwire
 * as the row switch: a new display-item kind breaks the build here until it gets
 * a case.
 */
/**
 * Items that draw NO container of their own under `lines`, so a run of them can
 * sit flush. Deliberately excludes the shells that keep a box in both styles:
 * a delegate group (the box is what says "group") and an orphaned agent (dashed
 * chrome is what says "parent missing"). Butting a bare line against either of
 * those reads as a mistake, not as density.
 */
function isContainerlessToolItem(item: TranscriptLayoutItem): boolean {
  if (item.kind === 'tool-run') return true
  return item.kind === 'single' && item.row.kind === 'tool-use'
}

function DisplayItemView({
  item,
  onMessageAction,
}: {
  item: TranscriptLayoutItem
  onMessageAction?: MessageActionHandler
}) {
  switch (item.kind) {
    case 'agent-group':
      return <DelegateGroup members={item.members} />
    case 'reasoning-run':
      return <ReasoningRun runId={item.id} steps={item.steps} />
    case 'tool-run':
      return <ToolRunCard family={item.family} members={item.members} />
    case 'single':
      return (
        <TranscriptRowView
          row={item.row}
          onMessageAction={
            item.row.kind === 'user-text' && item.row.isHidden !== true
              ? onMessageAction
              : undefined
          }
        />
      )
    default: {
      const _exhaustive: never = item
      void _exhaustive
      return null
    }
  }
}

/**
 * Per-container height estimates, used only until the browser measures a child.
 *
 * A nested transcript row is whatever the transcript can hold (prose, a tool
 * card, a seam), so its estimate is a middling row. A tool-run member is one
 * collapsed line. A delegate member is a collapsed agent card with its identity
 * strip. All three are replaced per child by the first measurement.
 */
const NESTED_ROW_ESTIMATED_HEIGHT = 120
const RUN_MEMBER_ESTIMATED_HEIGHT = 28
const DELEGATE_MEMBER_ESTIMATED_HEIGHT = 120

/**
 * Mounts a bounded range of ONE composite container's children.
 *
 * Same division of labour as `BoundedMarkdown`: `compositeChildWindow.ts` owns
 * the range and the measurement state, and this owns geometry — where the
 * container sits relative to the pane viewport, and how measured heights
 * replace the estimate. The caller keeps its complete child list and every
 * count it prints; only the mounted range comes from here.
 *
 * Scroller observation goes through the SHARED pane coordinator, so a
 * transcript full of these adds no scroll listeners to the pane. The two
 * observers each container does own watch its own elements: its root box, and
 * its own direct children.
 */
function BoundedChildList({
  keys,
  estimatedChildHeight,
  renderChild,
  className,
}: {
  /** One stable identity per child, in order. Length is the true child count. */
  keys: readonly string[]
  estimatedChildHeight: number
  /** Draws the child at an index into `keys`. Called only for mounted children. */
  renderChild: (index: number) => ReactNode
  /** Layout classes the replaced wrapper carried, so spacing is unchanged. */
  className?: string
}) {
  const [state, dispatch] = useReducer(
    reduceCompositeChildState,
    undefined,
    createCompositeChildState,
  )
  const entries = useMemo(
    () => selectCompositeChildEntries(keys, estimatedChildHeight, state),
    [keys, estimatedChildHeight, state],
  )
  const [childWindow, setChildWindow] = useState<CompositeChildWindow>(() =>
    selectInitialCompositeChildWindow(entries),
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const entriesRef = useRef(entries)
  const scheduleRef = useRef<() => void>(() => {})
  const paneScrollerRef = useRef<HTMLElement | null>(null)
  const boxRef = useRef<{ height: number; topSpacer: number } | null>(null)

  useEffect(() => {
    entriesRef.current = entries
    scheduleRef.current()
  }, [entries])

  // Attaches once for the lifetime of the container. Streamed child arrivals
  // reach the window through the ref above, so a growing run never detaches and
  // re-attaches the shared pane scroller.
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof window === 'undefined') return
    const scroller = findPaneScroller(root)
    paneScrollerRef.current = scroller
    let frame = 0
    const update = () => {
      frame = 0
      const rootRect = root.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      setChildWindow(current => {
        const next = selectCompositeChildWindow(
          entriesRef.current,
          scrollerRect.top - rootRect.top,
          scroller.clientHeight || INITIAL_CHILD_VIEWPORT_HEIGHT,
        )
        return sameCompositeChildWindow(current, next) ? current : next
      })
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    scheduleRef.current = schedule
    const rootObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    rootObserver?.observe(root)
    const releasePane = observePaneScroll(scroller, schedule)
    schedule()
    return () => {
      scheduleRef.current = () => {}
      paneScrollerRef.current = null
      if (frame !== 0) window.cancelAnimationFrame(frame)
      rootObserver?.disconnect()
      releasePane()
    }
  }, [])

  // Reports this container's own height change to the pane, on EVERY commit and
  // with no dependency list, for the same reason `BoundedMarkdown` does: a
  // measured child height replaces an estimate frames after the commit that used
  // it, so only the rendered box marks where the document actually moved.
  useEffect(() => {
    const root = rootRef.current
    const scroller = paneScrollerRef.current
    if (root === null || scroller === null) return
    const rect = root.getBoundingClientRect()
    const previous = boxRef.current
    boxRef.current = { height: rect.height, topSpacer: childWindow.topSpacerHeight }
    if (previous === null) return
    const delta = rect.height - previous.height
    if (delta === 0) return
    const unchangedPrefix = Math.min(previous.topSpacer, childWindow.topSpacerHeight)
    const offset =
      rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop + unchangedPrefix
    reportPaneHeightCorrection(scroller, { offset, delta })
  })

  const mounted = useMemo(
    () => entries.slice(childWindow.start, childWindow.end),
    [entries, childWindow.start, childWindow.end],
  )
  const mountedSignature = mounted.map(entry => entry.key).join('|')

  // Keyed on the mounted identities rather than the numeric range, so a child
  // replaced inside an unchanged window is observed immediately.
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(records => {
      const measurements: CompositeChildMeasurement[] = []
      for (const record of records) {
        const key = record.target.getAttribute('data-transcript-child')
        if (key === null) continue
        const height = record.borderBoxSize[0]?.blockSize ?? record.contentRect.height
        measurements.push({ key, height })
      }
      if (measurements.length > 0) dispatch({ kind: 'measured', measurements })
    })
    // DIRECT children only. A descendant query would also reach a nested
    // container's children and file their heights under this container's cache.
    for (const element of root.children) {
      if (!(element instanceof HTMLElement)) continue
      if (element.getAttribute('data-transcript-child') === null) continue
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [mountedSignature])

  return (
    <div className={className} ref={rootRef}>
      {childWindow.topSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${childWindow.topSpacerHeight}px` }} />
      ) : null}
      {mounted.map((entry, offset) => (
        <div data-transcript-child={entry.key} key={entry.key}>
          {renderChild(childWindow.start + offset)}
        </div>
      ))}
      {childWindow.bottomSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${childWindow.bottomSpacerHeight}px` }} />
      ) : null}
    </div>
  )
}

/**
 * The pane scroller this container lives in. Same walk `BoundedMarkdown` does;
 * duplicated rather than shared because that module is a component file and may
 * not export a helper under the Fast Refresh boundary rule.
 */
function findPaneScroller(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement
  while (current !== null) {
    if (/(auto|scroll)/.test(window.getComputedStyle(current).overflowY)) return current
    current = current.parentElement
  }
  return document.documentElement
}

/**
 * A nested row list (subagent children under an Agent card, tool-card children).
 * These never carry agent grouping — co-spawned siblings are a TOP-LEVEL
 * derivation (C4 keeps children under their owning card) — but their reasoning
 * and tool runs group exactly like the top level, so a delegated GPT turn reads
 * the same inside a card as outside one.
 *
 * The list is bounded: an agent that ran for an hour hands its card thousands of
 * child rows, and expanding it used to mount every one. Recursion is bounded at
 * both levels, because a grouped run inside these items bounds its own members.
 */
function NestedRowList({
  rows,
  className,
}: {
  rows: NestedTranscriptRow[]
  className?: string
}) {
  const { mode } = useContext(ReasoningLayoutContext)
  const items = groupToolRuns(groupDisplayItems(toDisplayItems(rows), mode))
  const keys = useMemo(() => items.map(displayItemKey), [items])
  return (
    <BoundedChildList
      className={className}
      estimatedChildHeight={NESTED_ROW_ESTIMATED_HEIGHT}
      keys={keys}
      renderChild={index => <DisplayItemView item={items[index]} />}
    />
  )
}

/**
 * The whole of what an incomplete pane says. One line, stating the fact and
 * nothing else: not why retention exists, not what was dropped, not a number
 * that would differ on the next path into the same session.
 */
const HISTORY_BOUNDARY_LABEL = "Earlier messages from this session aren't loaded."

/** What the control offers, in the words of the thing it does. */
const HISTORY_LOAD_LABEL = 'Load earlier messages'

/** The same control while the read is running, so the row says what it is doing. */
const HISTORY_LOADING_LABEL = 'Loading…'

/**
 * The top of an incomplete transcript, with the way out of it.
 *
 * The control is present only when a caller supplied `onLoad`, and the row is
 * present only while the transcript is incomplete — so a whole transcript has
 * neither, and a pane with no engine to ask keeps the row and drops the control.
 * That asymmetry is deliberate (decisions/HISTORY-LOAD-EARLIER.md): engaging
 * with a session is what GAINS the way out, where the defect this replaced had
 * engaging withdraw the warning.
 */
function HistoryBoundaryRow({
  pending,
  failure,
  onLoad,
}: {
  pending: boolean
  failure: string | null
  onLoad?: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-full">
        <Seam tone="neutral" label={HISTORY_BOUNDARY_LABEL} />
      </div>
      {onLoad ? (
        <button
          type="button"
          onClick={onLoad}
          disabled={pending}
          aria-busy={pending ? true : undefined}
          className="rounded-full border border-shell-seam px-3 py-0.5 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-default disabled:border-shell-seam disabled:text-text-subtle"
        >
          {pending ? HISTORY_LOADING_LABEL : HISTORY_LOAD_LABEL}
        </button>
      ) : null}
      {onLoad && failure !== null ? (
        <span className="text-[11px] text-tone-danger">{failure}</span>
      ) : null}
    </div>
  )
}

/**
 * The same sentence, one card down. An Agent card in an incomplete pane can come
 * back with its whole run missing and look exactly like an agent that did
 * nothing, so it says which of the two it is and stops. Deliberately the
 * boundary's wording, because it is the boundary's fact.
 */
const STEPS_NOT_LOADED_LABEL = "This agent's steps aren't loaded."

// Memoized per row: a slice-cached read reuses unchanged row objects, so only
// the rows that actually changed re-render (markdown re-parses once per body).
const TranscriptRowView = memo(function TranscriptRowView({
  row,
  onMessageAction,
}: {
  row: NestedTranscriptRow
  onMessageAction?: MessageActionHandler
}) {
  const { mode: reasoningMode } = useContext(ReasoningLayoutContext)
  // Captured before the switch narrows `row` to `never` in the default branch,
  // so the tolerant fallback can name the drifted kind without an `as` cast.
  const rowKind: string = row.kind
  switch (row.kind) {
    case 'assistant-text':
      return (
        <AssistantProse
          content={row.content}
          sourceId={row.id}
          sessionId={row.sessionId}
          streaming={row.isStreaming}
        />
      )

    case 'user-text':
      return (
        <UserBubble
          content={row.content}
          {...(onMessageAction
            ? {
                onEdit: () =>
                  onMessageAction(row.sessionId, 'edit', row.frameId),
                onBranch: () =>
                  onMessageAction(row.sessionId, 'branch', row.frameId),
              }
            : {})}
        />
      )

    case 'command-echo':
      return (
        <CommandEchoBubble
          commandName={row.commandName}
          args={row.args}
          skillFormat={row.skillFormat}
        />
      )

    case 'user-image':
      return <UserImageRowView source={row.source} />

    case 'thinking':
      // In `trail` a reasoning row always arrives here already grouped into a
      // `reasoning-run` item, so this branch is the `blocks` treatment — plus
      // the shape `blocks` never handled: an encrypted-only block reaches the
      // app as `thinking` with an EMPTY body (`codex-fetch-adapter.ts:2229`),
      // which the reasoning card would draw as an empty frame. It has nothing to
      // read, so it draws as the redacted placeholder in either mode.
      return row.content.trim().length === 0 ? (
        <RedactedThinkingBlock />
      ) : reasoningMode === 'blocks' ? (
        <ThinkingBlock content={row.content} sourceId={row.id} />
      ) : (
        <ReasoningRun runId={`reasoning-run:${row.id}`} steps={reasoningStepsForRow(row)} />
      )

    case 'redacted-thinking':
      return reasoningMode === 'blocks' ? (
        <RedactedThinkingBlock />
      ) : (
        <WithheldReasoningLine />
      )

    case 'system-notice':
      return (
        <SystemNoticeBox noticeType={row.noticeType} content={row.content} />
      )

    case 'task-notification':
      return <TaskNotificationBox summary={row.summary} />

    case 'injected-turn':
      return (
        <InjectedTurnBox
          injectedKind={row.injectedKind}
          label={row.label}
          content={row.content}
        />
      )

    case 'result':
      return (
        <ResultSeam
          isError={row.isError}
          subtype={row.subtype}
          durationMs={row.durationMs}
          totalCostUsd={row.totalCostUsd}
        />
      )

    case 'turn-stopped':
      return <Seam tone="neutral" label="Stopped" boldLabel />

    case 'compact-boundary':
      return <CompactBoundarySeam />

    case 'snip-boundary':
      // Typed-but-unminted at today's SDK seam (ledger §5 ✂️ cut); render-ready
      // so a future engine seam that mints it degrades gracefully, not blank.
      return (
        <Seam tone="neutral" glyph="✂" label="Stale tool output snipped" />
      )

    case 'tombstone':
      // Typed-but-unminted (ledger §5 ✂️ cut); render-ready dashed seam.
      return (
        <Seam tone="neutral" dashed faded label="message removed" italicLabel />
      )

    case 'history-boundary':
      // The top of an incomplete transcript. A quiet seam, never an alert: the
      // pane is working as designed and there is nothing to dismiss. No count —
      // how much survived is decided by a byte budget and differs per session
      // and per path, so the honest thing to say on every path is the fact
      // alone.
      return <Seam tone="neutral" label={HISTORY_BOUNDARY_LABEL} />

    case 'orphaned-agent':
      return <OrphanedAgentCard row={row} />

    case 'tool-use':
      return <ToolCard row={row} />

    default: {
      // Compile-time exhaustiveness tripwire: a new NestedTranscriptRow kind
      // errors here until it gets a case above. Runtime tolerance: a
      // schema-drifted kind past the pinned union degrades to a quiet fallback
      // row (display = degrade gracefully), never a throw.
      const _exhaustive: never = row
      void _exhaustive
      return (
        <div className="rounded border border-dashed border-shell-seam bg-shell-hover/40 px-3 py-1.5 font-mono text-[11px] text-text-subtle">
          Unrecognized transcript row: {rowKind}
        </div>
      )
    }
  }
})

/**
 * P4-18c assistant prose. react-markdown for the GFM set (headings, bold/italic,
 * inline code, lists, links, hr, blockquote, and — via `remark-gfm` — pipe
 * TABLES) wrapped in a render-error boundary (a throw degrades to the plain
 * source, never a React crash — display = degrade gracefully). Fenced code
 * blocks render in a framed panel with a per-block copy button and
 * `rehype-highlight` syntax tokens (highlight.js `hljs-*` classes, colored by the
 * FIXED Dracula stylesheet in `theme.css` — never dynamic Tailwind). A
 * streaming body carries a blinking caret.
 *
 * Raw HTML stays OFF (react-markdown v10 default — no `rehype-raw`,
 * no `allowDangerousHtml`): a transcript can carry untrusted model/tool output.
 * `rehype-highlight` emits React <span> elements (not injected HTML), so
 * highlighting adds no raw-HTML surface.
 *
 * TYPOGRAPHY IS NOT HERE. Block rhythm, heading scale, list and quote spacing
 * all live in `.md-prose` (theme.css @layer components), shared with the
 * reasoning bodies below so one Markdown grammar covers every model-authored
 * body. This component keeps only what is per-instance: family, size, weight,
 * colour.
 */

// Stable module-scope plugin config. `remark-gfm` adds pipe tables (+ autolinks/
// strikethrough). Rehype highlighting is shared with the code-theme preview;
// it tokenizes fenced ```lang blocks into highlight.js `hljs-*` spans.
const REMARK_PLUGINS = [remarkGfm]

/**
 * Matches content whose last non-blank line is a closing code fence (three or
 * more backticks or tildes, optionally indented). When the message ends with a
 * fenced code block the block's own copy button is already in the bottom-right
 * corner, so the message-level `BubbleCopyChip` would double up.
 */
const TRAILING_CODE_FENCE_RE = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*\n?\s*$/

function AssistantProse({
  content,
  sourceId,
  sessionId,
  streaming,
}: {
  content: string
  sourceId: string
  sessionId: SessionId
  streaming?: true
}) {
  const toast = useToast()
  const filePathContext = useContext(FilePathMenuContext)
  const openFile = useCallback(
    (path: string): void => {
      void window.catcode
        .openWorkspaceFile(sessionId, path)
        .then(opened => {
          if (!opened) toast('Could not open this file', { tone: 'warn' })
        })
        .catch(() => toast('Could not open this file', { tone: 'warn' }))
    },
    [sessionId, toast],
  )
  const onContextMenu = useCallback(
    (anchor: FilePathActionsAnchor, path: string) => {
      filePathContext?.openFilePathMenu(anchor, path, sessionId)
    },
    [filePathContext, sessionId],
  )
  // The prototype's `showCopy` gate (Messages.jsx:2068): no chip while the reply
  // is still arriving (there is no settled answer to take yet, and the caret owns
  // that corner), and none on an empty turn. Also suppressed when the message
  // ends with a fenced code block: the block's own per-block copy button already
  // sits in the same corner, so doubling up is confusing (user report 2026-08-23).
  const endsWithCodeFence = TRAILING_CODE_FENCE_RE.test(content)
  const copyable = !streaming && content.trim().length > 0 && !endsWithCodeFence
  // The blockquote renderer closes over this message's raw source so its own
  // copy control can dequote by source position rather than re-deriving text
  // from the parsed tree. Keep its component type stable until that source
  // changes: otherwise React remounts each quote and loses its copy feedback.
  const components = useMemo(
    () => ({
      ...MARKDOWN_COMPONENTS,
      blockquote: createBlockquoteComponent(content),
      a: createPathAwareAnchor(openFile, onContextMenu),
      p: createPathAwareParagraph(openFile, onContextMenu),
      li: createPathAwareListItem(openFile, onContextMenu),
      code: createPathAwareCode(openFile, onContextMenu),
    }),
    [content, openFile, onContextMenu],
  )
  const { arrival } = useContext(ProseArrivalContext)
  // The source only ever grows by append, so the characters past the length this
  // row rendered at last is exactly what the newest batch delivered — an answer
  // that survives the tree restructuring retroactively when closing syntax
  // lands (`proseArrivalMark.ts`). Read during render, advanced after paint.
  const renderedLengthRef = useRef(0)
  const arrivalFrom = streaming === true ? renderedLengthRef.current : -1
  useEffect(() => {
    renderedLengthRef.current = streaming === true ? content.length : 0
  }, [content, streaming])
  const markArrival = useCallback(
    (tree: HastRoot): HastRoot => {
      const className = PROSE_ARRIVAL_WORD_CLASS[arrival]
      if (className === null || arrivalFrom < 0) return tree
      return markArrivedText(tree, {
        fromOffset: arrivalFrom,
        className,
        staggerMs: PROSE_ARRIVAL_WORD_STAGGER_MS[arrival],
        maxStaggerMs: MAX_PROSE_ARRIVAL_STAGGER_MS,
      })
    },
    [arrival, arrivalFrom],
  )
  return (
    // P4-38 host contract for `BubbleCopyChip`: `group relative` makes this body
    // the hover/focus group the absolute chip anchors to. No reserved right
    // gutter (operator call, 2026-08-02): the prototype's chip overlays the
    // last line rather than narrowing the column (Messages.jsx:2064-2091), and
    // the app's own reserved-gutter version read as an unexplained gap.
    <div className="group relative">
      <BoundedMarkdown
        sourceId={sourceId}
        source={content}
        rehypePlugins={REHYPE_PLUGINS}
        recognizeCallouts
        renderLeaf={leaf =>
          // A fence too long to mount whole arrives as one merged code leaf:
          // the card and its copy action own the WHOLE fence, while only the
          // windowed lines are mounted inside it.
          leaf.kind === 'code' ? (
            <MarkdownErrorBoundary fallback={leaf.codeSource}>
              <CodeBlock
                code={leaf.codeSource}
                streaming={leaf.codeOpen}
                highlighted={
                  <MarkdownTree
                    tree={markArrival(leaf.content)}
                    components={components}
                  />
                }
              />
            </MarkdownErrorBoundary>
          ) : (
            <div className="md-prose font-sans font-medium text-sm leading-relaxed">
              <MarkdownErrorBoundary fallback={content}>
                <MarkdownTree tree={markArrival(leaf.tree)} components={components} />
              </MarkdownErrorBoundary>
            </div>
          )
        }
      />
      {copyable ? (
        <BubbleCopyChip content={content} subject="response" />
      ) : null}
    </div>
  )
}

const FILE_PATH_RE =
  /(?:(?:\/|(?:\.{1,2}\/)|(?:[A-Za-z0-9_@.+-]+\/))(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+|[A-Za-z_@.][A-Za-z0-9_@.+-]*)\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/g
const WEB_PATH_RE =
  /^(?:www\.|(?:[A-Za-z0-9-]+\.)+(?:(?:com|org|net|io|dev|app|ai|co|edu|gov|me|xyz)(?:[/:]|$)|[A-Za-z]{2,}\/))/i

function isWebPath(path: string): boolean {
  return WEB_PATH_RE.test(path)
}

/**
 * A version string ("2.1.238", "v1.2.3") ends in a digits-only trailing segment,
 * so the path shapes below would otherwise linkify it. Every real extension
 * carries at least one letter.
 */
function hasLetteredExtension(path: string): boolean {
  return /[A-Za-z]/.test(path.slice(path.lastIndexOf('.') + 1))
}

function isInlineFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4_096 &&
    path === path.trim() &&
    !path.includes('\n') &&
    !path.includes('\0') &&
    !isWebPath(path) &&
    hasLetteredExtension(path) &&
    /(?:^|\/)[^/]+\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(path)
  )
}

function linkifyFilePathText(
  text: string,
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
): ReactNode {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const path = match[0]
    const index = match.index
    if (
      text.slice(0, index).endsWith(':/') ||
      path.startsWith('//') ||
      isWebPath(path) ||
      !hasLetteredExtension(path)
    ) {
      continue
    }
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(
      <button
        className="inline-flex items-center gap-0.5 rounded-sm align-baseline font-mono text-accent hover:text-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        key={`${index}:${path}`}
        type="button"
        aria-label={`Open ${path}`}
        onClick={() => openFile(path)}
        onContextMenu={event => {
          if (!onContextMenu) return
          event.preventDefault()
          event.stopPropagation()
          onContextMenu(
            { type: 'pointer', x: event.clientX, y: event.clientY },
            path,
          )
        }}
      >
        <ActionFileIcon />
        {path}
      </button>,
    )
    cursor = index + path.length
  }
  if (cursor === 0) return text
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)
}

function linkifyFilePathChildren(
  children: ReactNode,
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
): ReactNode {
  if (typeof children === 'string') {
    return linkifyFilePathText(children, openFile, onContextMenu)
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    if (
      typeof children.type !== 'string' ||
      children.type === 'a' ||
      children.type === 'button' ||
      children.type === 'code'
    ) {
      return children
    }
    return cloneElement(
      children,
      undefined,
      linkifyFilePathChildren(children.props.children, openFile, onContextMenu),
    )
  }
  if (!Array.isArray(children)) return children
  return children.map((child, index) => (
    <Fragment key={index}>
      {linkifyFilePathChildren(child, openFile, onContextMenu)}
    </Fragment>
  ))
}

function createPathAwareParagraph(
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
) {
  return function PathAwareParagraph({
    children,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<'p'> & { node?: unknown }) {
    void _node
    return <p {...props}>{linkifyFilePathChildren(children, openFile, onContextMenu)}</p>
  }
}

function createPathAwareListItem(
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
) {
  return function PathAwareListItem({
    children,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<'li'> & { node?: unknown }) {
    void _node
    return <li {...props}>{linkifyFilePathChildren(children, openFile, onContextMenu)}</li>
  }
}

/**
 * A markdown link is the ONE unambiguous file reference in assistant prose.
 * Desktop sessions ask the model for `[foo.ts](src/foo.ts)`, optionally with a
 * `:line` suffix, through the sidecar's own prompt addendum
 * (`app/sidecar/desktopSystemPrompt.ts`) — the engine's tone section teaches
 * the terminal's bare `file_path:line_number` instead, which only the regex
 * below can (approximately) resolve.
 * Returns the path to open, or null for anything addressed elsewhere
 * (a scheme, a protocol-relative host, a bare fragment). Containment inside the
 * session workspace is main's call, not the renderer's
 * (`app/main/openWorkspaceFile.ts`).
 */
function workspaceFileHref(href: string | undefined): string | null {
  if (href === undefined || href.length === 0) return null
  if (href.startsWith('#') || href.startsWith('//')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return null
  const path = href.replace(/[?#].*$/, '').replace(/:\d+(?::\d+)?$/, '')
  return path.length === 0 ? null : path
}

function createPathAwareAnchor(
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
) {
  return function PathAwareAnchor({
    children,
    href,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
    void _node
    const path = workspaceFileHref(href)
    // Everything else is an outside address. A same-window navigation is
    // refused by the navigation lockdown (T3), so an in-place <a> is a dead
    // control; `target="_blank"` reaches the window-open policy instead, which
    // hands https to the OS browser and denies the rest
    // (`app/main/navigationPolicy.ts`).
    if (path === null) {
      return (
        <a {...props} href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    }
    const rawPath = href ?? path
    return (
      <button
        className="inline-flex items-center gap-0.5 rounded-sm align-baseline text-accent hover:text-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        type="button"
        aria-label={`Open ${path}`}
        onClick={() => openFile(path)}
        onContextMenu={event => {
          if (!onContextMenu) return
          event.preventDefault()
          event.stopPropagation()
          onContextMenu(
            { type: 'pointer', x: event.clientX, y: event.clientY },
            rawPath,
          )
        }}
      >
        <ActionFileIcon />
        {children}
      </button>
    )
  }
}

function createPathAwareCode(
  openFile: (path: string) => void,
  onContextMenu?: (anchor: FilePathActionsAnchor, path: string) => void,
) {
  return function PathAwareCode({
    className,
    children,
  }: ComponentPropsWithoutRef<'code'>) {
    const text = childrenToText(children)
    if (!className && isInlineFilePath(text)) {
      return (
        <button
          className="inline-flex items-center gap-0.5 rounded-sm align-baseline text-accent hover:text-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          type="button"
          aria-label={`Open ${text}`}
          onClick={() => openFile(text)}
          onContextMenu={event => {
            if (!onContextMenu) return
            event.preventDefault()
            event.stopPropagation()
            onContextMenu(
              { type: 'pointer', x: event.clientX, y: event.clientY },
              text,
            )
          }}
        >
          <ActionFileIcon />
          <code>{children}</code>
        </button>
      )
    }
    return <MarkdownCode className={className}>{children}</MarkdownCode>
  }
}

/**
 * Render-error boundary (client runtime): a react-markdown throw degrades to the
 * plain markdown source instead of crashing the transcript subtree.
 */
class MarkdownErrorBoundary extends Component<
  { fallback: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-muted">
          {this.props.fallback}
        </pre>
      )
    }
    return this.props.children
  }
}

/**
 * Renders one mounted range of the message's single parsed document. It has to
 * be a component rather than a bare call so a throw lands inside
 * `MarkdownErrorBoundary` instead of taking the transcript subtree with it.
 */
function MarkdownTree({
  tree,
  components,
}: {
  tree: MountedMarkdownLeaf['tree']
  components?: MarkdownComponents
}) {
  return <>{renderMarkdownTree(tree, components)}</>
}

/** Flatten react-markdown code children (a string, a node array, or the
 * highlight.js <span> element tree `rehype-highlight` wraps tokens in) to raw
 * text — the copy button needs the un-tokenized source. */
function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (isValidElement(children)) {
    const props: unknown = children.props
    if (props !== null && typeof props === 'object' && 'children' in props) {
      return childrenToText((props as { children?: ReactNode }).children)
    }
  }
  return ''
}

const MARKDOWN_COMPONENTS = {
  // react-markdown wraps a fenced block in <pre><code>; unwrap the <pre> and let
  // the <code> renderer own the framed CodeBlock (avoids a nested <pre>).
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  code: MarkdownCode,
  aside: MarkdownCallout,
  // GFM pipe tables (remark-gfm). Exact prototype ProseTable values
  // (Messages.jsx:1890-1906): rounded 8px scroll wrapper w/ a 0.08 white border,
  // horizontal-only rules (header 0.12, body 0.05), a 0.03 header wash, 13px, and
  // the prototype's #e4e4e7 / #c4c4c8 cell text. Column alignment (remark-gfm's
  // per-cell `style`) is intentionally not forwarded — the prototype is
  // left-aligned throughout and this keeps zero inline style. Static arbitrary
  // classes only (the FAMILY_STYLE precedent for palette values with no token).
  table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-white/[0.08]">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: ComponentPropsWithoutRef<'th'>) => (
    <th className="whitespace-nowrap border-b border-white/[0.12] bg-white/[0.03] px-3 py-[7px] text-left font-semibold text-[light-dark(#27272a,#e4e4e7)]">
      {children}
    </th>
  ),
  td: ({ children }: ComponentPropsWithoutRef<'td'>) => (
    <td className="border-b border-white/[0.05] px-3 py-[7px] align-top text-[light-dark(#52525b,#c4c4c8)]">
      {children}
    </td>
  ),
}

function MarkdownCode({
  className,
  children,
}: ComponentPropsWithoutRef<'code'>) {
  const match = /language-(\w+)/.exec(className ?? '')
  const text = childrenToText(children)
  // Inline code (single backtick, no language, no newline) stays inline.
  if (!match && !text.includes('\n')) {
    return <code className={className}>{children}</code>
  }
  // Fenced block: `children` carries rehype-highlight's colored <span> tree for
  // DISPLAY; `text` is the raw source used by the copy button.
  return (
    <CodeBlock
      code={text.replace(/\n$/, '')}
      highlighted={children}
    />
  )
}

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

function MarkdownCallout({
  node,
  children,
}: ComponentPropsWithoutRef<'aside'> & {
  node?: { properties?: Record<string, unknown> }
}) {
  const kind = calloutKindOf(node?.properties?.dataCalloutKind)
  if (kind === null) return <aside>{children}</aside>

  return (
    <aside className="md-callout" data-callout-kind={kind}>
      <div className="md-callout-label">{calloutLabel(kind)}</div>
      <div className="md-callout-body">{children}</div>
    </aside>
  )
}

function calloutKindOf(value: unknown): CalloutKind | null {
  switch (value) {
    case 'note':
    case 'tip':
    case 'important':
    case 'warning':
    case 'caution':
      return value
    default:
      return null
  }
}

function calloutLabel(kind: CalloutKind): string {
  switch (kind) {
    case 'note':
      return 'Note'
    case 'tip':
      return 'Tip'
    case 'important':
      return 'Important'
    case 'warning':
      return 'Warning'
    case 'caution':
      return 'Caution'
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/**
 * Per-quote copy control: a tab in the message's own left margin, outside the
 * quote's text column entirely, so it can never land on top of the quoted
 * prose the way a corner-anchored control did (operator-reviewed against a
 * standalone options page after two corner placements both read poorly:
 * anchored to the border's own bottom-right it collided with
 * `BubbleCopyChip`'s bottom-right anchor on the whole message, and anchored
 * top-right-inside it drew over the first line's own words). Always visible,
 * not hover-gated — nothing to reveal it over, since it never overlaps
 * content by construction.
 *
 * Tinted with the app's own accent token, the same one `.md-prose a` already
 * uses for links, dim at rest and full strength on hover/copied, rather than a
 * neutral gray.
 */
function QuoteCopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 600)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Quote copied' : 'Copy quote'}
      title="Copy quote"
      className={`absolute -left-6 top-0 flex h-5 w-5 items-center justify-center rounded border transition-colors ${
        copied
          ? 'border-[light-dark(#15803d,#86efac)] text-[light-dark(#15803d,#86efac)]'
          : 'border-accent/30 text-accent/55 hover:border-accent hover:text-accent'
      }`}
    >
      {copied ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/**
 * Blockquote renderer, built per distinct `AssistantProse` source closing over
 * that message's raw markdown `rawSource` — `node.position` offsets are into
 * that string. `.md-prose blockquote` (theme.css) still supplies the
 * border/color styling by tag-name selector regardless of this component's own
 * className. `ml-7` reserves the left margin `QuoteCopyChip` sits in.
 */
function createBlockquoteComponent(rawSource: string) {
  return function Blockquote({
    node,
    children,
  }: ComponentPropsWithoutRef<'blockquote'> & {
    node?: { position?: QuotePosition }
  }) {
    const text = dequote(rawSource, node?.position)
    return (
      <blockquote className="relative ml-7">
        {children}
        {text.length > 0 ? <QuoteCopyChip text={text} /> : null}
      </blockquote>
    )
  }
}

/**
 * Fenced code block — exact prototype ProseCode grammar (Messages.jsx:1795-1828):
 * a page-black (#09090b = app-bg) panel with an 8px radius + 0.06 white border,
 * and a floating top-right copy control that does not reserve vertical space.
 * Syntax
 * tokens come from `rehype-highlight` (`hljs-*` <span>s colored by the fixed
 * Dracula stylesheet in theme.css). `highlighted` is the colored span tree for
 * DISPLAY; `code` is the raw source the copy button writes.
 *
 * The 5-theme Settings picker is a separate §5 ledger deferral (owner P4-18;
 * needs the Settings code-theme sync seam).
 */
export function CodeBlock({
  code,
  highlighted,
  streaming = false,
}: {
  code: string
  highlighted: ReactNode
  /** The fence is still arriving, so there is no finished block to copy. */
  streaming?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (streaming) return
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  // `data-window-ground`: this frame repeats the page ground rather than painting
  // a surface of its own, which is the whole grammar of a fenced block here
  // (`theme.css`: code sits IN the page, not on a coloured slab). Opaque that is
  // invisible, because `bg-app-bg` IS the page. Under glass the page goes
  // translucent and this did not, so the block became the flat slab the grammar
  // exists to avoid, whichever way the wallpaper pushed it. Marked so glass
  // clears it and the toggle stops changing this block's relationship to the
  // page it sits in.
  return (
    <div
      className="relative my-3 overflow-hidden rounded-lg border border-shell-seam bg-app-bg"
      data-window-ground
    >
      <button
        type="button"
        onClick={copy}
        disabled={streaming}
        title={streaming ? 'Code still writing' : copied ? 'Code copied' : 'Copy code'}
        aria-label={streaming ? 'Code still writing' : copied ? 'Code copied' : 'Copy code'}
        className={`absolute right-2 top-1 z-[1] inline-flex size-7 items-center justify-center rounded-md transition-colors ${
          streaming
            ? 'cursor-default text-text-ghost'
            : copied
              ? 'text-[light-dark(#15803d,#86efac)]'
              : 'text-text-subtle hover:bg-white/[0.06] hover:text-text-primary'
        }`}
      >
        {copied ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <ActionCopyIcon />
        )}
      </button>
      <pre className="overflow-x-auto px-3.5 py-3.5 font-mono text-[12.5px] leading-[1.65]">
        <code className="hljs">{highlighted}</code>
      </pre>
    </div>
  )
}

type ToolUseNestedRow = Extract<NestedTranscriptRow, { kind: 'tool-use' }>
type OrphanedAgentNestedRow = Extract<
  NestedTranscriptRow,
  { kind: 'orphaned-agent' }
>

/**
 * P4-18b tool-card FAMILY grammar (`Messages.jsx` FrameEShell). Each family's
 * identity is its glyph + uppercase word + accent, applied to the mark/word
 * ONLY (never rails or washes). These are STATIC class strings — Tailwind's
 * scanner never sees an interpolated `text-[${hex}]` (the dynamic-class trap),
 * so the family hues live as literal arbitrary-value classes in this map. The
 * hues match the prototype's family palette; tokenized ones (edit/agent pink,
 * `other` muted) reuse theme tokens.
 */
const FAMILY_STYLE: Record<
  ToolFamily,
  { mark: string; word: string; color: string }
> = {
  bash: { mark: '$', word: 'Bash', color: 'text-[light-dark(#4d7c0f,#a3e635)]' },
  read: { mark: '≡', word: 'Read', color: 'text-[light-dark(#2563eb,#60a5fa)]' },
  write: { mark: '+', word: 'Write', color: 'text-[light-dark(#c2410c,#fb923c)]' },
  edit: { mark: '±', word: 'Edit', color: 'text-accent' },
  grep: { mark: '⌕', word: 'Search', color: 'text-[light-dark(#a35f00,#fbbf24)]' },
  web: { mark: '↗', word: 'Web', color: 'text-[light-dark(#0e7490,#22d3ee)]' },
  mcp: { mark: '⧉', word: 'MCP', color: 'text-[light-dark(#7c3aed,#c084fc)]' },
  notebook: { mark: '▣', word: 'Notebook', color: 'text-[light-dark(#c2410c,#f97316)]' },
  lsp: { mark: '◈', word: 'LSP', color: 'text-[light-dark(#dc2626,#f87171)]' },
  skill: { mark: '§', word: 'Skill', color: 'text-[light-dark(#0f766e,#5eead4)]' },
  agent: { mark: '◆', word: 'Agent', color: 'text-accent' },
  // Same WORD as the spawn family, hollow mark against its filled one: ◆ creates
  // an agent, ◇ acts on one that already exists. The hue is the prototype's own
  // agent-family violet (`Messages.jsx` FE_FAMC `agent:'#a78bfa'`), which this
  // app left unused by tokenizing its agent family to `text-accent` — an
  // existing palette hue, not a new one. Literal class string, never
  // interpolated (the dynamic-class trap this map's header documents).
  'agent-control': { mark: '◇', word: 'Agent', color: 'text-[light-dark(#6d28d9,#a78bfa)]' },
  imagegen: { mark: '◰', word: 'Image', color: 'text-[light-dark(#a21caf,#e879f9)]' },
  other: { mark: '•', word: 'Tool', color: 'text-text-muted' },
}

/**
 * Cancellation is an engine-persisted result status. It is distinct from a
 * failed tool invocation and deliberately does not surface its interruption
 * protocol body.
 */
const STATE_STYLE: Record<
  ToolCardStatus,
  { word: string; color: string; dot: string; pulse: boolean }
> = {
  pending: { word: 'running', color: 'text-accent', dot: 'bg-accent', pulse: true },
  success: {
    word: 'done',
    color: 'text-tone-success',
    dot: 'bg-tone-success',
    pulse: false,
  },
  error: {
    word: 'failed',
    color: 'text-tone-danger',
    dot: 'bg-tone-danger',
    pulse: false,
  },
  cancelled: {
    word: 'stopped',
    color: 'text-tone-warn',
    dot: 'bg-tone-warn',
    pulse: false,
  },
}

/** Family-specific one-line target framing derived from the REAL tool input. */
function deriveTarget(
  row: ToolUseNestedRow,
  cwd: string | null = null,
): string {
  const input = row.input
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  switch (row.toolFamily) {
    case 'bash':
      return str('command') ?? row.toolName
    case 'read':
    case 'write':
    case 'edit': {
      const filePath = toolCardFilePath(row)
      return filePath === null ? row.toolName : displayFilePath(filePath, cwd)
    }
    case 'grep':
      return str('pattern') ?? str('path') ?? row.toolName
    case 'web':
      return str('url') ?? str('query') ?? row.toolName
    case 'notebook':
      return str('notebook_path') ?? str('path') ?? row.toolName
    case 'mcp':
      return mcpServerTool(row.toolName)
    case 'skill':
      return str('command') ?? str('skill') ?? row.toolName
    case 'imagegen':
      return str('prompt') ?? row.toolName
    case 'agent':
      // The Agent card's one-line target is the task, from the REAL tool input
      // (`Agent`/`Task` carry `description`/`prompt` — messageActions.tsx:107-114).
      return str('description') ?? str('prompt') ?? row.toolName
    case 'agent-control': {
      // The verb plus WHO it acted on, from each tool's real recipient key:
      // `agentId` (`ResumeAgentTool.tsx:25`) and `to` (`SendMessageTool.ts:91`).
      const recipient = str('agentId') ?? str('to')
      if (recipient === null) return row.toolName
      return row.toolName === 'ResumeAgent'
        ? `resume ${recipient}`
        : `message ${recipient}`
    }
    default:
      return row.toolName
  }
}

function toolCardFilePath(row: ToolUseNestedRow): string | null {
  if (
    row.toolFamily !== 'read' &&
    row.toolFamily !== 'write' &&
    row.toolFamily !== 'edit'
  ) {
    return null
  }
  const filePath = row.input['file_path']
  if (typeof filePath === 'string' && filePath.length > 0) return filePath
  return row.toolFamily === 'edit' ? row.result?.diff?.filePath ?? null : null
}

function displayFilePath(filePath: string, cwd: string | null): string {
  if (cwd === null || cwd.length === 0) return filePath
  const trimmedCwd = cwd.replace(/[/\\]+$/, '')
  const separator = trimmedCwd.includes('\\') ? '\\' : '/'
  const prefix = `${trimmedCwd}${separator}`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

/** `mcp__server__tool` → `server › tool` (the prototype's MCP framing). */
function mcpServerTool(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName
  const [, server, ...rest] = toolName.split('__')
  if (!server) return toolName
  return rest.length > 0 ? `${server} › ${rest.join('__')}` : server
}

/** Uppercase micro-label under the header, real data only (byte/line counts
 * the prototype shows are not projected — §5 flag, not mocked). */
function deriveSub(row: ToolUseNestedRow): string | undefined {
  if (row.toolFamily === 'mcp') return row.toolName
  return undefined
}

/**
 * The model's own words for a bash call, revealed over the target on hover or
 * keyboard focus. The header itself keeps the command: a column of cards is
 * read as commands, and a short one loses information when prose replaces it
 * (operator call, 2026-08-23). `bashCommandLabel.ts` for the two sources.
 */
function deriveTargetHover(row: ToolUseNestedRow): string | undefined {
  if (row.toolFamily !== 'bash') return undefined
  const command = row.input['command']
  const description = row.input['description']
  return (
    selectBashCardText(
      typeof command === 'string' && command.length > 0 ? command : null,
      typeof description === 'string' && description.length > 0
        ? description
        : null,
    ).hover ?? undefined
  )
}

/**
 * P4-REVIEW B3: pure resolution of the card's expanded state. `userExpanded`
 * is `null` until the user clicks the header (never toggled); while `null`,
 * `defaultExpanded` wins on EVERY render — so a live pending→error (or
 * imagegen success) status flip is reflected immediately, not just at first
 * mount. Once the user toggles, their choice wins over any later
 * `defaultExpanded` change. Exported so the decision logic is unit-testable
 * without a DOM (SSR can't exercise a live re-render).
 */
/**
 * Shared quiet-panel card shell (FrameEShell): mark · WORD · target ·
 * state-dot+word header, click-to-collapse body. Family identity colors the
 * mark/word only; the state cluster carries running/done/failed tone.
 */
function ToolCardShell({
  family,
  target,
  status,
  sub,
  headerBadge,
  targetHover,
  targetFilePath,
  collapsedExtra,
  defaultExpanded,
  expansionKey,
  children,
}: {
  family: ToolFamily
  target: string
  status: ToolCardStatus
  sub?: string
  /** Optional right-cluster chip before the state (C4 child-count for agents). */
  headerBadge?: ReactNode
  /**
   * Swapped in over `target` while the header is hovered or focused. Absent for
   * every family but bash, and for a bash call whose model sent no words of its
   * own (`bashCommandLabel.ts`).
   */
  targetHover?: string
  targetFilePath?: { rawPath: string; sessionId: SessionId }
  collapsedExtra?: ReactNode
  defaultExpanded?: boolean
  /**
   * The engine's `toolUseId`, so the user's expansion outlives this component.
   * A card can be re-keyed and re-typed underneath them when rows regroup
   * (`toolCardExpansion.ts`); without an identity here that click is lost. Null
   * for a shell with no single tool behind it, which then remembers per instance.
   */
  expansionKey?: string | null
  children?: ReactNode
}) {
  const [expanded, setExpanded] = useToolCardExpanded(
    expansionKey ?? null,
    defaultExpanded ?? false,
  )
  const fam = FAMILY_STYLE[family]
  const st = STATE_STYLE[status]
  const hasBody = children !== undefined && children !== null
  const { style } = useContext(ToolCardStyleContext)
  const filePathContext = useContext(FilePathMenuContext)
  return (
    <div className={TOOL_CARD_SHELL_CLASS[style]}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={TOOL_CARD_HEADER_CLASS[style]}
      >
        <span className={`w-4 shrink-0 text-center text-[13px] ${fam.color}`} aria-hidden>
          {fam.mark}
        </span>
        <span
          className={`shrink-0 text-[10.5px] font-bold uppercase tracking-[0.08em] ${fam.color}`}
        >
          {fam.word}
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-mono text-xs text-text-primary ${
            targetFilePath ? 'hover:text-accent-soft' : ''
          }`}
          title={targetFilePath ? 'Right-click for file actions' : undefined}
          onContextMenu={
            targetFilePath
              ? event => {
                  event.preventDefault()
                  event.stopPropagation()
                  filePathContext?.openFilePathMenu(
                    { type: 'pointer', x: event.clientX, y: event.clientY },
                    targetFilePath.rawPath,
                    targetFilePath.sessionId,
                  )
                }
              : undefined
          }
        >
          {targetHover === undefined ? (
            target
          ) : (
            <>
              <span className="group-hover:hidden group-focus-visible:hidden">
                {target}
              </span>
              {/* Focus as well as hover: the header is a button, so this is the
                  only way these words are reachable without a pointer. */}
              <span className="hidden font-sans text-text-subtle group-hover:inline group-focus-visible:inline">
                {targetHover}
              </span>
            </>
          )}
        </span>
        {headerBadge}
        {/* The word ("done"/"failed"/"running") next to a dot that already
            carries the same state in color is redundant chrome; the dot alone,
            colour-coded, is enough (operator call). */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`}
          role="img"
          aria-label={st.word}
        />
      </button>
      {!expanded && collapsedExtra ? collapsedExtra : null}
      {expanded && hasBody ? (
        <div className={TOOL_CARD_BODY_CLASS[style]}>
          {sub ? (
            <div className={TOOL_CARD_SUB_CLASS[style]}>{sub}</div>
          ) : null}
          <div className={TOOL_CARD_BODY_INNER_CLASS[style]}>{children}</div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * P4-18b tool card: dispatches the shared shell (family mark/word/target/
 * state-dot/collapse) with a per-family body rendered from the REAL projected
 * row (`input` + correlated `result.content`/`result.diff`, zero casts). Sub-
 * features that still need data the projector never surfaces (stdout/stderr
 * split, line/byte counts, real diagnostic severity, WebFetch content-type/size,
 * word-level intra-line diff) render truth or a flagged note — they are §5
 * ledger deferrals needing a projector data-contract change, NOT the P2-locked
 * render layer, and are never mocked.
 */
function ToolCard({ row }: { row: ToolUseNestedRow }) {
  // The weakest of the three expansion inputs: a user's own click still wins
  // (`resolveToolCardExpanded`), and a failed or finished-image card still opens
  // itself, for reasons this preference knows nothing about.
  const { expanded: toolsExpanded } = useContext(ToolsExpandedContext)
  const filePathContext = useContext(FilePathMenuContext)
  const filePath = toolCardFilePath(row)
  const target = deriveTarget(row, filePathContext?.cwd ?? null)
  const targetFilePath =
    filePath === null ? undefined : { rawPath: filePath, sessionId: row.sessionId }
  if (row.status === 'cancelled') {
    return (
      <ToolCardShell
        family={row.toolFamily}
        target={target}
        targetFilePath={targetFilePath}
        status={row.status}
        targetHover={deriveTargetHover(row)}
        expansionKey={row.toolUseId}
        defaultExpanded
      >
        <ToolCancelledBody />
      </ToolCardShell>
    )
  }
  // D2/C2: the Agent tool_use is rendered as the Agent member of this same
  // tool-card family (specialized body + C4 child nesting), not a sibling row.
  if (row.toolFamily === 'agent') return <AgentToolCard row={row} />
  if (row.toolName === 'TaskOutput' && row.result?.taskOutput) {
    return <TaskOutputCard row={row} />
  }
  if (
    row.toolFamily === 'imagegen' &&
    row.status === 'success' &&
    row.result?.generatedImage?.preview
  ) {
    return <CompletedGeneratedImageCard row={row} />
  }

  const content = row.result?.content ?? ''
  const isImageDone = row.toolFamily === 'imagegen' && row.status === 'success'
  const ack = toolAckForResult(row.result)
  const bashTail =
    row.toolFamily === 'bash' && ack === null ? bashTailForResult(row.result) : []
  const headerBadge =
    row.toolFamily === 'edit' || row.toolFamily === 'write'
      ? diffCountBadge(row)
      : undefined
  return (
    <div className="w-full">
      <ToolCardShell
        family={row.toolFamily}
        target={target}
        targetFilePath={targetFilePath}
        status={row.status}
        sub={deriveSub(row)}
        headerBadge={headerBadge}
        targetHover={deriveTargetHover(row)}
        expansionKey={row.toolUseId}
        defaultExpanded={
          toolsExpanded || row.status === 'error' || isImageDone
        }
        collapsedExtra={
          ack !== null ? (
            <AckPeek ack={ack} />
          ) : row.toolFamily === 'bash' && bashTail.length > 0 ? (
            <BashTailPeek tail={bashTail} />
          ) : null
        }
      >
        <ToolCardBody row={row} content={content} ack={ack} />
      </ToolCardShell>
      {row.children.length > 0 ? (
        <div className="mt-2 border-l border-accent/20 pl-3">
          <NestedRowList className="flex flex-col gap-2" rows={row.children} />
        </div>
      ) : null}
    </div>
  )
}

function ToolCancelledBody() {
  return (
    <p className="text-xs text-text-muted">
      This tool was stopped before it finished.
    </p>
  )
}

function TaskOutputCard({ row }: { row: ToolUseNestedRow }) {
  const output = row.result?.taskOutput
  if (!output) return null
  return (
    <ToolCardShell
      family="other"
      target="Task Output"
      status={row.status}
      expansionKey={row.toolUseId}
      defaultExpanded
      headerBadge={
        <span className="font-mono text-[10px] text-text-subtle">
          {output.taskId.slice(0, 8)}
        </span>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
          {output.description}
        </span>
        <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-muted">
          {output.output}
        </div>
      </div>
    </ToolCardShell>
  )
}

/**
 * The grouped tool card — ONE shell over a run, its body the list of member rows.
 * This is the prototype's `GroupedToolGroup`, which dispatches the same two kinds
 * on `groupKind` (`Messages.jsx:1088-1091`): the grouped `FileReadCard` branch
 * (`:580-597`) and the grouped `GrepCard` branch (`:672-698`). Derivation and its
 * rationale live in `toolRunLayout.ts`.
 *
 * The shell is the SAME `ToolCardShell` every tool card uses, exactly as the
 * prototype reuses `FrameEShell` for both — a run must not grow a second card
 * grammar.
 */
function ToolRunCard({
  family,
  members,
}: {
  family: ToolRunFamily
  members: ToolRunMember[]
}) {
  const { expanded: toolsExpanded } = useContext(ToolsExpandedContext)
  const filePathContext = useContext(FilePathMenuContext)
  const status = deriveToolRunStatus(members)
  // A member the user opened while it was still a LONE card keeps its content on
  // screen through the regroup. Without this the head would be collapsed by
  // default and their file would vanish anyway, remembered but invisible.
  //
  // This only has to survive the FIRST render after the regroup. From then on the
  // run has its own stored answer, because a member toggle pins its run open
  // (`ToolRunRow`) — otherwise closing the one member that held the run open would
  // collapse the entire run, siblings and all, which is the same snap-shut this
  // store exists to remove, one level up.
  const holdsOpenedMember = useAnyToolCardOpened(
    members.map(member => member.toolUseId),
  )
  const runKey = `run:${members[0]?.toolUseId ?? ''}`
  // Every payload is parsed ONCE PER RESULT, not once per render. The cache is what
  // makes that true (`digestByResult`): the head totals the members' digests and
  // each row shows its own, and rows are rebuilt every frame during streaming
  // (`attachChildren` spreads, `transcriptProjector.ts:617`) so component memo
  // alone would not stop a collapsed run re-parsing whole files on every frame.
  const digests = members.map(member => toolRunDigest(family, member))
  const head = toolRunHead(family, members, filePathContext?.cwd ?? null)
  const memberKeys = useMemo(() => members.map(member => member.id), [members])
  return (
    <ToolCardShell
      family={family}
      target={head.target}
      status={status}
      sub={head.sub}
      headerBadge={head.badge}
      defaultExpanded={toolsExpanded || status === 'error' || holdsOpenedMember}
      // The run's head is keyed off its FIRST member, which does not move as the
      // run grows — so opening a two-read run and watching it become a six-read
      // run keeps it open.
      expansionKey={runKey}
    >
      {/* Bounded: a run can accumulate thousands of members over a long turn,
          and the head above still counts every one of them. */}
      <BoundedChildList
        className="flex flex-col"
        estimatedChildHeight={RUN_MEMBER_ESTIMATED_HEIGHT}
        keys={memberKeys}
        renderChild={index => (
          <ToolRunRow
            family={family}
            row={members[index]}
            digest={digests[index]}
            hoistedPrefix={head.hoistedPrefix}
            runKey={runKey}
          />
        )}
      />
    </ToolCardShell>
  )
}

/**
 * The head's target and sub, per family, in the prototype's own words:
 * `N files` / `N files read` (`Messages.jsx:585-590`) and
 * `N patterns` / `M matches · N patterns` (`:677-680`).
 *
 * A READ run also hoists the directory its files share into `badge`, so the shared
 * part is stated once on the head instead of repeating down every row. That is the
 * design the operator picked from a side-by-side comparison, and it is what makes
 * the rows narrow enough to read. `commonDirPrefix` hoists nothing unless the run
 * really shares a full directory segment, so a run spanning two roots keeps whole
 * paths on its rows rather than being told they share `/`.
 *
 * The search total degrades rather than lying. A pattern run can mix output modes
 * (`grepResult.ts`), and summing a file count into a match count would print a
 * figure that means nothing, so `totalGrepDigest` returns null for a mixed run and
 * the sub falls back to the pattern count alone.
 */
function toolRunHead(
  family: ToolRunFamily,
  members: ToolRunMember[],
  cwd: string | null,
): {
  target: string
  sub: string
  badge: ReactNode
  hoistedPrefix: string
} {
  if (family === 'read') {
    const target = `${members.length} ${members.length === 1 ? 'file' : 'files'}`
    const hoistedPrefix = commonDirPrefix(members.map(memberReadPath))
    const displayPrefix = displayFilePath(hoistedPrefix, cwd)
    return {
      target,
      sub: `${target} read`,
      hoistedPrefix,
      badge:
        displayPrefix.length > 0 ? (
          <span className="shrink-0 truncate font-mono text-[11px] text-text-faint">
            {displayPrefix}
          </span>
        ) : undefined,
    }
  }
  const target = `${members.length} ${members.length === 1 ? 'pattern' : 'patterns'}`
  const total = totalGrepDigest(members.map(memberGrepDigest))
  return {
    target,
    sub: total === null ? target : `${formatGrepDigest(total)} · ${target}`,
    hoistedPrefix: '',
    badge: undefined,
  }
}

/** The file a read row names, or its tool name when the input carries no path. */
function memberReadPath(row: ToolRunMember): string {
  const filePath = row.input['file_path']
  return typeof filePath === 'string' && filePath.length > 0
    ? filePath
    : row.toolName
}

/**
 * Parsed digests, cached on the RESULT object.
 *
 * The nested projector preserves unchanged row identity, but result identity is
 * also stable across row reshaping. Keying here turns a per-frame full-file parse into one parse per tool
 * result, which matters because the parse runs even for a COLLAPSED run (the head
 * needs the totals) on a render path with no virtualization. WeakMap ⇒ entries die
 * with the result.
 */
const grepDigestByResult = new WeakMap<ToolResultProjection, GrepDigest | null>()
const readDigestByResult = new WeakMap<ToolResultProjection, string | null>()

/** One member's search digest, or null when it has no result to read one from. */
function memberGrepDigest(row: ToolRunMember): GrepDigest | null {
  const result = row.result
  if (result === null || result === undefined) return null
  if (result.isError === true) return null
  const cached = grepDigestByResult.get(result)
  if (cached !== undefined) return cached
  const digest = result.content.length === 0 ? null : grepDigest(result.content)
  grepDigestByResult.set(result, digest)
  return digest
}

/**
 * The run's own state. A run reports the worst outcome it contains, so a single
 * failed member inside six successes can never be hidden behind a green head: any
 * error wins, then any still-running member, and only an all-succeeded run reads
 * as done. The prototype's grouped cards have no per-item state to fold (their
 * items are fixtures with `path`/`lines`/`content` and `pattern`/`matches` only,
 * `Messages.jsx:1060`, `:686-690`), so this rule is 🔁 adapted to the real row's
 * `status`, not ported.
 */
function deriveToolRunStatus(members: ToolRunMember[]): ToolCardStatus {
  if (members.some(member => member.status === 'error')) return 'error'
  if (members.some(member => member.status === 'cancelled')) return 'cancelled'
  if (members.some(member => member.status === 'pending')) return 'pending'
  // Closed-union tripwire (house rule): a fourth `ToolCardStatus` must be ranked
  // here deliberately, not silently fold into `success` on a run head.
  const remaining: Exclude<ToolCardStatus, 'error' | 'cancelled' | 'pending'> =
    'success'
  return remaining
}

/**
 * One read inside a run (prototype `ReadGroupRow`, `Messages.jsx:1060-1084`):
 * caret · family mark · label · digest, expanding to that call's own body. A read
 * member reads `path` + `Read N lines` (`Messages.jsx:1070-1071`); a search member
 * reads `pattern` + its match count (`:688-689`).
 *
 * Three adaptations over the prototype rows, each because the real row carries
 * something its fixture did not:
 *
 *  1. A member that is not `success` shows the shared state cluster. A failed call
 *     must say so where it happened, not only on the head.
 *  2. The expanded body is the SHARED `ToolCardBody`, not a local line printer, so
 *     a member inherits the numbered/highlighted read body, the per-file search
 *     coloring, the truncation reveal band and the inspector route that the
 *     standalone card has.
 *  3. SEARCH members expand at all. The prototype's grep rows are inert — pattern
 *     and count, no caret, no click (`:686-691`) — because its fixture carries no
 *     output to open. Real search rows do, and their results are the entire point
 *     of running a search, so an inert row would make grouping a way to LOSE every
 *     result. Reads already had this level; searches now match it.
 *
 * The `memo` is worth little DURING a turn and is not what keeps the run cheap:
 * rows are rebuilt every frame, so the shallow compare misses. It helps only on a
 * re-render that does not touch the rows (opening the inspector, switching
 * reasoning mode). The parse cost is handled by `digestByResult` instead.
 */
const ToolRunRow = memo(function ToolRunRow({
  family,
  row,
  digest,
  hoistedPrefix,
  runKey,
}: {
  family: ToolRunFamily
  row: ToolRunMember
  digest: string | null
  hoistedPrefix: string
  runKey: string
}) {
  // Same three-input rule as the card, over the SAME three inputs: a failed member
  // opens itself, a live pending→error flip is reflected immediately, and the
  // user's own click beats both. The choice is kept by `toolUseId`, so a read the
  // user opened as a LONE card is still open once it folds into a run.
  //
  // `toolsExpanded` is threaded down deliberately. "Tools open by default" has to
  // reach the member or it stops meaning what it says: before grouping, each of
  // these calls was its own card and the preference opened it. It also decides
  // whether a search run is useful — the counts are on the member rows, but the
  // RESULTS only exist inside them.
  const { expanded: toolsExpanded } = useContext(ToolsExpandedContext)
  const [open, setOpen] = useToolCardExpanded(
    row.toolUseId,
    toolsExpanded || row.status === 'error',
  )
  const store = useToolCardExpansionStore()
  // Touching a member pins its RUN open. You can only reach a member row while the
  // run is open, so the click is itself evidence the run should stay open — and
  // without it, closing the member that auto-opened the run would fold the whole
  // group on the next render.
  const toggle = (next: boolean): void => {
    setOpen(next)
    store?.set(runKey, true)
  }
  const content = row.result?.content ?? ''
  const st = STATE_STYLE[row.status]
  const fam = FAMILY_STYLE[family]
  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded py-0.5 text-left hover:bg-white/[0.04]"
      >
        <span
          className={`w-2.5 shrink-0 text-[9px] leading-none text-text-ghost transition-transform duration-100 ease-out ${
            open ? 'rotate-90' : ''
          }`}
          aria-hidden
        >
          ▸
        </span>
        <span
          className={`w-3.5 shrink-0 text-center text-[13px] ${fam.color}`}
          aria-hidden
        >
          {fam.mark}
        </span>
        <ToolRunRowLabel family={family} row={row} hoistedPrefix={hoistedPrefix} />
        {digest !== null ? (
          <span className="shrink-0 font-mono text-[11px] text-text-subtle">
            {digest}
          </span>
        ) : null}
        {row.status !== 'success' ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`}
              aria-hidden
            />
            <span className={`text-[10.5px] ${st.color}`}>{st.word}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mb-1.5 ml-6 mt-0.5 border-l border-shell-seam pl-3">
          <ToolCardBody
            row={row}
            content={content}
            ack={toolAckForResult(row.result)}
          />
        </div>
      ) : null}
    </div>
  )
})

/**
 * The member's identifying text.
 *
 * A read drops the directory the whole run shares (the head states it once) and
 * splits what remains so the DIRECTORY is what truncates and the filename never
 * does: a run exists to tell two same-named files apart, and ellipsizing from the
 * right would eat the one part that does that. A ranged read also states its range,
 * as the prototype's row does (`Messages.jsx:1070` `· lines {item.range}`).
 *
 * A search has no such structure, so its pattern is one truncating run, and it
 * reuses `deriveTarget` rather than re-deriving which input field names a search.
 */
function ToolRunRowLabel({
  family,
  row,
  hoistedPrefix,
}: {
  family: ToolRunFamily
  row: ToolRunMember
  hoistedPrefix: string
}) {
  const filePathContext = useContext(FilePathMenuContext)
  if (family !== 'read') {
    return (
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
        {deriveTarget(row)}
      </span>
    )
  }
  const path = memberReadPath(row)
  const shown = path.startsWith(hoistedPrefix)
    ? path.slice(hoistedPrefix.length)
    : path
  const range = readRangeLabel(row)
  const onContextMenu = (event: ReactMouseEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    filePathContext?.openFilePathMenu(
      { type: 'pointer', x: event.clientX, y: event.clientY },
      path,
      row.sessionId,
    )
  }
  return (
    <span
      className="flex min-w-0 flex-1 font-mono text-xs text-text-primary hover:text-accent-soft"
      title="Right-click for file actions"
      onContextMenu={onContextMenu}
    >
      <span className="truncate text-text-ghost">{dirname(shown)}</span>
      <span className="shrink-0">{basename(shown) || shown}</span>
      {range === null ? null : (
        <span className="shrink-0 text-text-ghost">{range}</span>
      )}
    </span>
  )
}

/**
 * The range segment for a partial read, or null for a whole-file one.
 *
 * `offset` is ONE-BASED: the schema calls it "The line number to start reading
 * from", the tool defaults it to 1, and it becomes `startLine` verbatim, which is
 * the number the body's own gutter prints
 * (`src/tools/FileReadTool/FileReadTool.ts:229,496,1036` →
 * `addLineNumbers`, `src/utils/file.ts:290-306`). So the label states `offset`
 * itself. An earlier version added one to it and printed a number that
 * contradicted the gutter directly beneath it.
 *
 * A row with no `offset` and no `limit` read the whole file and says nothing,
 * rather than claiming a range it did not ask for, and a non-positive `limit`
 * (which the schema forbids) says nothing rather than inventing a one-line range.
 */
function readRangeLabel(row: ToolRunMember): string | null {
  const offset = row.input['offset']
  const limit = row.input['limit']
  const hasOffset = typeof offset === 'number' && Number.isFinite(offset)
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit)
  if (!hasOffset && !hasLimit) return null
  const start = hasOffset ? Math.max(0, Math.trunc(offset)) : 1
  if (!hasLimit) return `, from line ${start}`
  const count = Math.trunc(limit)
  if (count <= 0) return `, from line ${start}`
  const end = start + count - 1
  return end <= start ? `, line ${start}` : `, lines ${start} to ${end}`
}

/**
 * The right-hand digest, or null when the payload cannot supply one (an error, a
 * call still running, an unrecognised shape). Null renders nothing rather than a
 * zero, so a row never asserts a count it did not measure.
 *
 * A read reports a line count ONLY when the payload really was the engine's
 * numbered shape. Several SUCCESSFUL reads carry no file at all — an empty file and
 * an offset past EOF both return a `<system-reminder>` warning, and an unchanged
 * file returns a one-sentence stub (`FileReadTool.ts:685-703`) — and a memory-file
 * read prepends a freshness line that breaks the numbering (`:695`). Counting the
 * raw split there would report `Read 1 line` for an empty file and overcount a
 * memory file by its prefix, which is exactly the claim this doc comment forbids.
 */
function toolRunDigest(family: ToolRunFamily, row: ToolRunMember): string | null {
  if (family !== 'read') {
    const digest = memberGrepDigest(row)
    return digest === null ? null : formatGrepDigest(digest)
  }
  const result = row.result
  if (result === null || result === undefined) return null
  if (result.isError === true || result.content.length === 0) return null
  const cached = readDigestByResult.get(result)
  if (cached !== undefined) return cached
  const source = parseReadSource(result.content)
  const label =
    source.numbers === null
      ? null
      : `Read ${source.lines.length} ${source.lines.length === 1 ? 'line' : 'lines'}`
  readDigestByResult.set(result, label)
  return label
}

/**
 * The transcript-derived Agent source for the P4-2 vocabulary. Every field comes
 * from THIS row: the `tool_use` `input` (`subagent_type`/`description`/`prompt`/
 * `run_in_background`, the real Agent-tool input keys — `AgentTool/UI.tsx`) and
 * the read-time correlated `status`. It NEVER reads the session-plane
 * `agent-mode.snapshot` (`orchestratorState.ts`) — that cross-plane read is the
 * D2 §4 sin the decision forbids.
 */
function agentToolSourceOf(row: ToolUseNestedRow): AgentToolSource {
  const input = row.input
  const str = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const subagentType = str('subagent_type')
  const description = str('description')
  const prompt = str('prompt')
  const isLaunchRecord =
    (row.toolName === 'Agent' || row.toolName === 'Task') &&
    input.run_in_background === true
  // Identity is transcript-owned in either state: the completed result carries
  // it on the parent correlation, while a running worker carries it on its
  // nested progress frames. No live task snapshot joins this card.
  let nestedAgentName: string | undefined
  for (const child of row.children) {
    if (!('agentName' in child) || child.agentName === undefined) continue
    nestedAgentName = child.agentName
    break
  }
  const agentName =
    row.result?.agentName ??
    nestedAgentName
  // The worker's own id, which is what the face is keyed on: a name is not
  // unique per spawn and two workers can be told to run under one handle. It
  // rides the structured result (`transcriptProjector.ts` `agentId`), so a launch
  // ack has it immediately and a foreground worker only once it settles. A
  // running foreground card therefore draws by name first and adopts the id when
  // it lands, which does not move the face: the registry binds both to whichever
  // arrived first.
  const agentId = row.result?.agentId
  return {
    toolName: row.toolName === 'Task' ? 'Task' : 'Agent',
    status: row.status,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(input.run_in_background === true || row.toolName === 'ResumeAgent'
      ? { run_in_background: true }
      : {}),
    ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(!isLaunchRecord && row.agentCompletion !== null
      ? { hasCompletion: true, completionStatus: row.agentCompletion.status }
      : {}),
  }
}

/**
 * What the activity line says a nested BASH call is doing: the model's own
 * description, falling back to the command only when it wrote none.
 *
 * This is not the bash card header, which keeps the raw command by operator
 * call (2026-08-23, `bashCommandLabel.ts`) because a column of cards is read as
 * commands. The activity line is one truncated slot on someone ELSE's card, and
 * a long command spends all of it on a prefix that says nothing about the work.
 * The selection rule is shared, so a command with no description and no leading
 * `# comment` still shows the command.
 */
function agentActivityTarget(child: ToolUseNestedRow): string {
  if (child.toolFamily !== 'bash') return deriveTarget(child)
  const str = (key: string): string | null => {
    const value = child.input[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  return (
    selectBashCardText(str('command'), str('description')).hover ??
    deriveTarget(child)
  )
}

/**
 * The running card's live signal: the subagent's most recent nested tool call.
 * Only full frames arrive for subagents (§4/S1 — no nested streaming), so the
 * LAST tool-use child IS what the worker is doing right now. Null until the
 * first one lands, which is the real "spawned but nothing yet" moment.
 */
function agentActivityOf(row: ToolUseNestedRow): string | null {
  for (let index = row.children.length - 1; index >= 0; index -= 1) {
    const child = row.children[index]
    if (child === undefined || child.kind !== 'tool-use') continue
    const target = agentActivityTarget(child)
    // `agentActivityTarget` falls back to the tool's OWN name for several families, and
    // already spells MCP as `server › tool`. Prefixing either prints the name
    // twice ("TodoWrite TodoWrite") and pushes the badge past its truncation.
    //
    // Bash is unprefixed for a different reason: its target is a sentence the
    // worker wrote about its own work, or failing that a shell command. Both
    // read as what is happening; "Bash" in front of either only spends the slot.
    return (
      target === child.toolName ||
      child.toolFamily === 'mcp' ||
      child.toolFamily === 'bash'
    )
      ? target
      : `${child.toolName} ${target}`
  }
  return null
}

/**
 * Nested TOOL CALLS only. The count this replaced ("N nested") counted every
 * child row, mixing the worker's prose turns in with its tool calls, so two
 * agents that did identical work could report different numbers.
 */
function agentToolCallCount(row: ToolUseNestedRow): number {
  return row.children.reduce(
    (total, child) => (child.kind === 'tool-use' ? total + 1 : total),
    0,
  )
}

/**
 * The card's ONE right-hand slot, which holds exactly one thing: while a worker
 * is live it says what the worker is doing, and once it settles it says what the
 * worker cost. Never both, never a state word, and it may be absent.
 *
 * Counting nested rows is the last resort when restored result usage is absent.
 */
function agentProgressBadge(
  row: ToolUseNestedRow,
  state: AgentStateKey,
): string | null {
  const activity = agentActivityOf(row)
  if (state === 'running') return activity ?? 'starting'
  // A BACKGROUNDED agent yields no nested progress to this card: the async
  // branch returns its launch ack (`AgentTool.tsx:1279`) before the branch that
  // calls `onProgress` (`:1320`). So it has no activity to report, and
  // `starting` would sit there for the worker's entire life.
  //
  // It says so itself now. The redesign took the lifecycle word off the card
  // (2026-08-19), so with the slot empty and the face turned away this card
  // carried no statement at all that the worker went to the background.
  //
  // A LAUNCH RECORD says `launched`, not `backgrounded`. Both are state
  // `background` and both used to be told apart by the face alone — teal for the
  // ack, blue for a run genuinely under way. The face carries identity now
  // (2026-08-21), so the distinction moved into the word, where it says what it
  // means instead of relying on a reader knowing two shades of the same stamp.
  if (state === 'background') {
    const isLaunchRecord =
      (row.toolName === 'Agent' || row.toolName === 'Task') &&
      row.input.run_in_background === true
    return isLaunchRecord ? 'launched' : 'backgrounded'
  }
  const settledUsage = row.result?.agentUsage ?? null
  const toolCalls = settledUsage?.toolUses ?? agentToolCallCount(row)
  const parts: string[] = []
  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`)
  }
  // Built independently of the call count: an agent that answered from context
  // has real token usage and zero tool calls, and gating both on the count
  // threw the engine's own totals away.
  //
  // `> 0`, not merely present: a missing count is persisted as a literal zero
  // engine-side (`totalTokensOverride ?? 0`,
  // `src/tools/AgentTool/agentToolUtils.ts:694`, whose sibling branch logs
  // `finalize_missing_usage`), and that zero survives the projector's
  // all-or-nothing narrowing as a valid number. Printing it renders "we never
  // got usage" as the claim "0 tokens", beside a worker that made 55 tool calls.
  //
  // A worker that did not FINISH drops the figure whatever its value: its
  // totals are a partial tally, and printing them beside a row that has just
  // said Failed or Stopped invites the reader to compare a broken run's cost
  // against a whole one's.
  const settledWhole = state !== 'failed' && state !== 'stopped'
  if (settledWhole && settledUsage && settledUsage.totalTokens > 0) {
    parts.push(`${compactCount(settledUsage.totalTokens)} tokens`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * What line 1 calls a worker whose name has not arrived. Identity arrives LATE —
 * only after the first nested frame, and never at all on old or failed records —
 * so this is the first thing anyone sees, and the type word beside it has to
 * carry the row on its own until the name lands.
 */
const NAMELESS_AGENT_LABEL = 'AGENT'

/**
 * A ResumeAgent card's type word. It has no `subagent_type` of its own — the
 * input is an agent id and a follow-up prompt — and what matters about it is
 * that it is a second run of a worker that already existed.
 */
const RESUMED_TYPE_WORD = 'resumed'

/**
 * The model this worker actually ran on, transcript-plane only.
 *
 * Two sources for the same fact at two moments in a run: a SETTLED worker's own
 * structured result carries `model` (`AgentToolResult.model`), and a RUNNING one
 * has no result yet, so it is read off the `model` its nested assistant frames
 * carry. Both replay from history; neither joins a live snapshot (D2 §4).
 *
 * The first nested frame, not the last: it is the same value for the whole run
 * (the engine resolves the subagent's model once), and reading forward keeps the
 * card from re-rendering a different string as children arrive.
 */
function agentModelOf(row: ToolUseNestedRow): string | null {
  const settled = row.result?.agentModel
  if (settled !== undefined) return settled
  for (const child of row.children) {
    if (!('model' in child) || child.model === undefined) continue
    return child.model
  }
  return null
}

/**
 * The Codex account this worker is holding, or null.
 *
 * A LIVE join, and the only thing on the card that is not transcript-plane. It is
 * deliberate and operator-ruled (2026-08-19): the account is the one fact a
 * reader needs to answer "which of my accounts is this burning", and the
 * transcript carries no such field. The join key needs no new plumbing on either
 * side — `LeaseOwnerRow.ownerId` IS the subagent's `agentId`
 * (`protocol.ts` JOIN KEY note), and the Agent tool's own structured result
 * carries that `agentId` for both the sync and the background paths
 * (`AgentTool.tsx:1306` async ack).
 *
 * TWO sources, live first. The lease join answers while the worker is running
 * and follows it across a failover; it goes null the moment the worker finishes,
 * because `releaseCodexLease` DELETES the entry rather than marking it, so the
 * settled answer comes from the result's own stamp (`agentAccount`) instead.
 * Live is preferred over the stamp for the one case where they can disagree: a
 * background worker's stamp is written at dispatch and cannot be amended.
 *
 * Null is still the ORDINARY case and must stay silent, not blank: an
 * Anthropic-path worker holds no Codex lease at all, and a run recorded before
 * the engine stamped its result carries neither. The account renders when it is
 * knowable and is absent otherwise; nothing on the row claims a slot that can
 * empty.
 */
function agentAccountLabel(
  row: ToolUseNestedRow,
  leases: LeaseSnapshot | null,
): string | null {
  const lease =
    selectLeaseForOwner(leases, row.result?.agentId ?? null) ??
    selectLeaseForLabel(leases, agentLeaseLabelOf(row))
  if (lease !== null) return leaseAccountShortLabel(lease)
  const stamped = row.result?.agentAccount
  return stamped === undefined ? null : leaseAccountShortLabel(stamped)
}

/**
 * The label this row's lease was registered under: the Agent tool's own
 * `description` argument, which `registerWorkerCodexLease` passes straight
 * through as `ownerLabel` (`src/tools/AgentTool/AgentTool.tsx:1502`).
 *
 * Read raw off the input rather than from `deriveTarget`, which is display text
 * and may be shortened or fall back to other fields — the join needs the exact
 * string the engine registered. A ResumeAgent row has no `description` and needs
 * none: the projector resolves its `agentId` from the input, so it joins on the
 * key above.
 */
function agentLeaseLabelOf(row: ToolUseNestedRow): string | null {
  const description = row.input.description
  return typeof description === 'string' && description.length > 0
    ? description
    : null
}

/**
 * The model as a reader knows it. The raw id is a dated slug
 * (`claude-sonnet-5-20260115`), and the app already speaks the engine's own
 * marketing vocabulary on the composer rail, so the card speaks it too:
 * `Sonnet 5`, `GPT-5.6 Luna` (`formatModelDisplayName`).
 *
 * An unrecognised id falls through as itself rather than being hidden — a model
 * this renderer has not been taught is still a true statement about the run.
 */
function agentModelLabel(row: ToolUseNestedRow): string | null {
  const model = agentModelOf(row)
  return model === null ? null : formatModelDisplayName(model)
}

/**
 * The type suffix on line 1: the engine's own `subagent_type`, lowercased so it
 * reads as a qualifier on the name rather than a second token competing with it.
 *
 * Deliberately NOT `agentTypeMeta().label`, which title-cases and folds
 * `general-purpose` into "Agent". The redesign dropped the AGENT family word, so
 * this is now the only place the row says what KIND of worker it is, and folding
 * two distinct configured types into one word costs the reader the distinction.
 * It can be any string from config, so it is only ever printed, never matched.
 */
function agentTypeWord(vocab: ReturnType<typeof deriveAgentDisplayVocabulary>): string | null {
  const type = vocab.identity.type
  return type === null ? null : type.toLowerCase()
}

/** Line 1: face, name, type, and the one right-hand slot. */
function AgentIdentityLine({
  axes,
  fill,
  pulse,
  name,
  nameToneClass,
  typeWord,
  slot,
  slotLive,
  slotYields = false,
}: {
  axes: FaceAxes
  fill: number
  pulse: boolean
  name: string | null
  nameToneClass: string
  typeWord: string | null
  slot: string | null
  slotLive: boolean
  /**
   * The card is offering its Background control, which pins itself to this same
   * right edge (`AGENT_BACKGROUND_ANCHOR_CLASS`). The slot steps aside on hover
   * so the two never overlap; both are right-anchored, so neither moves.
   */
  slotYields?: boolean
}) {
  const { style } = useContext(ToolCardStyleContext)
  // `span`, not `div`: on a card with a body the whole two-line block IS the
  // collapse button, and only phrasing content may live inside a `button`. That
  // is also why the Background control is NOT rendered here: an interactive
  // element nested in a `button` makes the HTML parser close the outer one, so it
  // rides as a sibling of the collapse button instead (`AgentToolCard`).
  return (
    <span className={`flex items-center gap-[9px] ${TOOL_CARD_INSET_CLASS[style]}`}>
      <AgentFace axes={axes} fill={fill} pulse={pulse} />
      <span className="inline-flex min-w-0 items-baseline gap-1.5">
        {/* The name is absent until the worker's first nested frame lands, and
            on old or failed records it never arrives — so the slot has to stand
            on its own rather than collapse (see `agentToolSourceOf`). */}
        {name === null ? (
          <span className="shrink-0 font-mono text-[13px] font-semibold tracking-[0.04em] text-text-muted">
            {NAMELESS_AGENT_LABEL}
          </span>
        ) : (
          <span className={`shrink-0 font-mono text-[13px] font-semibold ${nameToneClass}`}>
            {name}
          </span>
        )}
        {typeWord === null ? null : (
          <span className="min-w-0 truncate font-mono text-[11px] lowercase text-text-faint">
            {typeWord}
          </span>
        )}
      </span>
      {slot === null ? null : (
        <span
          className={`ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums ${
            slotYields ? 'group-hover/agentcard:invisible ' : ''
          }${slotLive ? 'text-blue-400' : 'text-text-subtle'}`}
        >
          {slot}
        </span>
      )}
    </span>
  )
}

/**
 * Line 2: the task, closed by the model.
 *
 * Colour comes from `theme.css`'s text ramp, NOT from the design source's own
 * hexes. The source was authored without knowledge of the ramp, and its greys
 * land beside existing tokens rather than on them (`#9a9aa1` is `text-subtle`
 * two units off); the ramp is tuned, WCAG-checked and moves as a set, so the
 * card moves with it. Each value is mapped by what this exact spot already used:
 * the one-line target has always been `text-primary`, the model sits one step
 * down at `text-subtle`.
 *
 * The task is the ONLY element on the card allowed to shrink — everything else is `shrink-0` and `whitespace-nowrap`,
 * so a long task ellipsises and nothing else on the line reflows.
 *
 * §0 flag — 🔁 deferred(account): the design closes this line with the account
 * the worker ran on, and no such fact exists on the transcript plane. The only
 * account fact the app holds is `LeaseOwnerRow.accountAlias` on the session-plane
 * `lease.snapshot` (Codex-only, and gone with the engine process), and joining
 * that onto a transcript card is exactly the cross-plane read
 * `decisions/AGENT-CHROME.md` §4 forbids. Surfacing it needs a transcript-plane
 * field, which is a protocol decision, not a render choice.
 */
function AgentTaskLine({
  stateWord,
  stateToneClass,
  task,
  model,
  account,
}: {
  stateWord: string | null
  stateToneClass: string
  task: string
  model: string | null
  account: string | null
}) {
  const { style } = useContext(ToolCardStyleContext)
  return (
    <span
      className={`flex items-center gap-2.5 ${TOOL_CARD_DIVIDER_CLASS[style]} ${TOOL_CARD_INSET_CLASS[style]}`}
    >
      {stateWord === null ? null : (
        <span
          className={`shrink-0 whitespace-nowrap text-[11px] font-medium ${stateToneClass}`}
        >
          {stateWord}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-text-primary">
        {task}
      </span>
      {model === null && account === null ? null : (
        <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
          {model === null ? null : (
            <span className="font-mono text-[11px] text-text-subtle">{model}</span>
          )}
          {/* The hairline earns its place only between two things. */}
          {model !== null && account !== null ? (
            <span className="h-2.5 w-px bg-white/15" aria-hidden />
          ) : null}
          {account === null ? null : (
            <span className="font-mono text-[11px] text-text-muted">{account}</span>
          )}
        </span>
      )}
    </span>
  )
}

/**
 * A resume the engine refused. There is no worker to describe, so the card has
 * no identity line at all: a dim hollow mark, the resume prompt, and a green dot
 * — the CALL succeeded, only its answer was a refusal — with the refusal itself
 * on a line below.
 *
 * The band under it is the ack's own message; the body still expands to the full
 * result, because an ack that carries more than a message would otherwise lose
 * everything else it said.
 */
function RejectedResumeCard({
  row,
  ack,
  expanded,
  setExpanded,
}: {
  row: ToolUseNestedRow
  ack: ToolAck
  expanded: boolean
  setExpanded: (next: boolean) => void
}) {
  const { style: cardStyle } = useContext(ToolCardStyleContext)
  return (
    <div className={TOOL_CARD_SHELL_CLASS[cardStyle]}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={TOOL_CARD_PLAIN_HEADER_CLASS[cardStyle]}
      >
        <span className="shrink-0 text-[12px] leading-[12px] text-text-ghost" aria-hidden>
          ◇
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-text-primary">
          {deriveTarget(row)}
        </span>
        <span className="size-[7px] shrink-0 rounded-full bg-tone-good" aria-hidden />
      </button>
      <div className={TOOL_CARD_BAND_CLASS[cardStyle]}>
        <span className="block truncate font-mono text-[11px] leading-relaxed text-tone-danger">
          {ack.message}
        </span>
      </div>
      {expanded ? (
        <div
          className={`${TOOL_CARD_BODY_CLASS[cardStyle]} ${TOOL_CARD_BODY_INNER_CLASS[cardStyle]}`}
        >
          <ToolCardBody row={row} content={row.result?.content ?? ''} ack={ack} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * D2/C4 inline Agent card — the Agent member of the P2-2 tool-card family
 * (`decisions/AGENT-CHROME.md` §2), fed from TRANSCRIPT-derived data only
 * (`agentToolSourceOf`): identity from the row's `input` and its nested frames,
 * state from its read-time `status` (`deriveAgentToolState`), activity and cost
 * from its children and its structured result.
 *
 * Two lines, both always visible (2026-08-19 redesign). Line 1 is identity: the
 * face, the name, the type, and ONE right-hand slot. Line 2 is the task, closed
 * by the model. What the redesign REMOVED is as load-bearing as what it added,
 * so none of it comes back: the ◆ mark and the AGENT family word (every row here
 * is an agent, and the two glyphs spent ~90px of the left edge saying so), the
 * role dot (the face is the identity mark now, so a second coloured identity
 * mark answered the same question twice), the identity strip as its own band, and the
 * lifecycle word everywhere except Failed and Stopped, which need to stop a
 * reader scanning.
 *
 * C4: subagent child rows NEST inside this card's collapsible body, COLLAPSED by
 * default, never interleaved at the transcript top level. A card with no
 * children and no separate completion has nothing to expand to and so gets no
 * click affordance at all, rather than a button that opens onto nothing.
 * Owner/handoff is a session-plane (`LocalAgentTask`) fact, absent from this
 * frame, and is never fabricated here.
 */
function AgentToolCard({ row }: { row: ToolUseNestedRow }) {
  const { style: cardStyle } = useContext(ToolCardStyleContext)
  const faces = useAgentFaceRegistry()
  const leases = useContext(LeaseSnapshotContext)
  const agentBackground = useContext(AgentBackgroundContext)
  const resumeAck =
    row.toolName === 'ResumeAgent' ? toolAckForResult(row.result) : null
  const vocab = deriveAgentDisplayVocabulary(agentToolSourceOf(row))
  const isLaunchRecord =
    (row.toolName === 'Agent' || row.toolName === 'Task') &&
    row.input.run_in_background === true
  const completion = isLaunchRecord ? null : row.agentCompletion
  const childCount = row.children.length
  // ONE expression, so the card's `body` stays null when there is genuinely no
  // body — two sibling expressions would make it an array and give every
  // childless agent card an affordance that expands to nothing.
  const body =
    childCount === 0 && completion === null ? null : (
      <div className="flex flex-col gap-2">
        {childCount > 0 ? (
          <div className="border-l border-accent/20 pl-3">
            <NestedRowList className="flex flex-col gap-2" rows={row.children} />
          </div>
        ) : null}
        {/* A background agent's real outcome, joined in from its
            task-notification turn. Null for a foreground agent, whose answer
            is the correlated tool result the shell already renders. */}
        {completion !== null ? (
          <AgentCompletionBody completion={completion} />
        ) : null}
      </div>
    )
  // A resumed run opens when its completion supplies the answer, and an errored
  // row still opens itself; ordinary foreground and launch-record cards keep the
  // C4 collapsed default. ONE subscription for both card shapes — the rejected
  // resume below is handed this pair rather than claiming the same key twice.
  const [expanded, setExpanded] = useToolCardExpanded(
    row.toolUseId,
    completion !== null || row.status === 'error',
  )

  if (resumeAck && !resumeAck.ok) {
    return (
      <RejectedResumeCard
        row={row}
        ack={resumeAck}
        expanded={expanded}
        setExpanded={setExpanded}
      />
    )
  }

  const state = vocab.state.key
  // The id, with the name only as an alias: an id is unique per spawn and a name
  // is not, so two workers running under one handle stay two faces.
  const face = faces.faceFor(vocab.identity.id, vocab.identity.name)
  const facePulse = agentFacePulse(state, { isLaunchRecord })
  const nameToneClass = (
    vocab.type ? AGENT_TYPE_TONE_CLASS[vocab.type.tone] : AGENT_TYPE_TONE_CLASS.neutral
  ).text
  // NOT gated on `isLaunchRecord`: `agentProgressBadge` already answers
  // "backgrounded" for `state === 'background'`, and overriding on the record
  // shape instead of the state made a launch whose `tool_result` errored say
  // "backgrounded" beside line 2's "Failed".
  const slot = agentProgressBadge(row, state)
  // The two states that need to stop a reader mid-scan keep their word; every
  // other state is told by the face's pulse and the right-hand slot. NOT by its
  // colour: that is the worker's own identity, handed out by the session
  // registry, and it never moves with a state.
  const stateWord =
    state === 'failed' || state === 'stopped' ? vocab.state.label : null
  // Only a worker the live snapshot still reports as FOREGROUND gets the control;
  // a backgrounded, finished or launch-record card has nothing to offer. The set
  // gates display only — the sidecar re-resolves and fails closed.
  const backgroundAction =
    agentBackground !== null && agentBackground.backgroundable.has(row.toolUseId)
      ? agentBackground
      : null
  const lines = (
    <>
      <AgentIdentityLine
        axes={face.axes}
        fill={face.fill}
        pulse={facePulse}
        name={vocab.identity.name}
        nameToneClass={nameToneClass}
        typeWord={
          row.toolName === 'ResumeAgent' ? RESUMED_TYPE_WORD : agentTypeWord(vocab)
        }
        slot={slot}
        slotLive={!isLaunchRecord && (state === 'running' || state === 'background')}
        slotYields={backgroundAction !== null}
      />
      <AgentTaskLine
        stateWord={stateWord}
        stateToneClass={AGENT_STATE_TONE_CLASS[vocab.state.tone].text}
        task={deriveTarget(row)}
        model={agentModelLabel(row)}
        account={agentAccountLabel(row, leases)}
      />
    </>
  )
  return (
    <div
      className={`${TOOL_CARD_SHELL_CLASS[cardStyle]} group/agentcard relative`}
    >
      {backgroundAction === null ? null : (
        <button
          className={`invisible absolute top-0 z-10 flex items-center whitespace-nowrap font-mono text-[11px] text-text-subtle group-hover/agentcard:visible hover:text-text-primary ${AGENT_BACKGROUND_ANCHOR_CLASS[cardStyle]}`}
          onClick={() => backgroundAction.onBackground(row.toolUseId)}
          title="Keep this worker running in the background"
          type="button"
        >
          Send to background
        </button>
      )}
      {body === null ? (
        lines
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="block w-full text-left"
        >
          {lines}
        </button>
      )}
      {/* The card ran and answered; only its steps are gone. Said in the same
          quiet register as the orphan placeholder's band and the retention
          boundary, because nothing here failed and there is nothing to fix. */}
      {row.stepsNotLoaded === true ? (
        <div
          className={`flex items-center ${TOOL_CARD_DIVIDER_CLASS[cardStyle]} ${TOOL_CARD_INSET_CLASS[cardStyle]} text-[13.5px] leading-[18px] text-text-muted`}
        >
          {STEPS_NOT_LOADED_LABEL}
        </div>
      ) : null}
      {expanded && body !== null ? (
        <div
          className={`${TOOL_CARD_BODY_CLASS[cardStyle]} ${TOOL_CARD_BODY_INNER_CLASS[cardStyle]}`}
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The stand-in for an agent whose card is NOT in the transcript
 * (`OrphanedAgentRow` — truncation drops the oldest frames first, so a long
 * agent run outlives the `tool_use` that launched it).
 *
 * It is a frame, not a card: no state word, no cost, no task line. Every one of
 * those is a claim the missing parent carried, and the whole point of this row
 * is that the parent is not here to make them. It carries the one thing the
 * loose rows could not say for themselves, that an AGENT produced them, and it
 * keeps them collapsed by default exactly as an Agent card keeps its children
 * (C4).
 *
 * The face is the one exception, added 2026-08-21 once the stamp became identity
 * only: it says WHO, which is the missing parent's other unanswered question,
 * and it makes no claim about a run. It is keyed on the NAME alone, because the
 * agent id lives on the card that is gone. A run with no name left behind draws
 * the featureless stamp, exactly as an unattributable finish row does. Without it those rows render by kind alone at the top
 * level, where a subagent's task prompt is a user bubble and its prose is the
 * main assistant's reply.
 */
function OrphanedAgentCard({ row }: { row: OrphanedAgentNestedRow }) {
  // Keyed by the missing parent, so the reader's open/closed choice survives a
  // remount the same way a real card's does. Deliberately the SAME key a real
  // Agent card uses: no collision is possible while this row exists (it exists
  // because that id has no card here), and if a deeper resume later brings the
  // real card back, it should open the way the reader left this one.
  const [expanded, setExpanded] = useToolCardExpanded(row.missingToolUseId, false)
  const { style: cardStyle } = useContext(ToolCardStyleContext)
  const orphanFace = useAgentFaceRegistry().faceFor(null, row.agentName)
  // MESSAGES, not rows. One assistant message projects one row per content
  // block, so counting `children` reports "4 messages" for a single reply that
  // thought, spoke twice and called a tool.
  const count = new Set(
    row.children.map(child =>
      'messageId' in child ? child.messageId : child.frameId,
    ),
  ).size
  return (
    <div className={TOOL_CARD_ORPHAN_SHELL_CLASS[cardStyle]}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <AgentFace axes={orphanFace.axes} fill={orphanFace.fill} size={17} />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold leading-[18px] text-text-muted">
          {row.agentName ?? NAMELESS_AGENT_LABEL}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-text-subtle">
          {count} {count === 1 ? 'message' : 'messages'}
        </span>
      </button>
      <div className="flex items-center border-t border-shell-seam px-3 py-[7px] text-[13.5px] leading-[18px] text-text-muted">
        The rest of this agent run is no longer shown.
      </div>
      {expanded ? (
        <div className="border-t border-shell-seam bg-black/[0.28] px-3 pb-2.5 pt-1">
          <div className="border-l border-accent/20 pl-3">
            <NestedRowList className="flex flex-col gap-2" rows={row.children} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * D2/§3 DelegateGroup — parallel agents the orchestrator co-spawned in one turn
 * (same `message.id` — `src/utils/groupToolUses.ts:76`) render as ONE grouped
 * card instead of N sibling cards; a member never also appears on its own
 * elsewhere. Grouping is a read-time DERIVATION (`groupAgentDelegates`), never a
 * new frame or message type (C3).
 *
 * The header stacks its members' own faces, names the set, and closes with what
 * has NOT settled. It can never say finished while a member is still out, which
 * is why the tail is built from member STATE and not from raw `status`: a
 * backgrounded member's `tool_result` only says it started
 * (`deriveAgentToolState`), so counting statuses would report the set complete
 * while a member was still running.
 */
/**
 * How many member faces the group header stacks. The stack is a glance at WHO is
 * in the set, not a census — the label beside it already counts them — and a
 * group can hold thousands (CC-59), which is a thousand SVGs in a header that
 * exists to be read in one look.
 */
const MAX_STACKED_GROUP_FACES = 5

function DelegateGroup({ members }: { members: NestedToolUseRow[] }) {
  const faces = useAgentFaceRegistry()
  const memberKeys = useMemo(() => members.map(member => member.id), [members])
  const vocabs = members.map(member => deriveAgentDisplayVocabulary(agentToolSourceOf(member)))
  const runningCount = vocabs.filter(
    vocab => vocab.state.key === 'running' || vocab.state.key === 'background',
  ).length
  const failedCount = vocabs.filter(vocab => vocab.state.key === 'failed').length
  const types = vocabs.map(vocab => agentTypeWord(vocab))
  const commonType =
    types.length > 0 && types[0] !== null && types.every(type => type === types[0])
      ? types[0]
      : null
  const label = `${members.length} ${commonType === null ? '' : `${commonType} `}${
    members.length === 1 ? 'worker' : 'workers'
  }`
  const tail =
    runningCount > 0
      ? { text: `${runningCount} still running`, tone: 'text-blue-400' }
      : failedCount > 0
        ? { text: `${failedCount} failed`, tone: 'text-tone-danger' }
        : null
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.02]">
      <div className="flex items-center gap-[9px] border-b border-shell-seam px-3 py-1.5">
        <span className="inline-flex shrink-0 items-center">
          {members.slice(0, MAX_STACKED_GROUP_FACES).map((member, index) => {
            const vocab = vocabs[index]
            const memberFace = faces.faceFor(vocab.identity.id, vocab.identity.name)
            const memberPulse = agentFacePulse(vocab.state.key, {
              isLaunchRecord:
                (member.toolName === 'Agent' || member.toolName === 'Task') &&
                member.input.run_in_background === true,
            })
            return (
              <span key={member.id} className={index === 0 ? '' : '-ml-[3px]'}>
                <AgentFace
                  axes={memberFace.axes}
                  fill={memberFace.fill}
                  pulse={memberPulse}
                  size={17}
                />
              </span>
            )
          })}
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-text-primary">
          {label}
        </span>
        {tail === null ? null : (
          <span
            className={`ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums ${tail.tone}`}
          >
            {tail.text}
          </span>
        )}
      </div>
      {/* Bounded: the header above keeps counting every member. */}
      <BoundedChildList
        className="flex flex-col gap-2 p-2"
        estimatedChildHeight={DELEGATE_MEMBER_ESTIMATED_HEIGHT}
        keys={memberKeys}
        renderChild={index => <AgentToolCard row={members[index]} />}
      />
    </div>
  )
}

/** Per-family body from real data. */
function ToolCardBody({
  row,
  content,
  ack,
}: {
  row: ToolUseNestedRow
  content: string
  ack: ToolAck | null
}) {
  // Read before any early return so the hook order is stable across families.
  // The reveal band's escape hatch, over this same real projected row; null
  // outside a transcript, where the band simply omits the button.
  const openInspector = useContext(ToolInspectorContext)
  const openFull = openInspector ? () => openInspector(row) : null

  if (row.result?.diff) return <DiffView diff={row.result.diff} />

  const errorTone = row.result?.isError === true
  // Only an EXACT ack replaces the body: a richer object's other fields would
  // vanish with no way to notice they were there (`toolAck.ts` `exact`).
  if (ack !== null && ack.exact) return <AckBody ack={ack} input={row.input} />
  if (!row.result) {
    // No correlated result yet: show the real input so a running/queued tool is
    // legible rather than blank.
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-text-subtle">
        {stringifyInput(row.input)}
      </pre>
    )
  }
  if (content.length === 0) {
    return (
      <div className="font-mono text-[11.5px] italic text-text-subtle">
        {errorTone ? 'Failed with no output.' : 'No output.'}
      </div>
    )
  }

  switch (row.toolFamily) {
    case 'bash':
      return (
        <BashBody
          content={content}
          isError={errorTone}
          onOpenFull={openFull}
          toolUseId={row.toolUseId}
        />
      )
    case 'grep':
      return (
        <GrepBody
          content={content}
          isError={errorTone}
          onOpenFull={openFull}
          toolUseId={row.toolUseId}
        />
      )
    case 'read':
      return (
        <NumberedBody
          content={content}
          filePath={row.input['file_path']}
          onOpenFull={openFull}
          toolUseId={row.toolUseId}
        />
      )
    case 'write':
      return (
        <WriteBody
          written={row.input['content']}
          filePath={row.input['file_path']}
          result={content}
          isError={errorTone}
          onOpenFull={openFull}
          toolUseId={row.toolUseId}
        />
      )
    case 'imagegen':
      return <ImageResultBody content={content} isError={errorTone} />
    default:
      return (
        <PlainLinesBody
          content={content}
          isError={errorTone}
          onOpenFull={openFull}
          toolUseId={row.toolUseId}
        />
      )
  }
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return '[uninspectable input]'
  }
}

/**
 * The prototype's `OutputLines` body (`Messages.jsx:232-244`): one semantically
 * tinted div per line. Bash output is the only body routed through it, which is
 * the prototype's own split — `OutputLines` carries the bash card and the output
 * drawer (`:423,491,525,550-554`), while the Grep/Web/Mcp/Skill bodies take flat
 * `FE_T.t2` plus `hl()` syntax coloring (`:695,715,734,788`) instead.
 *
 * An errored result overrides every line to the danger tint rather than tinting
 * per line: the outcome is already known, and running the heuristic over a stack
 * trace would paint most of it as ordinary output.
 */
function renderLogLine(
  line: string,
  isError: boolean,
  lineNumber: number,
) {
  return (
    <div key={lineNumber} className="flex">
      <span className={LOG_GUTTER_CLASS}>{lineNumber}</span>
      <span className={isError ? 'text-tone-danger' : logLineClass(line)}>
        {line || ' '}
      </span>
    </div>
  )
}

function BashBody({
  content,
  isError,
  onOpenFull,
  toolUseId,
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  const lines = useMemo(() => content.split('\n'), [content])
  const { window, visibleLines, revealMore } = useInlineOutputWindow(
    lines,
    toolUseId,
  )
  return (
    <VirtualLineList
      lines={visibleLines}
      activeIndex={null}
      className={`${INLINE_OUTPUT_SCROLLER} whitespace-pre font-mono text-[11.5px] leading-relaxed`}
      renderBeforeIndex={
        window.truncated
          ? index =>
              index === window.head.length ? (
                <InlineRevealBand
                  hidden={window.hidden}
                  revealStep={window.revealStep}
                  onReveal={revealMore}
                  onOpenFull={onOpenFull}
                />
              ) : null
          : undefined
      }
      renderLine={(line, index) =>
        renderLogLine(
          line,
          isError,
          index < window.head.length
            ? index + 1
            : window.tailStartLine + index - window.head.length,
        )
      }
    />
  )
}

/**
 * The output gutter (prototype `OutputLines`, `Messages.jsx:233`): `#3f3f46` =
 * `text-ghost`, right-aligned tabular numerals, 48px wide with 11px of padding.
 *
 * `sticky left-0` with an inherited background is the prototype's own, and it is
 * load-bearing rather than decoration: this body does not wrap, so a wide line
 * scrolls the box horizontally, and without it the numbers slide out of view
 * exactly when a long line makes you want them.
 */
const LOG_GUTTER_CLASS =
  'sticky left-0 w-12 shrink-0 select-none bg-inherit pr-[11px] text-right tabular-nums text-text-ghost'

/**
 * The inner scroll box every inline body shares (prototype `Messages.jsx:546`
 * `maxHeight:340, overflowY:auto, overflowX:auto`). The head+tail window and its
 * reveal band live INSIDE it, exactly as the prototype composes them, so the two
 * models are the same model: the window bounds how much is built, the box bounds
 * how much of it a card shows at once.
 */
const INLINE_OUTPUT_SCROLLER = 'max-h-[340px] overflow-auto'

/**
 * The same box for the bodies whose rows are source: type, size and leading are
 * set here and inherited by every row, so a row carries only its own gutter and
 * colour. `whitespace-pre` here is also what a wide line scrolls against.
 */
const SOURCE_OUTPUT_SCROLLER = `${INLINE_OUTPUT_SCROLLER} whitespace-pre font-mono text-[11.5px] leading-relaxed`

/**
 * `useState` half of the head+tail window. The reveal is monotonic, matching the
 * prototype: `headShown` only grows, and the band removes itself once the gap
 * closes, so there is no collapse control to un-reveal.
 */
function useInlineOutputWindow(lines: string[], toolUseId: string) {
  const store = useToolCardExpansionStore()
  const [headShown, setHeadShown] = useState(INLINE_HEAD_LINES)
  const rememberedHead = store?.getInlineOutputHead(toolUseId)
  const visibleHead = rememberedHead ?? headShown
  // Memoized on the source and the reveal extent, both of which change rarely.
  // The coloured bodies parse `visibleLines` once per identity change, so a
  // fresh array per render would re-tokenize the whole slice on every frame.
  const window = useMemo(
    () => selectInlineOutputWindow(lines, visibleHead),
    [lines, visibleHead],
  )
  const visibleLines = useMemo(
    () => (window.truncated ? [...window.head, ...window.tail] : window.head),
    [window],
  )
  return {
    window,
    visibleLines,
    revealMore: () => {
      const next = revealMoreLines(visibleHead, lines.length)
      store?.setInlineOutputHead(toolUseId, next)
      // A shared Map does not notify React. Keep local state in sync so the
      // clicked card repaints now; a remount reads the same value from the Map.
      setHeadShown(next)
    },
  }
}

/** Collapsed tail-peek: the last few output lines, faded (prototype bash peek). */
/**
 * The collapsed one-liner `FrameEShell` reserved its `collapsedExtra` slot for
 * and the prototype never built: "bash tail peek, agent one-liner"
 * (`Messages.jsx:93`). Same band, same 11px mono as `BashTailPeek` below, so an
 * ack card and a bash card read as one species at rest.
 *
 * Clipped to one line, never wrapped: a peek must not change the card's height
 * with the length of a sentence the operator did not choose. The full text is
 * one click away in the body.
 *
 * Tone comes from the ack's own `ok`, NOT the row status, because those disagree
 * exactly when it matters: a failed resume is a successful tool call, and the
 * header's `done` is a true statement about the call. No tick or cross glyph
 * rides along, for the reason `TaskNotificationBox` states: the engine's
 * sentence already ends in its own outcome, so a glyph prints it twice.
 */
function AckPeek({ ack }: { ack: ToolAck }) {
  const { style } = useContext(ToolCardStyleContext)
  return (
    <div className={TOOL_CARD_BAND_CLASS[style]}>
      <span
        className={`block truncate font-mono text-[11px] leading-relaxed ${
          ack.ok ? 'text-text-subtle/80' : 'text-tone-danger'
        }`}
      >
        {ack.message}
      </span>
    </div>
  )
}

/**
 * The expanded ack body, in `AgentCompletionBody`'s labelled-section grammar
 * (the prototype's `AgentTranscriptCard` result grammar, `AgentIdentity.jsx:225`).
 *
 * `Result` is the same sentence the peek clipped, now wrapped in full. `Sent` is
 * the prompt that went to the agent, which no card surfaced anywhere before —
 * it is the one thing expanding ADDS once the outcome is already visible
 * collapsed. Absent for an input with no prompt, rather than an empty label.
 */
function AckBody({
  ack,
  input,
}: {
  ack: ToolAck
  input: Record<string, unknown>
}) {
  // `prompt` is ResumeAgent's (`ResumeAgentTool.tsx:30`); `message` is
  // SendMessage's, which is a string OR a structured object — only the string
  // form is renderable prose here.
  const sent = [input.prompt, input.message].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
        Result
      </span>
      <div
        className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${
          ack.ok ? 'text-text-muted' : 'text-tone-danger'
        }`}
      >
        {ack.message}
      </div>
      {sent !== undefined ? (
        <>
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
            Sent
          </span>
          <div className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-muted">
            {sent}
          </div>
        </>
      ) : null}
    </div>
  )
}

function BashTailPeek({ tail }: { tail: string[] }) {
  const { style } = useContext(ToolCardStyleContext)
  if (tail.length === 0) return null
  return (
    <div className={TOOL_CARD_BAND_CLASS[style]}>
      {/* Tinted by the SAME rule as the expanded body. This peek is the only
       * thing a successful card shows until it is opened, and a collapsed card
       * is the default (the prototype's `toolsExpandedByDefault` is false), so
       * painting it one flat grey is what made a wall of finished commands read
       * as colourless no matter what the body underneath did. Nothing in the
       * prototype constrains this: it reserved a `collapsedExtra` slot and never
       * built a peek, so this component is ours. */}
      <pre className="overflow-hidden whitespace-pre font-mono text-[11px] leading-relaxed">
        {tail.map((line, index) => (
          <div key={index} className={logLineClass(line)}>
            {line}
          </div>
        ))}
      </pre>
    </div>
  )
}

/**
 * Whole-result card derivations are visible while collapsed, so they must not
 * repeat on every streamed frame. A correlated result object is immutable and
 * retained by reference until its row changes; WeakMap entries therefore die
 * with the result and require no eviction path.
 */
const toolAckByResult = new WeakMap<ToolResultProjection, ToolAck | null>()
const bashTailByResult = new WeakMap<ToolResultProjection, string[]>()

function toolAckForResult(result: ToolResultProjection | null): ToolAck | null {
  if (result === null) return null
  const cached = toolAckByResult.get(result)
  if (cached !== undefined) return cached
  const ack = parseToolAck(result.content)
  toolAckByResult.set(result, ack)
  return ack
}

function bashTailForResult(result: ToolResultProjection | null): string[] {
  if (result === null || result.content.length === 0) return []
  const cached = bashTailByResult.get(result)
  if (cached !== undefined) return cached
  const tail = selectPeekLines(result.content.split('\n'))
  bashTailByResult.set(result, tail)
  return tail
}


/**
 * The file-READ body: the file's own line numbers beside its syntax-colored
 * source (`readSource.ts` for why the numbers come out of the content, and
 * `ReadSourceLines.tsx` for why the color comes from the transcript's own
 * highlighter). A payload that is not the engine's numbered shape falls back to
 * counting positions and no color, which is what this body always did.
 */
function NumberedBody({
  content,
  filePath,
  onOpenFull,
  toolUseId,
}: {
  content: string
  filePath: unknown
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  const source = useMemo(() => parseReadSource(content), [content])
  // No numbers means we could not recognise the payload as a file read, so we
  // cannot claim to know what language it is in either.
  const lang = source.numbers === null ? null : readSourceLanguage(filePath)
  const { window, visibleLines, revealMore } = useInlineOutputWindow(
    source.lines,
    toolUseId,
  )
  const coloured = useMemo(
    () => selectHighlightedSourceRows(visibleLines, lang),
    [visibleLines, lang],
  )
  // The file's own numbers for both halves of the window, as one array indexed
  // by painted position, so a row states its real line whatever it took to
  // reach it.
  const numbers = useMemo(
    () => [
      ...readLineNumbers(source, 0, window.head.length),
      ...(window.truncated
        ? readLineNumbers(source, window.tailStartLine - 1, window.tail.length)
        : []),
    ],
    [source, window],
  )
  return (
    <VirtualLineList
      lines={visibleLines}
      activeIndex={null}
      className={SOURCE_OUTPUT_SCROLLER}
      renderBeforeIndex={
        window.truncated
          ? index =>
              index === window.head.length ? (
                <InlineRevealBand
                  hidden={window.hidden}
                  revealStep={window.revealStep}
                  onReveal={revealMore}
                  onOpenFull={onOpenFull}
                />
              ) : null
          : undefined
      }
      renderLine={(line, index) => (
        <ReadSourceRow
          number={numbers[index] ?? index + 1}
          body={coloured?.[index] ?? line}
          coloured={lang !== null}
        />
      )}
    />
  )
}

function AdditionsBody({
  content,
  filePath,
  onOpenFull,
  toolUseId,
}: {
  content: string
  filePath: unknown
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  const lines = useMemo(() => content.split('\n'), [content])
  const lang = readSourceLanguage(filePath)
  const { window, visibleLines, revealMore } = useInlineOutputWindow(
    lines,
    toolUseId,
  )
  const coloured = useMemo(
    () => selectHighlightedSourceRows(visibleLines, lang),
    [visibleLines, lang],
  )
  return (
    <VirtualLineList
      lines={visibleLines}
      activeIndex={null}
      className={SOURCE_OUTPUT_SCROLLER}
      renderBeforeIndex={
        window.truncated
          ? index =>
              index === window.head.length ? (
                <InlineRevealBand
                  hidden={window.hidden}
                  revealStep={window.revealStep}
                  onReveal={revealMore}
                  onOpenFull={onOpenFull}
                />
              ) : null
          : undefined
      }
      renderLine={(line, index) => (
        <AdditionSourceRow body={coloured?.[index] ?? line} />
      )}
    />
  )
}

/**
 * The file-WRITE body: the file that was written, as additions.
 *
 * WHICH STRING IS THE FILE. Not the result. `FileWriteTool` returns exactly two
 * sentences and no third shape — `File created successfully at: {path}` or
 * `The file {path} has been updated successfully.`
 * (`src/tools/FileWriteTool/FileWriteTool.ts:418-433`) — so feeding
 * `result.content` to an additions view painted one English sentence as a green
 * `+` added line, and painted a FAILURE the same way. The file itself is the
 * tool's INPUT (`content`, `FileWriteTool.ts:63` "The content to write to the
 * file"), which is on this row already and which `ToolCardBody` already renders
 * for a write that has not resolved yet. Reading it here needs no projector
 * change: it makes the `+` mean what it says, and it is the prototype's own
 * intent (`FileWriteCard`, `Messages.jsx:614-634`, whose fixtures put the
 * written file in `toolOutput`).
 *
 * A failed write has no file to show, so it falls back to the result text in
 * error tone rather than claiming additions that never landed.
 */
function WriteBody({
  written,
  filePath,
  result,
  isError,
  onOpenFull,
  toolUseId,
}: {
  /** Raw `input.content`, narrowed here rather than trusted. */
  written: unknown
  /** Raw `input.file_path`; only the extension is read, for the language. */
  filePath: unknown
  result: string
  isError: boolean
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  if (isError || typeof written !== 'string' || written.length === 0) {
    return (
      <PlainLinesBody
        content={result}
        isError={isError}
        onOpenFull={onOpenFull}
        toolUseId={toolUseId}
      />
    )
  }
  return (
    <AdditionsBody
      content={written}
      filePath={filePath}
      onOpenFull={onOpenFull}
      toolUseId={toolUseId}
    />
  )
}

/**
 * Search results: the `path:line:` locator recedes, the matched source stays at
 * the prototype's own body colour.
 *
 * 🔁 An adaptation of the prototype's flat `FE_T.t2` grep body
 * (`Messages.jsx:695`), and a deliberately conservative one: the MATCH keeps
 * exactly the colour the prototype gives it, and only the locator changes. In
 * real output the same long path repeats on every line and outweighs the match
 * it is pointing at, which the prototype's short fixture paths never showed. The
 * prototype's own `hl()` is still uncarried here (no single language to name
 * across a multi-file result).
 */
function GrepBody({
  content,
  isError,
  onOpenFull,
  toolUseId,
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  const lines = useMemo(() => content.split('\n'), [content])
  const { window, visibleLines, revealMore } = useInlineOutputWindow(
    lines,
    toolUseId,
  )
  // Locators padded to the body's widest, so every run's source starts at the
  // same x. The shared `max-content` grid this replaces cannot survive
  // windowing: it would resize its column as the mounted rows moved.
  const rows: readonly GrepRow[] = useMemo(
    () => selectGrepRows(visibleLines),
    [visibleLines],
  )
  const coloured = useMemo(() => selectGrepHighlightedRows(rows), [rows])
  // The virtualizer bounds the text it hands back, so it is given the BODIES,
  // never the raw lines: a match on a minified bundle is one logical line whose
  // locator is a few characters and whose body is a megabyte.
  const bodies = useMemo(() => rows.map(row => row.body), [rows])
  // A failed search has no results to color — it has an error message, which
  // takes the error tone whole rather than being parsed for locators.
  if (isError) return <ErrorLinesBody content={content} />
  return (
    <VirtualLineList
      lines={bodies}
      activeIndex={null}
      className={SOURCE_OUTPUT_SCROLLER}
      renderBeforeIndex={
        window.truncated
          ? index =>
              index === window.head.length ? (
                <InlineRevealBand
                  hidden={window.hidden}
                  revealStep={window.revealStep}
                  onReveal={revealMore}
                  onOpenFull={onOpenFull}
                />
              ) : null
          : undefined
      }
      renderLine={(body, index) => (
        <GrepSourceRow
          locator={rows[index]?.locator ?? null}
          body={coloured[index] ?? body}
          coloured={coloured[index] !== null}
        />
      )}
    />
  )
}

/**
 * A failed search or a failed image call: one message in the error tone, still
 * windowed. A stack trace is as long as any other output, and the reason the
 * call failed is no reason to mount all of it.
 */
function ErrorLinesBody({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content])
  return (
    <VirtualLineList
      lines={lines}
      activeIndex={null}
      className={`${INLINE_OUTPUT_SCROLLER} whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-tone-danger`}
      renderLine={line => <div>{line}</div>}
    />
  )
}

function PlainLinesBody({
  content,
  isError,
  onOpenFull,
  toolUseId,
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
  toolUseId: string
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines, toolUseId)
  // Flat `text-text-muted` is the prototype's own base here (`FE_T.t2` `#a1a1aa`),
  // and for Grep and Web it is the WHOLE colour rule (`Messages.jsx:695,715`).
  // Deliberately NOT the bash body's `logLineClass`: that heuristic belongs to
  // `OutputLines`, which the prototype routes bash output through and these
  // bodies never touch, and it would tint any line merely containing `WARNING`
  // or `✓`. Two prototype rules ARE still uncarried here, both pre-existing:
  // `hl()` syntax coloring (the open ledger gap under `FileReadCard`), and the
  // per-prefix tints Mcp and Skill add on top of the flat base — `→` lines in
  // `FE_T.add` and `›`/`skill` lines in `FE_T.t3` (`:734,788`).
  const toneClass = isError ? 'text-tone-danger' : 'text-text-muted'
  const visibleLines = window.truncated
    ? [...window.head, ...window.tail]
    : window.head
  return (
    <VirtualLineList
      lines={visibleLines}
      activeIndex={null}
      className={INLINE_OUTPUT_SCROLLER}
      renderBeforeIndex={
        window.truncated
          ? index =>
              index === window.head.length ? (
                <InlineRevealBand
                  hidden={window.hidden}
                  revealStep={window.revealStep}
                  onReveal={revealMore}
                  onOpenFull={onOpenFull}
                />
              ) : null
          : undefined
      }
      renderLine={(line, index) => (
        <pre
          key={index}
          className={`whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${toneClass}`}
        >
          {line}
        </pre>
      )}
    />
  )
}

function CompletedGeneratedImageCard({ row }: { row: ToolUseNestedRow }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedResetRef.current !== null) {
        clearTimeout(copiedResetRef.current)
      }
    },
    [],
  )
  const image = row.result?.generatedImage
  const preview = image?.preview
  if (!image || !preview) return null
  const prompt =
    image.revisedPrompt ??
    (typeof row.input['prompt'] === 'string' ? row.input['prompt'] : null)
  const formattedBytes =
    image.bytes >= 1_048_576
      ? `${(image.bytes / 1_048_576).toFixed(1)} MB`
      : image.bytes >= 1_024
        ? `${Math.round(image.bytes / 1_024)} KB`
        : `${image.bytes} B`
  const directory = dirname(image.filePath).replace(/[/\\]+$/, '')
  const directoryLabel = basename(directory)
  const savedTo = directoryLabel ? `${directoryLabel}/` : directory || image.filePath
  const copyPath = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) {
      if (copiedResetRef.current !== null) {
        clearTimeout(copiedResetRef.current)
        copiedResetRef.current = null
      }
      setCopied(false)
      toast('Could not write to the clipboard', { tone: 'warn' })
      return
    }
    void clipboard
      .writeText(image.filePath)
      .then(() => {
        setCopied(true)
        if (copiedResetRef.current !== null) {
          clearTimeout(copiedResetRef.current)
        }
        copiedResetRef.current = setTimeout(() => {
          setCopied(false)
          copiedResetRef.current = null
        }, 1300)
        toast('Path copied', { tone: 'success' })
      })
      .catch(() => {
        if (copiedResetRef.current !== null) {
          clearTimeout(copiedResetRef.current)
          copiedResetRef.current = null
        }
        setCopied(false)
        toast('Could not write to the clipboard', { tone: 'warn' })
      })
  }
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.025]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[light-dark(#a21caf,#e879f9)]" aria-hidden="true">◰</span>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[light-dark(#a21caf,#e879f9)]">
          Generate Image
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
          {image.model}
        </span>
        <span className="h-1.5 w-1.5 rounded-full bg-tone-success" aria-hidden="true" />
        <span className="text-[10.5px] text-tone-success">Done</span>
      </div>
      <div className="px-3 pb-3">
        <img
          alt="Generated image"
          className="mx-auto max-h-[520px] w-auto max-w-full rounded-[10px] border border-shell-seam object-contain"
          src={`data:${preview.mediaType};base64,${preview.data}`}
        />
        {prompt ? (
          <p className="mt-[11px] text-xs leading-relaxed text-text-muted">{prompt}</p>
        ) : null}
        <div className="mt-[11px] font-mono text-[11px] text-text-ghost">
          {[image.model, image.size, image.outputFormat.toUpperCase(), formattedBytes].join(
            ' · ',
          )}
        </div>
        <div className="mt-[11px] flex flex-wrap items-center gap-2.5">
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-text-ghost"
            title={image.filePath}
          >
            Saved to <span className="font-mono text-text-subtle">{savedTo}</span>
          </span>
          <button
            aria-label={copied ? 'Path copied' : 'Copy path'}
            className="rounded-md border border-shell-seam bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary"
            onClick={copyPath}
            type="button"
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </div>
      </div>
      {row.children.length > 0 ? (
        <div className="border-l border-accent/20 px-3 pb-3">
          <NestedRowList rows={row.children} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The image call's TEXT result, which is normally one sentence and is not
 * normally what a generation card shows at all (`CompletedGeneratedImageCard`
 * owns the picture). It reaches this body when the call failed or returned no
 * preview, and a failure carries whatever the provider sent, so it is windowed
 * like every other output rather than mounted whole.
 */
function ImageResultBody({ content, isError }: { content: string; isError: boolean }) {
  const lines = useMemo(() => content.split('\n'), [content])
  if (isError) return <ErrorLinesBody content={content} />
  return (
    <VirtualLineList
      lines={lines}
      activeIndex={null}
      className={`${INLINE_OUTPUT_SCROLLER} whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-muted`}
      renderLine={line => <div>{line}</div>}
    />
  )
}

/**
 * P4-36 inline truncation reveal band (prototype `Messages.jsx:438-457`), rendered
 * in the gap between the window's head and tail.
 *
 * It replaces the older one-line overflow note, which two of the four bodies never
 * called: a file read and a file write simply stopped mid-output, so the last
 * visible line read as the end of the file. The band states the gap, offers the
 * next step of it, and keeps the route to the complete text one click away.
 */
function InlineRevealBand({
  hidden,
  revealStep,
  onReveal,
  onOpenFull,
}: {
  hidden: number
  revealStep: number
  onReveal: () => void
  onOpenFull: (() => void) | null
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 font-mono text-[10.5px] leading-none">
      <span className="shrink-0 text-text-subtle">
        {hidden} {hidden === 1 ? 'line' : 'lines'} hidden
      </span>
      <span className="h-px flex-1 bg-shell-seam" />
      <button
        type="button"
        onClick={onReveal}
        className="shrink-0 rounded px-1 py-0.5 text-text-subtle hover:bg-white/[0.05] hover:text-text-muted"
      >
        Show {revealStep} more
      </button>
      {onOpenFull ? (
        <button
          type="button"
          onClick={onOpenFull}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-accent-soft/70 hover:bg-accent/10 hover:text-accent-soft"
        >
          Open full output
          <span aria-hidden>↗</span>
        </button>
      ) : null}
    </div>
  )
}

/**
 * Wording for the assistant-response copy chip's idle/done/toast states.
 */
const COPY_CHIP_TEXT = {
  response: {
    idle: 'Copy response',
    done: 'Response copied',
    toast: 'Copied response',
  },
} as const

/**
 * The hover-reveal copy chip mounted on the assistant body (Messages.jsx:2077).
 * Quiet until the host is hovered or something inside it takes focus, then a
 * small clipboard glyph in the bottom-right corner; the tick pins itself visible
 * for a beat so the confirmation survives the pointer leaving.
 *
 * HOST CONTRACT: the chip is `absolute`, so its host must be the positioned
 * hover group — `group relative`. Mounted under a host that is neither, it
 * anchors to a distant ancestor and never reveals. It overlays the corner
 * rather than reserving space for it, matching the prototype.
 *
 * `group-focus-within` is a real-added a11y fix: the prototype reveals on hover
 * ONLY, which leaves the control unreachable by keyboard. Icons are drawn inline
 * per component, the house pattern (there is no shared icon set).
 */
function BubbleCopyChip({
  content,
  subject,
}: {
  content: string
  subject: keyof typeof COPY_CHIP_TEXT
}) {
  const [copied, setCopied] = useState(false)
  const text = COPY_CHIP_TEXT[subject]
  const toast = useToast()
  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(content)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1300)
        // The prototype toasts as well as ticking (Messages.jsx:2096): the tick
        // is in the corner the pointer just left, so it is easy to miss.
        toast(text.toast, { tone: 'success' })
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? text.done : text.idle}
      title={text.idle}
      className={`absolute bottom-1.5 right-2 inline-flex items-center justify-center rounded-md p-1 opacity-0 transition-[color,opacity] duration-150 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${
        copied
          ? 'text-[light-dark(#15803d,#86efac)] opacity-100'
          : 'text-text-subtle hover:text-[light-dark(#3f3f46,#d4d4d8)]'
      }`}
    >
      {copied ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/**
 * "User side" grammar (Messages.jsx UserBubble): right-aligned, accent-tinted,
 * bottom-right-notched bubble. Shared shape with the command echo + image rows
 * so a user's own turns read as one column against the assistant's left body.
 * Live message actions occupy their own reserved row below the bubble so they
 * never cover or shift the user's visible text.
 */
function UserBubble({
  content,
  onEdit,
  onBranch,
}: {
  content: string
  onEdit?: () => void
  onBranch?: () => void
}) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedResetTimer.current !== null) {
        clearTimeout(copiedResetTimer.current)
      }
    },
    [],
  )
  if (!onEdit) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-accent/20 bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-text-primary">
          {content}
        </div>
      </div>
    )
  }
  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) {
      toast('Could not write to the clipboard', { tone: 'warn' })
      return
    }
    void clipboard
      .writeText(content)
      .then(() => {
        setCopied(true)
        if (copiedResetTimer.current !== null) {
          clearTimeout(copiedResetTimer.current)
        }
        copiedResetTimer.current = setTimeout(() => setCopied(false), 1300)
        toast('Message copied to clipboard', { tone: 'success' })
      })
      .catch(() =>
        toast('Could not write to the clipboard', { tone: 'warn' }),
      )
  }
  return (
    <div className="group/message flex flex-col items-end">
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-accent/20 bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-text-primary">
        {content}
      </div>
      <div className="flex h-[25px] items-center gap-0.5 pr-1 pt-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100">
        <button
          type="button"
          onClick={copy}
          title="Copy message"
          aria-label={copied ? 'Message copied' : 'Copy message'}
          className="inline-flex items-center justify-center rounded-md p-1 text-text-subtle transition-colors hover:bg-accent/15 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {copied ? (
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <ActionCopyIcon />
          )}
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Edit from here"
          aria-label="Edit from here"
          className="inline-flex items-center justify-center rounded-md p-1 text-text-subtle transition-colors hover:bg-accent/15 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ActionRewindIcon />
        </button>
        <button
          type="button"
          onClick={onBranch}
          title="Branch from here"
          aria-label="Branch from here"
          className="inline-flex items-center justify-center rounded-md p-1 text-text-subtle transition-colors hover:bg-accent/15 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ActionBranchIcon />
        </button>
      </div>
    </div>
  )
}

/**
 * CommandEchoRow: a user-invoked slash command / skill, in the user-side
 * bubble but mono (accent name + subtle args). The prototype deliberately
 * drops the TUI `❯` prompt glyph — the pink right-aligned mono bubble is the
 * GUI-native "user ran a command" signal.
 */
function CommandEchoBubble({
  commandName,
  args,
  skillFormat,
}: {
  commandName: string
  args: string | null
  skillFormat: boolean
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-accent/20 bg-accent/10 px-3.5 py-1.5 font-mono text-[12.5px] leading-relaxed">
        {skillFormat ? (
          <span className="text-accent">Skill({commandName})</span>
        ) : (
          <>
            <span className="text-accent">/{commandName}</span>
            {args ? <span className="text-text-subtle"> {args}</span> : null}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * UserImageRow: a pasted image content block. Right-aligned, user-side tinted
 * tile. Caption-less by design (the source shows only `[Image]`). Malformed or
 * empty sources degrade to a placeholder label rather than a broken `<img>`.
 */
function UserImageRowView({ source }: { source: UserImageSource }) {
  const src =
    source.type === 'base64'
      ? `data:${source.mediaType};base64,${source.data}`
      : source.url
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] rounded-2xl rounded-br border border-accent/20 bg-accent/[0.08] p-2">
        {src.length > 0 ? (
          <img
            src={src}
            alt="Pasted image"
            className="max-w-[220px] rounded-lg border border-shell-seam"
          />
        ) : (
          <span className="font-mono text-[11px] text-text-subtle">[Image]</span>
        )}
      </div>
    </div>
  )
}

/**
 * ThinkingBlock: reasoning body in an accent-tinted quiet card, italic subtle
 * prose. The prototype's expand/collapse is an interactive polish affordance
 * (18c); 18a renders the block expanded (flagged) so the reasoning is visible.
 */
function ThinkingBlock({ content, sourceId }: { content: string; sourceId: string }) {
  return (
    <div className="rounded-lg border border-accent/15 bg-accent/[0.04]">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent">
          Thinking
        </span>
      </div>
      <div className="border-t border-accent/10 px-3.5 py-2.5 text-[13px] italic leading-relaxed text-text-subtle">
        <BoundedMarkdown
          sourceId={sourceId}
          source={content}
          renderLeaf={leaf => (
            <div className="md-prose">
              <MarkdownErrorBoundary fallback={content}>
                <MarkdownTree tree={leaf.tree} />
              </MarkdownErrorBoundary>
            </div>
          )}
        />
      </div>
    </div>
  )
}

/* ── `trail` reasoning mode ──────────────────────────────────────────────────
 * The alternative to `ThinkingBlock` for models that expose short reasoning
 * SUMMARY headings rather than long-form reasoning prose. Steps are derived by
 * `reasoningLayout.ts` (which owns the wire shapes: `\n\n`-merged summary parts,
 * blank-bodied encrypted blocks, `reasoningKind`); this file only draws them.
 *
 *  - No frame. Every other model-activity row is boxed (tool cards bordered,
 *    notices washed, user turns bubbled); a four-word heading inside a card is
 *    mostly chrome. Grouping is carried by a 1px rail + 5px nodes — the same
 *    "belongs to the row above" device the nested-children lists already use.
 *  - One step is ONE row (`ReasoningLine`): a head, a rail and a single node
 *    spend two rows on four words with nothing to group or collapse. The trail
 *    form appears only when a second step exists.
 *  - Headings stay compact, but render their provider-supplied Markdown —
 *    models commonly emphasize the current action with `**bold**`, and the
 *    transcript must show that emphasis rather than exposing the delimiters.
 *  - Grey only. Accent stays with user turns, running work and the streaming
 *    caret; reasoning is background activity.
 *  - The encrypted signature is a SHAPE, never a payload: a hollow node and a
 *    fixed phrase, with no affordance suggesting something can be opened.
 */

/** The one-line honesty statement, on hover: these phrases are the model's own
 * summary of its reasoning, not the reasoning itself. Stated once per row/run,
 * never as a per-row badge (the `summary` sub-label was removed, #7). */
const REASONING_TITLE =
  'Short summary headings the model exposes about its reasoning, not the reasoning itself.'

/**
 * Render ceiling for one run. The run shows every step it has; this only stops a
 * pathological run from mounting an unbounded list, and no real run reaches it.
 */
const REASONING_RUN_MAX_STEPS = 1000

/** A step with actual content to draw — `withheld` steps carry nothing and are
 * dropped before a run ever reaches render. */
type VisibleReasoningStep = Exclude<ReasoningStepModel, { kind: 'withheld' }>

function isVisibleStep(step: ReasoningStepModel): step is VisibleReasoningStep {
  return step.kind !== 'withheld'
}

/**
 * A run of reasoning steps. `withheld` steps (nothing the provider shared) are
 * dropped rather than drawn as a placeholder line — an all-withheld run has
 * nothing left to show and renders nothing. One remaining step draws as a
 * single line (no head, no count, nothing to collapse); everything else gets
 * the head + rail + steps. The whole run collapses from its head; individual
 * steps never fold away.
 */
function ReasoningRun({ runId, steps }: { runId: string; steps: ReasoningStepModel[] }) {
  const listId = useId()
  const visible = steps.filter(isVisibleStep)
  // Kept OUTSIDE this component, for the same reason a tool card's expansion is
  // (`toolCardExpansion.ts`): a run inside a bounded container unmounts when it
  // scrolls out of the mounted range, and local state would hand it back open
  // after the user folded it away. The step key is minted from the run's first
  // member row id, so it survives the row being re-projected. Namespaced because
  // the store is keyed by string and a run is not a tool call, exactly as
  // `ToolRunCard` already stores `run:<id>`. It is the RUN's id, not the first
  // visible step's: a first member that is still streaming has no visible step,
  // so a visibility-derived key flips when its content arrives and the fold the
  // user chose is lost.
  const [expanded, setExpanded] = useToolCardExpanded(runId, true)
  const collapsed = !expanded

  if (visible.length === 0) return null
  if (visible.length === 1) {
    const [step] = visible
    if (step.kind === 'heading') return <ReasoningLine content={step.text} />
  }

  const shown =
    visible.length > REASONING_RUN_MAX_STEPS
      ? visible.slice(visible.length - REASONING_RUN_MAX_STEPS)
      : visible
  return (
    <div className="group flex flex-col">
      <button
        type="button"
        aria-controls={listId}
        aria-expanded={!collapsed}
        onClick={() => setExpanded(collapsed)}
        title={REASONING_TITLE}
        className="flex w-full items-center gap-2.5 py-px text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/40"
      >
        <span
          className={`inline-block w-4 shrink-0 text-center text-[9px] leading-none text-text-ghost transition-[transform,color] duration-100 ease-out group-hover:text-text-subtle ${
            collapsed ? '-rotate-90' : ''
          }`}
          aria-hidden
        >
          ▾
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle transition-colors duration-100 ease-out group-hover:text-text-muted">
          Reasoning
        </span>
        {visible.length > 1 ? (
          <span className="text-[10.5px] text-text-faint transition-colors duration-100 ease-out group-hover:text-text-subtle">
            {/* Counts what is ON SCREEN. The ceiling below drops the oldest steps,
                and a head that kept printing the raw total would assert a list
                longer than the one it labels. */}
            {shown.length === visible.length
              ? `${visible.length} steps`
              : `${shown.length} of ${visible.length} steps`}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <ol
          id={listId}
          className="ml-2 mt-0.5 border-l border-white/10 pl-[17px] transition-colors duration-100 ease-out group-hover:border-white/[0.16]"
        >
          {shown.map(step => (
            <ReasoningStep key={step.key} step={step} />
          ))}
        </ol>
      )}
    </div>
  )
}

/**
 * One step on the rail. Memoized on the step model, which `reasoningStepsForRow`
 * derives from a slice-stable row: without this a prose step re-parses its
 * markdown on every streamed frame, since the run itself re-renders whenever the
 * transcript's rows array is rebuilt (`transcriptProjector.ts` per-delta rebuild).
 */
const ReasoningStep = memo(function ReasoningStep({
  step,
}: {
  step: VisibleReasoningStep
}) {
  return (
    <li
      className="relative py-0.5 text-[12.5px] leading-normal text-text-subtle"
      title={REASONING_TITLE}
    >
      <ReasoningNode placement="rail" />
      {step.kind === 'heading' ? (
        <ReasoningHeading content={step.text} />
      ) : (
        <ReasoningProse content={step.text} sourceId={step.key} />
      )}
    </li>
  )
})

const REASONING_NODE_PLACEMENT: Record<'rail' | 'inline', string> = {
  // Centred on the run rail (the <ol>'s left border), from inside a step <li>.
  rail: '-left-[20px]',
  // Centred in the 16px mark gutter of a lone, rail-less row.
  inline: 'left-[5.5px]',
}

/** The rail node. Filled = a readable step; hollow = nothing to read. */
function ReasoningNode({
  placement,
  withheld = false,
}: {
  placement: 'rail' | 'inline'
  withheld?: boolean
}) {
  return (
    <span
      className={`absolute top-[9px] h-[5px] w-[5px] rounded-full ${
        REASONING_NODE_PLACEMENT[placement]
      } ${withheld ? 'border border-text-ghost' : 'bg-text-ghost'}`}
      aria-hidden
    />
  )
}

/** A step that is real reasoning text rather than a heading: the body renders in
 * the app's ordinary prose grammar under its own step, and can be folded away on
 * its own so one long body does not push the rest of the run off-screen (the
 * run's head collapses everything; this collapses just this step). */
function ReasoningProse({ content, sourceId }: { content: string; sourceId: string }) {
  const [hidden, setHidden] = useState(false)
  return (
    <>
      {hidden ? null : (
        <div className="md-prose mb-1.5 mt-1 border-l border-shell-seam pl-2.5 text-[13px] leading-relaxed text-text-subtle">
          <BoundedMarkdown
            sourceId={sourceId}
            source={content}
            renderLeaf={leaf => (
              <MarkdownErrorBoundary fallback={content}>
                <MarkdownTree tree={leaf.tree} />
              </MarkdownErrorBoundary>
            )}
          />
        </div>
      )}
      <button
        type="button"
        aria-expanded={!hidden}
        onClick={() => setHidden(value => !value)}
        className="font-mono text-[10.5px] text-text-faint hover:text-text-subtle"
      >
        {hidden ? 'show reasoning' : 'hide'}
      </button>
    </>
  )
}

/**
 * Compact Markdown for a reasoning-summary heading. `react-markdown` normally
 * wraps a line in a paragraph; replacing that wrapper keeps the trail's
 * one-line layout while still interpreting inline Markdown such as emphasis,
 * strong text, code, and links. Raw HTML remains disabled by react-markdown.
 */
const REASONING_HEADING_COMPONENTS = {
  p: ({ children }: ComponentPropsWithoutRef<'p'>) => <>{children}</>,
}

function ReasoningHeading({ content }: { content: string }) {
  return (
    <span className="break-words">
      <MarkdownErrorBoundary fallback={content}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          components={REASONING_HEADING_COMPONENTS}
        >
          {content}
        </Markdown>
      </MarkdownErrorBoundary>
    </span>
  )
}

/** A lone readable summary: node · label · phrase, on one row. */
function ReasoningLine({ content }: { content: string }) {
  return (
    <div
      className="relative py-0.5 pl-[26px] text-[12.5px] leading-normal text-text-subtle"
      title={REASONING_TITLE}
    >
      <ReasoningNode placement="inline" />
      <span className="mr-2 text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle">
        Reasoning
      </span>
      <ReasoningHeading content={content} />
    </div>
  )
}

/** A lone encrypted-only block: one row, no label — the phrase names itself.
 * The signature/`data` payload is never rendered, here or anywhere. */
function WithheldReasoningLine() {
  return (
    <div className="relative py-0.5 pl-[26px] text-[12.5px] leading-normal text-text-faint">
      <ReasoningNode placement="inline" withheld />
      {REASONING_WITHHELD_TEXT}
    </div>
  )
}

/** RedactedThinkingBlock: quiet neutral placeholder for provider-encrypted
 * reasoning — nothing to read, so a single non-collapsible lock row. */
function RedactedThinkingBlock() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-1.5">
      <span className="text-text-subtle/70" aria-hidden>
        🔒
      </span>
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle/70">
        Thinking
      </span>
      <span className="text-[11px] italic text-text-subtle/70">
        redacted by the model provider
      </span>
    </div>
  )
}

/**
 * SystemNoticeRow: the notice box for the projected notice types, each with its own
 * glyph + tone. The type is carried by that glyph and tone alone: it used to
 * also print the raw discriminant in the corner, which is a debug tag, not a
 * word anyone reads (CLAUDE.md §7).
 */
function SystemNoticeBox({
  noticeType,
  content,
}: {
  noticeType:
    | 'api_retry'
    | 'local_command_output'
    | 'account_diagnostic'
  content: string
}) {
  const { glyph, glyphTone } = NOTICE_STYLE[noticeType]
  return (
    <div className="flex items-start gap-2 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-1.5">
      <span className={`text-[12px] leading-5 ${glyphTone}`} aria-hidden>
        {glyph}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-text-muted">
        {content}
      </span>
    </div>
  )
}

const NOTICE_STYLE: Record<
  | 'api_retry'
  | 'local_command_output'
  | 'account_diagnostic',
  { glyph: string; glyphTone: string }
> = {
  api_retry: { glyph: '↻', glyphTone: 'text-tone-warn' },
  local_command_output: { glyph: '›', glyphTone: 'text-text-muted' },
  account_diagnostic: { glyph: '!', glyphTone: 'text-tone-warn' },
}


/**
 * The worker's own name out of the engine's summary. The engine mints exactly
 * `Agent @Name completed` / `… failed: …` / `… was stopped`, falling back to
 * `Agent "description" …` when the task had no name (`LocalAgentTask.tsx:325`),
 * so the `@` form is the presence test. Null keeps the featureless face — the
 * honest stamp for a finish we cannot attribute to anyone.
 */
function agentNameInSummary(summary: string): string | null {
  // Anchored on the three whole sentences the engine mints, because a worker
  // name may contain SPACES: `normalizeExplicitSubagentName`
  // (`src/tools/AgentTool/AgentTool.tsx:282`) rejects only `@`, `:` and `*`. A
  // `\\S+` capture read "Ada Lovelace" as "Ada" and handed the finish row a
  // different face from the card's, breaking the one invariant the stamp has.
  // Anything else returns null and keeps the featureless face, which is the
  // honest stamp for a finish we cannot attribute.
  const match = /^Agent @(.+?)(?: completed| failed:| was stopped)$/.exec(summary)
  return match === null ? null : match[1]
}

/**
 * TaskNotificationRow: a background agent's finish, in transcript arrival order.
 *
 * The engine's wording is printed VERBATIM, including the failure reason a card
 * never carries — this row is the only place a background worker's outcome is
 * stated, because its launch card is a past-tense record that never learns what
 * happened (a transcript row is never rewritten). The banner text this row rides
 * is MODEL-facing — it carries the task id, the output-file path and the
 * tool-use id — so only the engine's one-line `summary` is printed (bug,
 * 2026-08-01). No summary means no row, exactly as the terminal returns null
 * without one.
 *
 * No status word rides alongside: every summary already ends in its outcome, so
 * a chip would print the same word twice. The face here is identity only, drawn
 * with no pulse, so it carries no outcome at all. The worker's own name inside the sentence is set in mono so the row is scannable
 * against the card it belongs to.
 */
function TaskNotificationBox({ summary }: { summary: string | null }) {
  const faces = useAgentFaceRegistry()
  if (summary === null) return null
  const name = agentNameInSummary(summary)
  const notificationFace = faces.faceFor(null, name)
  // TWO jobs, and only one of them is the reader's. `mention` is the needle the
  // ENGINE wrote into its own sentence ("Agent @Ada completed"), so it keeps the
  // at-sign or the split silently stops matching and the name stops being
  // highlighted at all. What is rendered below is the bare name: the at-sign
  // never reaches the screen (operator ruling, 2026-08-21).
  const mention = name === null ? null : `@${name}`
  const [before, after] =
    mention === null ? [summary, ''] : splitOnce(summary, mention)
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-[5px]">
      <AgentFace
        axes={notificationFace.axes}
        fill={notificationFace.fill}
        size={17}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-text-muted">
        {before}
        {name === null ? null : (
          <span className="font-mono text-text-primary">{name}</span>
        )}
        {after}
      </span>
    </div>
  )
}

/** `text` around its first occurrence of `needle`; the needle itself is dropped. */
function splitOnce(text: string, needle: string): [string, string] {
  const at = text.indexOf(needle)
  return at === -1
    ? [text, '']
    : [text.slice(0, at), text.slice(at + needle.length)]
}

/** `1234` → `1.2k`; the agent card's stat line has no room for full counts. */
function compactCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`
}

/** `93000` → `1m 33s`; sub-minute stays in seconds. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * A resumed run's result. ResumeAgent creates a second independent agent card,
 * so the later completion supplies that card's labelled answer and stats. The
 * summary is not repeated because the identity strip and state already carry
 * it.
 */
function AgentCompletionBody({
  completion,
}: {
  completion: AgentCompletionProjection
}) {
  const { result, usage } = completion
  const stats = usage
    ? [
        // Dropped rather than shown as `~0 tokens`: an absent count persists as
        // a literal zero engine-side (see `agentProgressBadge`), so zero here
        // means "no usage was reported", not "this worker used none".
        ...(usage.totalTokens > 0
          ? [`~${compactCount(usage.totalTokens)} tokens`]
          : []),
        `${usage.toolUses} ${usage.toolUses === 1 ? 'tool' : 'tools'}`,
        formatDuration(usage.durationMs),
      ]
    : []
  if (result === null && stats.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {result !== null ? (
        <>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
            Result
          </span>
          <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-muted">
            {result}
          </div>
        </>
      ) : null}
      {stats.length > 0 ? (
        <span className="font-mono text-[10px] text-text-subtle">
          {stats.join(' · ')}
        </span>
      ) : null}
    </div>
  )
}

/**
 * InjectedTurnRow: one of the four other engine-injected `role:'user'` turns.
 * Rendered in the SAME left-aligned notice grammar as TaskNotificationBox — the
 * GUI's "this row came from the engine, not from you" shape — never the
 * right-aligned accent bubble they used to land in.
 *
 * Glyph + heading per kind, matched to the terminal REPL rather than invented:
 *  - `channel`  — `←` (`CHANNEL_ARROW`, `src/constants/figures.ts:21`) and the
 *    server name, as `UserChannelMessage.tsx:56-78` prints `← slack · user:`.
 *  - `teammate` — `@handle`, as `UserTeammateMessage.tsx:98` prints `@name❯`.
 *    The TUI additionally tints the handle with the teammate's own color; the
 *    renderer cannot (Tailwind cannot take an interpolated arbitrary value — the
 *    AGENT_DOT_CLASS lesson), so the handle rides the neutral accent. §0 flag:
 *    🔁 adapted(per-teammate color needs a static hex→class map).
 *  - `coordinator` / `deferred-continuation` — the TUI has NO distinct row for
 *    either (coordinator is `isMeta`-hidden, `attachments.ts:1108`; the
 *    continuation renders as a human turn, which IS this bug). Their headings
 *    come from the engine's own canonical description of each kind in
 *    `wrapCommandText` (`src/utils/messages.ts:5681,5686`) — the one exhaustive
 *    per-kind statement in the engine. §0 flag: 🔁 adapted(no TUI precedent).
 *  - anything else — a kind minted by a newer engine: neutral "Injected
 *    message" heading, row still rendered (display degrades, never drops).
 */
function InjectedTurnBox({
  injectedKind,
  label,
  content,
}: {
  injectedKind: string
  label: string | null
  content: string
}) {
  const style = INJECTED_TURN_STYLE[injectedKind] ?? INJECTED_TURN_FALLBACK
  return (
    <div className="flex items-start gap-2 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-1.5">
      <span className="text-[12px] leading-5 text-accent" aria-hidden>
        {style.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-text-muted">
            {label === null ? style.heading : `${style.prefix}${label}`}
          </span>
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text-muted">
          {content}
        </div>
      </div>
    </div>
  )
}

type InjectedTurnStyle = {
  glyph: string
  /** Heading when the origin names no sender. */
  heading: string
  /** Prefix in front of a named sender (`@` for a teammate, '' for a channel). */
  prefix: string
}

const INJECTED_TURN_STYLE: Record<string, InjectedTurnStyle> = {
  channel: { glyph: '←', heading: 'Channel message', prefix: '' },
  teammate: { glyph: '@', heading: 'Teammate', prefix: '@' },
  coordinator: {
    glyph: '⤷',
    heading: 'Coordinator',
    prefix: '',
  },
  'deferred-continuation': {
    glyph: '⏱',
    heading: 'Continuation',
    prefix: '',
  },
}

const INJECTED_TURN_FALLBACK: InjectedTurnStyle = {
  glyph: '⤷',
  heading: 'Injected message',
  prefix: '',
}

/**
 * ResultRow: the turn/session-end seam. Tone + label encode completed vs
 * errored; duration and cost ride as middot-separated detail.
 */
const RESULT_ERROR_LABELS = new Map([
  ['error_max_turns', 'Stopped · max turns reached'],
  ['error_max_budget_usd', 'Stopped · budget limit reached'],
  [
    'error_max_structured_output_retries',
    'Stopped · max output retries',
  ],
])

function ResultSeam({
  isError,
  subtype,
  durationMs,
  totalCostUsd,
}: {
  isError: boolean
  subtype: string
  durationMs?: number
  totalCostUsd?: number
}) {
  const { openAccounts, saveDiagnostics } = useContext(TurnErrorActionsContext)
  // #6 (operator, 2026-07-19): the success turn-footer was removed — a completed
  // turn shows no seam. Only error/abort/interrupted turns still surface a seam so
  // a stopped or broken turn stays visible.
  if (!isError && subtype !== 'interrupted') return null
  const isInterrupted = subtype === 'interrupted'
  if (isInterrupted) {
    return <Seam tone="neutral" label="Stopped" boldLabel />
  }
  if (subtype === 'error_auth_required') {
    return (
      <TurnErrorCard
        title="Sign-in expired"
        detail="Sign in again in Accounts to continue."
        actionLabel="Open Accounts"
        onAction={openAccounts}
      />
    )
  }
  if (subtype === 'error_during_execution') {
    return (
      <TurnErrorCard
        title="This turn could not finish"
        detail="Try again. If this keeps happening, save a diagnostics bundle."
        actionLabel="Save diagnostics bundle"
        onAction={saveDiagnostics}
      />
    )
  }
  const label = RESULT_ERROR_LABELS.get(subtype) ?? 'Turn failed'
  const detail = [
    durationMs === undefined ? null : `${(durationMs / 1000).toFixed(1)}s`,
    totalCostUsd === undefined ? null : `$${totalCostUsd.toFixed(4)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <Seam
      tone={isError ? 'danger' : 'success'}
      label={label}
      detail={detail || undefined}
      boldLabel
    />
  )
}

function TurnErrorCard({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string
  detail: string
  actionLabel: string
  onAction?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-tone-danger/30 bg-tone-danger/5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-text-primary">{title}</div>
        <div className="mt-0.5 text-xs text-text-muted">{detail}</div>
      </div>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md border border-shell-seam px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-accent"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

/** CompactBoundaryRow: the ✻ pink "memory" seam for conversation compaction. */
function CompactBoundarySeam() {
  // No detail (operator, 2026-08-22). The trigger was the first thing to go:
  // manual or auto is the engine's bookkeeping, and the reader either typed
  // `/compact` or did not. The pre-compaction token count went with it: the
  // seam's job is to mark where the conversation was folded, and a number no
  // decision depends on is just something else to read past. Both still ride
  // the row, and the inspector reads them off the raw frame anyway
  // (`messageMetadata.ts` `readCompaction`), so nothing was lost.
  return <Seam tone="accent" glyph="✻" label="Conversation compacted" />
}

/**
 * The same seam while the compaction is still running: hairlines closing in
 * toward a turning glyph, and the present-tense sentence.
 *
 * Not a projected row, and deliberately so. Compaction mints nothing until its
 * `compact_boundary` frame lands at the end, so a row minted here would have to
 * be rewritten by that frame, and rows are never rewritten after the fact. This
 * is a read-time tail element instead: it exists while the session's
 * `compacting` flag is set and is gone the moment the real boundary row
 * appears, so what looks like one seam settling is a live element handing off
 * to a durable row of the same geometry.
 */
function CompactingSeam() {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="relative h-px flex-1 overflow-hidden bg-accent/20">
        <span className="animate-compact-sweep-left absolute top-0 h-px w-2/5 bg-gradient-to-r from-transparent via-accent to-transparent" />
      </div>
      <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px]">
        <span className="animate-compact-star text-accent" aria-hidden>
          ✻
        </span>
        <span className="text-text-muted">Compacting conversation</span>
      </div>
      <div className="relative h-px flex-1 overflow-hidden bg-accent/20">
        <span className="animate-compact-sweep-right absolute top-0 h-px w-2/5 bg-gradient-to-l from-transparent via-accent to-transparent" />
      </div>
    </div>
  )
}

type SeamTone = 'neutral' | 'accent' | 'danger' | 'success'

const SEAM_RULE_CLASS: Record<SeamTone, string> = {
  neutral: 'bg-shell-seam',
  accent: 'bg-accent/20',
  danger: 'bg-tone-danger/20',
  success: 'bg-tone-success/20',
}

const SEAM_LABEL_TONE: Record<SeamTone, string> = {
  neutral: 'text-text-subtle',
  accent: 'text-text-muted',
  danger: 'text-tone-danger',
  success: 'text-tone-success',
}

/**
 * Shared centered-divider seam grammar (Messages.jsx): two hairline rules
 * flanking an optional glyph + label + `· detail`. Boundary/lifecycle rows are
 * visually distinct from message bubbles by being full-bleed centered rules
 * with no card background.
 */
function Seam({
  tone,
  glyph,
  label,
  detail,
  dashed = false,
  faded = false,
  boldLabel = false,
  italicLabel = false,
}: {
  tone: SeamTone
  glyph?: string
  label: string
  detail?: string
  dashed?: boolean
  faded?: boolean
  boldLabel?: boolean
  italicLabel?: boolean
}) {
  const rule = dashed
    ? 'h-0 flex-1 border-t border-dashed border-shell-seam'
    : `h-px flex-1 ${SEAM_RULE_CLASS[tone]}`
  return (
    <div className={`flex items-center gap-3 py-1 ${faded ? 'opacity-70' : ''}`}>
      <div className={rule} />
      <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px]">
        {glyph ? (
          <span className={SEAM_LABEL_TONE[tone]} aria-hidden>
            {glyph}
          </span>
        ) : null}
        <span
          className={`${SEAM_LABEL_TONE[tone]} ${boldLabel ? 'font-semibold' : ''} ${
            italicLabel ? 'italic' : ''
          }`}
        >
          {label}
        </span>
        {detail ? (
          <span className="text-text-subtle/70">· {detail}</span>
        ) : null}
      </div>
      <div className={rule} />
    </div>
  )
}

/** +adds / −dels across every hunk (from the `+`/`-` line prefixes). */
function countDiff(diff: ToolDiffProjection): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) adds++
      else if (line.startsWith('-')) dels++
    }
  }
  return { adds, dels }
}

function diffCountBadge(row: ToolUseNestedRow): ReactNode {
  const counts = row.result?.diff
    ? countDiff(row.result.diff)
    : row.toolFamily === 'write' &&
        row.result?.isError !== true &&
        typeof row.input.content === 'string' &&
        row.input.content.length > 0
      ? { adds: row.input.content.split('\n').length, dels: 0 }
      : null
  if (counts === null || (counts.adds === 0 && counts.dels === 0)) return undefined
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
      {counts.adds > 0 ? <span className="text-[light-dark(#15803d,#86efac)]">+{counts.adds}</span> : null}
      {counts.dels > 0 ? <span className="text-[light-dark(#dc2626,#fca5a5)]">−{counts.dels}</span> : null}
    </span>
  )
}

// Diff semantics live on the add/delete wash and glyph, while source text takes
// its base and token colors from the selected code theme.
const DIFF_ROW_CLASS: Record<DiffLineKind, string> = {
  // Exact prototype row washes rgba(34,197,94,0.1) / rgba(239,68,68,0.1). NOT the
  // green-500/red-500 utilities — Tailwind v4's oklch palette drifted those to
  // #00c758 / #fb2c36, so a literal hex keeps the prototype value exact.
  add: 'bg-[#22c55e]/10',
  del: 'bg-[#ef4444]/10',
  ctx: '',
}

const DIFF_SIGN_CLASS: Record<DiffLineKind, string> = {
  add: 'text-tone-success',
  del: 'text-tone-danger',
  ctx: 'text-text-ghost',
}

// Word-level intra-line highlight (prototype DiffView, Messages.jsx:160-168): a
// CHANGED word carries the exact rgba(248,113,113,0.28) / rgba(74,222,128,0.26)
// wash (= tone-danger/28, tone-success/26) with a 2px radius + 1px x-pad; an
// UNCHANGED word dims by opacity so syntax-token colors still lead.
const WORD_EMPH_CLASS: Record<'del' | 'add', string> = {
  del: 'rounded-[2px] bg-tone-danger/28 px-px',
  add: 'rounded-[2px] bg-tone-success/26 px-px',
}
const WORD_DIM_CLASS: Record<'del' | 'add', string> = {
  del: 'opacity-60',
  add: 'opacity-60',
}

/**
 * One file's hunks, with the current-file line number in one gutter. The header
 * already carries the path and counts, so the body renders source only.
 *
 * Every hunk in the file is ONE row list and ONE parse (CC-62). Before that,
 * each hunk mounted every line it held and ran its own highlighter pass, and
 * nothing upstream caps a patch: `extractDiffProjection` applies no line or hunk
 * limit, and a Write of an existing file emits a structured patch covering the
 * whole file, so one tool call mounted one DOM row per file line. The row list
 * is complete; the virtualizer decides which of it is near the viewport.
 */
function DiffView({ diff }: { diff: ToolDiffProjection }) {
  const rows = useMemo(() => selectDiffRows(diff), [diff])
  const bodies = useMemo(() => rows.map(row => row.body), [rows])
  const lang = readSourceLanguage(diff.filePath)
  const coloured = useMemo(
    () => selectHighlightedSourceRows(bodies, lang),
    [bodies, lang],
  )
  return (
    <VirtualLineList
      lines={bodies}
      activeIndex={null}
      className={`${INLINE_OUTPUT_SCROLLER} whitespace-pre font-mono text-xs leading-[1.65]`}
      renderLine={(body, index) => (
        <DiffRowView
          row={rows[index]}
          body={coloured?.[index] ?? body}
          segments={selectRowWordSegments(rows, index)}
        />
      )}
    />
  )
}

/**
 * One diff row: the current-file gutter, the sign, and the source. `body` is
 * already bounded — either the coloured row `sourceHighlight.ts` cut, or the
 * chunk the virtualizer cut — so a minified line cannot mount whole.
 */
function DiffRowView({
  row,
  body,
  segments,
}: {
  row: DiffRow | undefined
  body: ReactNode
  segments: WordDiffSide | null
}) {
  if (row === undefined) return null
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  const side = row.kind === 'del' ? 'del' : 'add'
  const painted =
    segments === null
      ? body
      : highlightedWordSegments(
          [body],
          segments,
          WORD_EMPH_CLASS[side],
          WORD_DIM_CLASS[side],
        )
  return (
    <div className={`flex ${DIFF_ROW_CLASS[row.kind]}`}>
      <span className="w-[26px] shrink-0 select-none pr-[7px] text-right tabular-nums text-text-ghost">
        {row.currentLabel}
      </span>
      <span className="min-w-0 flex-1 border-l border-white/[0.05] pl-2.5 pr-3.5 hljs">
        <span className={DIFF_SIGN_CLASS[row.kind]}>{sign}</span>{' '}
        {painted}
      </span>
    </div>
  )
}
