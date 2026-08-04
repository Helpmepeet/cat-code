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
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { diffWordsWithSpace } from 'diff'
import type { AccountsSnapshot, SessionId } from '../../shared/protocol.js'
import { WelcomeScreen } from './WelcomeScreen.js'
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
import { ToolsExpandedContext } from './toolsExpanded.js'
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
  deriveAgentDisplayVocabulary,
  type AgentToolSource,
} from './agentIdentity.js'
import {
  AgentRoleDot,
  AgentStateLabel,
  Baton,
} from './AgentChrome.js'
import {
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './agentChromeModel.js'
import { ToolInspector } from './ToolInspector.js'
import { parseToolAck, type ToolAck } from './toolAck.js'
import {
  AdditionSourceLines,
  GrepSourceLines,
  ReadSourceLines,
} from './ReadSourceLines.js'
import {
  parseReadSource,
  readLineNumbers,
  readSourceLanguage,
} from './readSource.js'
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
  findNestedToolUseRow,
  logLineClass,
  resolveToolCardExpanded,
  groupGrepLines,
  selectPeekLines,
} from './transcriptViewModel.js'
import {
  INLINE_HEAD_LINES,
  revealMoreLines,
  selectInlineOutputWindow,
} from './inlineOutputWindow.js'

/**
 * P4-1 open-from-card handle: a tool card calls this with its own REAL projected
 * row to open the `ToolInspector` drawer. Provided by `TranscriptRowsView`, which
 * owns the selected-row state and renders the overlay. Default `null` so a tool
 * card rendered outside a transcript (a direct unit test) simply shows no
 * inspector affordance. The published value is a stable `useCallback` handle, so
 * exposing it via context never defeats the memoized row subtree.
 */
const ToolInspectorContext = createContext<((row: ToolUseNestedRow) => void) | null>(
  null,
)

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

// Perf (2026-07-08, F3): memoized so an App re-render that did NOT change this
// session's transcript slice (a keystroke in the composer, another session's
// frame) skips the whole subtree. `state`/`activeSessionId` are referentially
// stable across those, and `selectNestedTranscriptRows` is slice-cached, so the
// `rows` handed to TranscriptRowsView keep identity when nothing changed.
export const TranscriptView = memo(function TranscriptView({
  state,
  activeSessionId,
  accounts,
  orchestratorActive,
  onToggleOrchestrator,
  cwd,
  branch,
  sandboxed,
  restorePhase,
  revealHidden,
}: {
  state: TranscriptState
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
}) {
  return (
    <TranscriptRowsView
      rows={selectNestedTranscriptRows(state, activeSessionId, revealHidden)}
      accounts={accounts ?? null}
      orchestratorActive={orchestratorActive ?? false}
      onToggleOrchestrator={onToggleOrchestrator}
      cwd={cwd ?? null}
      branch={branch ?? null}
      sandboxed={sandboxed ?? false}
      restorePhase={restorePhase ?? null}
    />
  )
})

export const TranscriptRowsView = memo(function TranscriptRowsView({
  rows,
  accounts = null,
  orchestratorActive = false,
  onToggleOrchestrator,
  cwd = null,
  branch = null,
  sandboxed = false,
  restorePhase = null,
}: {
  rows: NestedTranscriptRow[]
  accounts?: AccountsSnapshot | null
  orchestratorActive?: boolean
  onToggleOrchestrator?: (next: boolean) => void
  cwd?: string | null
  branch?: string | null
  sandboxed?: boolean
  restorePhase?: RestorePhase | null
}) {
  // P4-1: the tool row a card asked to inspect (null = drawer closed). Owned here
  // — above the memoized rows — so opening the drawer never mutates a row and the
  // overlay is a sibling of the transcript column, not nested in a scrolling row.
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const openInspector = useCallback((row: ToolUseNestedRow) => setInspectedId(row.id), [])
  const closeInspector = useCallback(() => setInspectedId(null), [])
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
      // P4-24 fidelity: content is centered in a max-740px column (Chat.jsx:1282
      // `maxWidth: MSG_MAX, margin: '0 auto'`), full-bleed (no bordered box), with
      // 24px top / 32px side padding. The prototype's light body weight is scoped
      // to assistant prose (AssistantProse), NOT the whole column, so tool-card /
      // code / mono text stays at a crisp, readable weight.
      <div className="mx-auto flex w-full max-w-[740px] flex-col gap-2.5 px-8 pt-6">
        {items.map(item =>
          // P4-36 — a revealed hidden row reads dimmed (`Chat.jsx:1285`
          // `opacity: 0.55`), so transcript mode never passes engine bookkeeping
          // off as ordinary conversation. `isHidden` is only ever present when
          // the caller asked for the revealed view, so the default transcript
          // takes the untouched branch and keeps its DOM exactly as before.
          isRevealedHiddenItem(item) ? (
            <div className="opacity-55" key={displayItemKey(item)}>
              <DisplayItemView item={item} />
            </div>
          ) : (
            <DisplayItemView item={item} key={displayItemKey(item)} />
          ),
        )}
      </div>
    )
  }

  return (
    <ToolCardExpansionContext.Provider value={expansionStore}>
      <ToolInspectorContext.Provider value={openInspector}>
        {content}
        <ToolInspectorOverlay row={inspected} onClose={closeInspector} />
      </ToolInspectorContext.Provider>
    </ToolCardExpansionContext.Provider>
  )
})

/**
 * P4-1 mount: the `ToolInspector` drawer as a right-side overlay (prototype
 * OutputInspector, Messages.jsx:254 — `position: fixed`, dimmed backdrop, Esc to
 * close). Rendered by `TranscriptRowsView` from the REAL projected row a card
 * handed to `openInspector`; a null row renders nothing. Fixed positioning keeps
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
        className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        className="relative flex h-full shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Tool inspector"
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
      className="mx-auto flex w-full max-w-[740px] flex-col gap-3 px-8 pt-6"
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
 * One display item — an agent DelegateGroup, a reasoning run, a tool run, or a
 * single row. The `default` branch carries the same compile-time `never` tripwire
 * as the row switch: a new display-item kind breaks the build here until it gets
 * a case.
 */
function DisplayItemView({ item }: { item: TranscriptLayoutItem }) {
  switch (item.kind) {
    case 'agent-group':
      return <DelegateGroup members={item.members} />
    case 'reasoning-run':
      return <ReasoningRun steps={item.steps} />
    case 'tool-run':
      return <ToolRunCard family={item.family} members={item.members} />
    case 'single':
      return <TranscriptRowView row={item.row} />
    default: {
      const _exhaustive: never = item
      void _exhaustive
      return null
    }
  }
}

/**
 * A nested row list (subagent children under an Agent card, tool-card children).
 * These never carry agent grouping — co-spawned siblings are a TOP-LEVEL
 * derivation (C4 keeps children under their owning card) — but their reasoning
 * and tool runs group exactly like the top level, so a delegated GPT turn reads
 * the same inside a card as outside one.
 */
function NestedRowList({ rows }: { rows: NestedTranscriptRow[] }) {
  const { mode } = useContext(ReasoningLayoutContext)
  const items = groupToolRuns(groupDisplayItems(toDisplayItems(rows), mode))
  return (
    <>
      {items.map(item => (
        <DisplayItemView item={item} key={displayItemKey(item)} />
      ))}
    </>
  )
}

// Memoized per row: a slice-cached read reuses unchanged row objects, so only
// the rows that actually changed re-render (markdown re-parses once per body).
const TranscriptRowView = memo(function TranscriptRowView({
  row,
}: {
  row: NestedTranscriptRow
}) {
  const { mode: reasoningMode } = useContext(ReasoningLayoutContext)
  // Captured before the switch narrows `row` to `never` in the default branch,
  // so the tolerant fallback can name the drifted kind without an `as` cast.
  const rowKind: string = row.kind
  switch (row.kind) {
    case 'assistant-text':
      return <AssistantProse content={row.content} streaming={row.isStreaming} />

    case 'user-text':
      return <UserBubble content={row.content} />

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
        <ThinkingBlock content={row.content} />
      ) : (
        <ReasoningRun steps={reasoningStepsForRow(row)} />
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
      return <TaskNotificationBox status={row.status} summary={row.summary} />

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

    case 'compact-boundary':
      return <CompactBoundarySeam trigger={row.trigger} preTokens={row.preTokens} />

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
 */

// Stable module-scope plugin config. `remark-gfm` adds pipe tables (+ autolinks/
// strikethrough). `rehype-highlight` tokenizes fenced ```lang blocks into
// highlight.js `hljs-*` spans: `detect:false` colors ONLY explicitly-languaged
// blocks (no noisy auto-detect of plain text); `ignoreMissing:true` degrades an
// unknown language to plain text instead of throwing (display = degrade
// gracefully, and safe under SSR where the error boundary can't catch).
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: [
  typeof rehypeHighlight,
  { detect: boolean; ignoreMissing: boolean },
][] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]

function AssistantProse({
  content,
  streaming,
}: {
  content: string
  streaming?: true
}) {
  // The prototype's `showCopy` gate (Messages.jsx:2068): no chip while the reply
  // is still arriving (there is no settled answer to take yet, and the caret owns
  // that corner), and none on an empty turn.
  const copyable = !streaming && content.trim().length > 0
  return (
    // P4-38 host contract for `BubbleCopyChip`: `group relative` makes this body
    // the hover/focus group the absolute chip anchors to. No reserved right
    // gutter (operator call, 2026-08-02): the prototype's chip overlays the
    // last line rather than narrowing the column (Messages.jsx:2064-2091), and
    // the app's own reserved-gutter version read as an unexplained gap.
    <div className="group relative">
      <MarkdownErrorBoundary fallback={content}>
        <div className="font-sans font-light text-sm leading-relaxed [&>*+*]:mt-2 [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-shell-seam [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-accent-soft">
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {content}
          </Markdown>
        </div>
      </MarkdownErrorBoundary>
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom"
          aria-hidden
        />
      ) : null}
      {copyable ? (
        <BubbleCopyChip content={content} subject="response" />
      ) : null}
    </div>
  )
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
  code: ({ className, children }: ComponentPropsWithoutRef<'code'>) => {
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
        lang={match?.[1] ?? ''}
        code={text.replace(/\n$/, '')}
        highlighted={children}
      />
    )
  },
  // GFM pipe tables (remark-gfm). Exact prototype ProseTable values
  // (Messages.jsx:1890-1906): rounded 8px scroll wrapper w/ a 0.08 white border,
  // horizontal-only rules (header 0.12, body 0.05), a 0.03 header wash, 13px, and
  // the prototype's #e4e4e7 / #c4c4c8 cell text. Column alignment (remark-gfm's
  // per-cell `style`) is intentionally not forwarded — the prototype is
  // left-aligned throughout and this keeps zero inline style. Static arbitrary
  // classes only (the FAMILY_STYLE precedent for palette values with no token).
  table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-white/[0.08]">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: ComponentPropsWithoutRef<'th'>) => (
    <th className="whitespace-nowrap border-b border-white/[0.12] bg-white/[0.03] px-3 py-[7px] text-left font-semibold text-[#e4e4e7]">
      {children}
    </th>
  ),
  td: ({ children }: ComponentPropsWithoutRef<'td'>) => (
    <td className="border-b border-white/[0.05] px-3 py-[7px] align-top text-[#c4c4c8]">
      {children}
    </td>
  ),
}

/**
 * Fenced code block — exact prototype ProseCode grammar (Messages.jsx:1795-1828):
 * a page-black (#09090b = app-bg) panel with an 8px radius + 0.06 white border,
 * a FLOATING top-left accent `</>` + language label, a floating top-right copy
 * control, and 38px top padding so the pre clears the floating chrome. Syntax
 * tokens come from `rehype-highlight` (`hljs-*` <span>s colored by the fixed
 * Dracula stylesheet in theme.css). `highlighted` is the colored span tree for
 * DISPLAY; `code` is the raw source the copy button writes.
 *
 * ADAPTED (§0): the prototype's clipboard/check SVG icons are dropped for a
 * text-only "copy"/"copied" affordance — the app carries no icon library and
 * uses text-glyph chrome throughout. The 5-theme Settings picker is a separate
 * §5 ledger deferral (owner P4-18; needs the Settings code-theme sync seam).
 */
export function CodeBlock({
  lang,
  code,
  highlighted,
}: {
  lang: string
  code: string
  highlighted: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
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
  return (
    <div className="relative my-2 overflow-hidden rounded-lg border border-shell-seam bg-app-bg">
      <span className="absolute left-3.5 top-2 z-[1] inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.06em] text-accent">
        <span className="opacity-70">&lt;/&gt;</span>
        {lang || 'code'}
      </span>
      <button
        type="button"
        onClick={copy}
        className={`absolute right-2.5 top-1.5 z-[1] font-mono text-[11px] transition-colors ${
          copied ? 'text-[#86efac]' : 'text-text-subtle hover:text-text-primary'
        }`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="overflow-x-auto px-3.5 pb-3.5 pt-[38px] font-mono text-[12.5px] leading-[1.65]">
        <code className="hljs">{highlighted}</code>
      </pre>
    </div>
  )
}

type ToolUseNestedRow = Extract<NestedTranscriptRow, { kind: 'tool-use' }>

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
  bash: { mark: '$', word: 'Bash', color: 'text-[#a3e635]' },
  read: { mark: '≡', word: 'Read', color: 'text-[#60a5fa]' },
  write: { mark: '+', word: 'Write', color: 'text-[#fb923c]' },
  edit: { mark: '±', word: 'Edit', color: 'text-accent' },
  grep: { mark: '⌕', word: 'Search', color: 'text-[#fbbf24]' },
  web: { mark: '↗', word: 'Web', color: 'text-[#22d3ee]' },
  mcp: { mark: '⧉', word: 'MCP', color: 'text-[#c084fc]' },
  notebook: { mark: '▣', word: 'Notebook', color: 'text-[#f97316]' },
  lsp: { mark: '◈', word: 'LSP', color: 'text-[#f87171]' },
  skill: { mark: '✦', word: 'Skill', color: 'text-[#5eead4]' },
  agent: { mark: '◆', word: 'Agent', color: 'text-accent' },
  // Same WORD as the spawn family, hollow mark against its filled one: ◆ creates
  // an agent, ◇ acts on one that already exists. The hue is the prototype's own
  // agent-family violet (`Messages.jsx` FE_FAMC `agent:'#a78bfa'`), which this
  // app left unused by tokenizing its agent family to `text-accent` — an
  // existing palette hue, not a new one. Literal class string, never
  // interpolated (the dynamic-class trap this map's header documents).
  'agent-control': { mark: '◇', word: 'Agent', color: 'text-[#a78bfa]' },
  imagegen: { mark: '◰', word: 'Image', color: 'text-[#e879f9]' },
  other: { mark: '•', word: 'Tool', color: 'text-text-muted' },
}

/**
 * The projector derives only THREE statuses (pending/success/error) — the
 * prototype's richer vocab (queued/needs-permission/cancelled/denied/truncated)
 * has no correlated seam signal, so this maps the real three to running/done/
 * failed (§5 ledger: "adapted to 3 states"). `pending` pulses like the
 * prototype's running dot.
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
}

/** Family-specific one-line target framing derived from the REAL tool input. */
function deriveTarget(row: ToolUseNestedRow): string {
  const input = row.input
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  switch (row.toolFamily) {
    case 'bash':
      return str('command') ?? row.toolName
    case 'read': {
      const filePath = str('file_path')
      return filePath === null ? row.toolName : basename(filePath) || filePath
    }
    case 'write':
      return str('file_path') ?? row.toolName
    case 'edit':
      return str('file_path') ?? row.result?.diff?.filePath ?? row.toolName
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
  if (row.result?.diff) {
    const { adds, dels } = countDiff(row.result.diff)
    return `${row.result.diff.filePath} · +${adds} −${dels}`
  }
  if (row.toolFamily === 'mcp') return row.toolName
  return undefined
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
  alwaysExtra,
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
  /** Always-visible sub-header row under the header (Agent identity strip). */
  alwaysExtra?: ReactNode
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
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.025] font-sans">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className={`w-4 shrink-0 text-center text-[13px] ${fam.color}`} aria-hidden>
          {fam.mark}
        </span>
        <span
          className={`shrink-0 text-[10.5px] font-bold uppercase tracking-[0.08em] ${fam.color}`}
        >
          {fam.word}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
          {target}
        </span>
        {headerBadge}
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`}
            aria-hidden
          />
          <span className={`text-[10.5px] ${st.color}`}>{st.word}</span>
        </span>
      </button>
      {alwaysExtra ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-shell-seam px-3 py-1.5">
          {alwaysExtra}
        </div>
      ) : null}
      {!expanded && collapsedExtra ? collapsedExtra : null}
      {expanded && hasBody ? (
        <div className="border-t border-shell-seam bg-black/[0.28]">
          {sub ? (
            <div className="truncate px-3 pt-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-text-subtle">
              {sub}
            </div>
          ) : null}
          <div className="px-3 pb-2.5 pt-1">{children}</div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * P4-18b tool card: dispatches the shared shell (family mark/word/target/
 * state-dot/collapse) with a per-family body rendered from the REAL projected
 * row (`input` + correlated `result.content`/`result.diff`, zero casts). Sub-
 * features that need data the projector never surfaces (stdout/stderr split,
 * line/byte counts, real diagnostic severity, the GenerateImage inline tile,
 * WebFetch content-type/size, word-level intra-line diff) render truth or a
 * flagged note — they are §5 ledger deferrals needing a projector data-contract
 * change, NOT the P2-locked render layer, and are never mocked.
 */
function ToolCard({ row }: { row: ToolUseNestedRow }) {
  // Read before the early return so the Agent branch doesn't skip the hook; the
  // Agent card has its own body and does not carry the inspector affordance.
  const openInspector = useContext(ToolInspectorContext)
  // The weakest of the three expansion inputs: a user's own click still wins
  // (`resolveToolCardExpanded`), and a failed or finished-image card still opens
  // itself, for reasons this preference knows nothing about.
  const { expanded: toolsExpanded } = useContext(ToolsExpandedContext)
  // D2/C2: the Agent tool_use is rendered as the Agent member of this same
  // tool-card family (specialized body + C4 child nesting), not a sibling row.
  if (row.toolFamily === 'agent') return <AgentToolCard row={row} />

  const content = row.result?.content ?? ''
  const isImageDone = row.toolFamily === 'imagegen' && row.status === 'success'
  const ack = parseToolAck(content)
  return (
    <div className="w-full">
      <ToolCardShell
        family={row.toolFamily}
        target={deriveTarget(row)}
        status={row.status}
        sub={deriveSub(row)}
        expansionKey={row.toolUseId}
        defaultExpanded={
          toolsExpanded || row.status === 'error' || isImageDone
        }
        collapsedExtra={
          ack !== null ? (
            <AckPeek ack={ack} />
          ) : row.toolFamily === 'bash' && content.length > 0 ? (
            <BashTailPeek content={content} />
          ) : null
        }
      >
        <ToolCardBody row={row} content={content} />
        {/* P4-1 open-from-card affordance: hands THIS real projected row to the
            inspector drawer. Only present when a transcript provided the context
            (`openInspector`); a card mounted bare in a test shows none. */}
        {openInspector ? (
          <ToolInspectorLaunch onOpen={() => openInspector(row)} />
        ) : null}
      </ToolCardShell>
      {row.children.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-l border-accent/20 pl-3">
          <NestedRowList rows={row.children} />
        </div>
      ) : null}
    </div>
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
  const head = toolRunHead(family, members)
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
      <div className="flex flex-col">
        {members.map((member, index) => (
          <ToolRunRow
            key={member.id}
            family={family}
            row={member}
            digest={digests[index]}
            hoistedPrefix={head.hoistedPrefix}
            runKey={runKey}
          />
        ))}
      </div>
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
): {
  target: string
  sub: string
  badge: ReactNode
  hoistedPrefix: string
} {
  if (family === 'read') {
    const target = `${members.length} ${members.length === 1 ? 'file' : 'files'}`
    const hoistedPrefix = commonDirPrefix(members.map(memberReadPath))
    return {
      target,
      sub: `${target} read`,
      hoistedPrefix,
      badge:
        hoistedPrefix.length > 0 ? (
          <span className="shrink-0 truncate font-mono text-[11px] text-text-faint">
            {hoistedPrefix}
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
 * `row` identity is useless as a key — `selectNestedTranscriptRows` rebuilds every
 * row each frame (`attachChildren`, `transcriptProjector.ts:617`) — but the spread
 * copies `result` by reference, so a settled result is the same object frame after
 * frame. Keying here turns a per-frame full-file parse into one parse per tool
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
  if (members.some(member => member.status === 'pending')) return 'pending'
  // Closed-union tripwire (house rule): a fourth `ToolCardStatus` must be ranked
  // here deliberately, not silently fold into `success` on a run head.
  const remaining: Exclude<ToolCardStatus, 'error' | 'pending'> = 'success'
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
  const openInspector = useContext(ToolInspectorContext)
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
          <ToolCardBody row={row} content={content} />
          {openInspector ? (
            <ToolInspectorLaunch onOpen={() => openInspector(row)} />
          ) : null}
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
  return (
    <span className="flex min-w-0 flex-1 font-mono text-xs text-text-primary">
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
 * "Inspector ↗" — the footer affordance inside a tool card's expanded body.
 * Opens the `ToolInspector` drawer over this card's real projected row. Sits
 * below the body so a collapsed card stays quiet; a running/errored card
 * (default-expanded) shows it immediately.
 *
 * The label is the prototype's, and the distinction is deliberate: its footer
 * button reads "Inspector" (`Messages.jsx:564`) while the reveal band's reads
 * "Open full output" (`:452`). Both routes end at the same drawer, but they are
 * scoped differently — the footer always offers it, the band offers it only for
 * output the card had to cut — so they must not share one label. This one
 * carried the band's wording until P4-45.
 */
function ToolInspectorLaunch({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mt-2 flex justify-end border-t border-shell-seam pt-2">
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/[0.06] px-2.5 py-1 font-mono text-[10.5px] text-accent-soft hover:bg-accent/10"
      >
        Inspector
        <span aria-hidden>↗</span>
      </button>
    </div>
  )
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
  return {
    toolName: row.toolName === 'Task' ? 'Task' : 'Agent',
    status: row.status,
    ...(input.run_in_background === true ? { run_in_background: true } : {}),
    ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  }
}

/**
 * The worker's human label: the `subagent_type`, except the generic
 * `general-purpose`/`worker` types collapse to "Agent" (source: `userFacingName`,
 * `src/tools/AgentTool/UI.tsx:860-874`).
 */
function agentWorkerType(vocab: ReturnType<typeof deriveAgentDisplayVocabulary>): string {
  const type = vocab.type
  return type && type.key !== 'general-purpose' && type.key !== 'worker'
    ? type.label
    : 'Agent'
}

/**
 * D2/C4 inline Agent card — the Agent member of the P2-2 tool-card family
 * (`decisions/AGENT-CHROME.md` §2). Reuses the 8a chrome primitives
 * (`AgentRoleDot`/`AgentStateLabel`/`Baton`, `AgentChrome.tsx`) but feeds them
 * from TRANSCRIPT-derived data only (`agentToolSourceOf`): identity from the
 * row's `input`, state from its read-time `status` (`deriveAgentToolState`),
 * activity from its nested child rows.
 *
 * C4: subagent child rows NEST inside this card's collapsible body, COLLAPSED by
 * default, never interleaved at the transcript top level; the header carries the
 * child count as the expand affordance. Owner/handoff (the Baton) lives on
 * `LocalAgentTask` (session plane), NOT on this frame — so the Baton is always
 * `'none'` here (renders nothing); blocked/owner state is never fabricated on the
 * card (task rule).
 */
function AgentToolCard({ row }: { row: ToolUseNestedRow }) {
  const vocab = deriveAgentDisplayVocabulary(agentToolSourceOf(row))
  const workerType = agentWorkerType(vocab)
  const typeTone = vocab.type
    ? AGENT_TYPE_TONE_CLASS[vocab.type.tone]
    : AGENT_TYPE_TONE_CLASS.neutral
  const childCount = row.children.length
  const completion = row.agentCompletion
  // ONE expression, so `ToolCardShell`'s `hasBody` stays null when there is
  // genuinely no body — two sibling expressions would make it an array and give
  // every childless agent card a body that expands to nothing.
  const body =
    childCount === 0 && completion === null ? null : (
      <div className="flex flex-col gap-2">
        {childCount > 0 ? (
          <div className="flex flex-col gap-2 border-l border-accent/20 pl-3">
            <NestedRowList rows={row.children} />
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
  return (
    <ToolCardShell
      family="agent"
      target={deriveTarget(row)}
      status={row.status}
      expansionKey={row.toolUseId}
      // A finished background agent's result is the ONLY place its output
      // exists, so it opens; a foreground card keeps the C4 collapsed default.
      defaultExpanded={completion !== null}
      headerBadge={
        childCount > 0 ? (
          <span className="shrink-0 rounded-[5px] border border-shell-seam bg-white/[0.03] px-1.5 py-px font-mono text-[10px] text-text-subtle">
            {childCount} nested
          </span>
        ) : undefined
      }
      // The identity strip is ALWAYS visible; only the subagent child rows
      // collapse (C4). Reuses the 8a chrome primitives, all fed from this row.
      alwaysExtra={
        <>
          <AgentRoleDot role={vocab.identity.type} />
          <span className={`shrink-0 text-[12.5px] font-semibold ${typeTone.text}`}>
            {workerType}
          </span>
          <AgentStateLabel state={vocab.state.key} />
          {/* Owner/handoff is a session-plane (`LocalAgentTask`) fact, absent
              from this frame — never fabricated here (D2/§4). Renders nothing. */}
          <Baton owner="none" />
        </>
      }
    >
      {body}
    </ToolCardShell>
  )
}

/**
 * D2/§3 DelegateGroup — parallel agents the orchestrator co-spawned in one turn
 * (same `message.id` — `src/utils/groupToolUses.ts:76`) render as ONE grouped
 * card instead of N sibling cards. The header mirrors the engine's grouped
 * summary (`renderGroupedAgentToolUse`, `src/tools/AgentTool/UI.tsx:838-856`):
 * "Running N agents…" while any member is pending, else "N [type] agents
 * finished"; the common type shows only when every member shares it. Members
 * stack as ordinary inline Agent cards (each keeps its own C4 child nesting).
 * Grouping is a read-time DERIVATION (`groupAgentDelegates`), never a new frame
 * or message type (C3).
 */
function DelegateGroup({ members }: { members: NestedToolUseRow[] }) {
  const anyPending = members.some(member => member.status === 'pending')
  const anyError = members.some(member => member.status === 'error')
  const types = members.map(member =>
    agentWorkerType(deriveAgentDisplayVocabulary(agentToolSourceOf(member))),
  )
  const commonType =
    types.length > 0 && types.every(type => type === types[0]) && types[0] !== 'Agent'
      ? types[0]
      : null
  const noun = commonType ? `${commonType} agents` : 'agents'
  const label = anyPending
    ? `Running ${members.length} ${noun}…`
    : `${members.length} ${noun} finished`
  const tone = anyPending
    ? AGENT_STATE_TONE_CLASS.info
    : anyError
      ? AGENT_STATE_TONE_CLASS.danger
      : AGENT_STATE_TONE_CLASS.success
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.02]">
      <div className="flex items-center gap-2 border-b border-shell-seam px-3 py-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${anyPending ? 'animate-pulse' : ''}`}
          aria-hidden
        />
        <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-[0.08em] text-accent">
          Delegate
        </span>
        <span className={`text-[11px] ${tone.text}`}>{label}</span>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {members.map(member => (
          <AgentToolCard key={member.id} row={member} />
        ))}
      </div>
    </div>
  )
}

/** Per-family body from real data. */
function ToolCardBody({
  row,
  content,
}: {
  row: ToolUseNestedRow
  content: string
}) {
  // Read before any early return so the hook order is stable across families.
  // The reveal band's escape hatch is the SAME `ToolInspectorContext` route the
  // card footer uses, over this same real projected row; null outside a
  // transcript, where the band simply omits the button.
  const openInspector = useContext(ToolInspectorContext)
  const openFull = openInspector ? () => openInspector(row) : null

  if (row.result?.diff) return <DiffView diff={row.result.diff} />

  const errorTone = row.result?.isError === true
  // Only an EXACT ack replaces the body: a richer object's other fields would
  // vanish with no way to notice they were there (`toolAck.ts` `exact`).
  const ack = parseToolAck(content)
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
      return <BashBody content={content} isError={errorTone} onOpenFull={openFull} />
    case 'grep':
      return <GrepBody content={content} isError={errorTone} onOpenFull={openFull} />
    case 'read':
      return (
        <NumberedBody
          content={content}
          filePath={row.input['file_path']}
          onOpenFull={openFull}
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
        />
      )
    case 'imagegen':
      return <ImageResultBody content={content} isError={errorTone} />
    default:
      return <PlainLinesBody content={content} isError={errorTone} onOpenFull={openFull} />
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
function LogLines({
  lines,
  isError,
  startNo,
}: {
  lines: string[]
  isError: boolean
  startNo: number
}) {
  return (
    <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className={LOG_GUTTER_CLASS}>{startNo + index}</span>
          <span className={isError ? 'text-tone-danger' : logLineClass(line)}>
            {line || ' '}
          </span>
        </div>
      ))}
    </pre>
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
 * `useState` half of the head+tail window. The reveal is monotonic, matching the
 * prototype: `headShown` only grows, and the band removes itself once the gap
 * closes, so there is no collapse control to un-reveal.
 */
function useInlineOutputWindow(lines: string[]) {
  const [headShown, setHeadShown] = useState(INLINE_HEAD_LINES)
  return {
    window: selectInlineOutputWindow(lines, headShown),
    revealMore: () =>
      setHeadShown(shown => revealMoreLines(shown, lines.length)),
  }
}

function BashBody({
  content,
  isError,
  onOpenFull,
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines)
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      <LogLines lines={window.head} isError={isError} startNo={1} />
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          {/* The tail resumes at its TRUE output line, never restarting at 1
           * (prototype `startNo={lines.length-TAIL+1}`, `Messages.jsx:552`) —
           * the same rule P4-36 established for a truncated read. */}
          <LogLines
            lines={window.tail}
            isError={isError}
            startNo={window.tailStartLine}
          />
        </>
      ) : null}
    </div>
  )
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
  return (
    <div className="border-t border-shell-seam bg-black/20 px-3 py-1.5">
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

function BashTailPeek({ content }: { content: string }) {
  const tail = selectPeekLines(content.split('\n'))
  if (tail.length === 0) return null
  return (
    <div className="border-t border-shell-seam bg-black/20 px-3 py-1.5">
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
}: {
  content: string
  filePath: unknown
  onOpenFull: (() => void) | null
}) {
  const source = parseReadSource(content)
  // No numbers means we could not recognise the payload as a file read, so we
  // cannot claim to know what language it is in either.
  const lang = source.numbers === null ? null : readSourceLanguage(filePath)
  const { window, revealMore } = useInlineOutputWindow(source.lines)
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      <ReadSourceLines
        lines={window.head}
        numbers={readLineNumbers(source, 0, window.head.length)}
        lang={lang}
      />
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          <ReadSourceLines
            lines={window.tail}
            numbers={readLineNumbers(
              source,
              window.tailStartLine - 1,
              window.tail.length,
            )}
            lang={lang}
          />
        </>
      ) : null}
    </div>
  )
}

function AdditionsBody({
  content,
  filePath,
  onOpenFull,
}: {
  content: string
  filePath: unknown
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const lang = readSourceLanguage(filePath)
  const { window, revealMore } = useInlineOutputWindow(lines)
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      <AdditionSourceLines lines={window.head} lang={lang} />
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          <AdditionSourceLines lines={window.tail} lang={lang} />
        </>
      ) : null}
    </div>
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
}: {
  /** Raw `input.content`, narrowed here rather than trusted. */
  written: unknown
  /** Raw `input.file_path`; only the extension is read, for the language. */
  filePath: unknown
  result: string
  isError: boolean
  onOpenFull: (() => void) | null
}) {
  if (isError || typeof written !== 'string' || written.length === 0) {
    return (
      <PlainLinesBody
        content={result}
        isError={isError}
        onOpenFull={onOpenFull}
      />
    )
  }
  return (
    <AdditionsBody content={written} filePath={filePath} onOpenFull={onOpenFull} />
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
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines)
  const renderSegments = (slice: string[], keyPrefix: string) =>
    groupGrepLines(slice).map((segment, index) =>
      segment.kind === 'plain' ? (
        <pre
          key={`${keyPrefix}:${index}`}
          className="col-span-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-muted"
        >
          {segment.lines.join('\n')}
        </pre>
      ) : (
        <GrepSourceLines
          key={`${keyPrefix}:${index}`}
          locators={segment.locators}
          bodies={segment.bodies}
          lang={readSourceLanguage(segment.path)}
        />
      ),
    )
  // A failed search has no results to color — it has an error message, which
  // takes the error tone whole rather than being parsed for locators.
  if (isError) {
    return (
      <div className={INLINE_OUTPUT_SCROLLER}>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-tone-danger">
          {content}
        </pre>
      </div>
    )
  }
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      {/* ONE grid for the whole body, head and tail alike: `max-content` sizes
       * the locator column to the widest locator anywhere in it, so every run's
       * source starts at the same x instead of each file group sizing its own. */}
      <div className="grid grid-cols-[max-content_1fr]">
        {renderSegments(window.head, 'head')}
        {window.truncated ? (
          <>
            <div className="col-span-2">
              <InlineRevealBand
                hidden={window.hidden}
                revealStep={window.revealStep}
                onReveal={revealMore}
                onOpenFull={onOpenFull}
              />
            </div>
            {renderSegments(window.tail, 'tail')}
          </>
        ) : null}
      </div>
    </div>
  )
}

function PlainLinesBody({
  content,
  isError,
  onOpenFull,
}: {
  content: string
  isError: boolean
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines)
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
  const renderLines = (slice: string[]) => (
    <pre
      className={`whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${toneClass}`}
    >
      {slice.join('\n')}
    </pre>
  )
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      {renderLines(window.head)}
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          {renderLines(window.tail)}
        </>
      ) : null}
    </div>
  )
}

/**
 * GenerateImage result. The projector carries only the flattened result text,
 * NOT the inline image bytes/path structure — the prototype's inline image
 * tile + Open/Copy actions need a projector data-contract change (§5 flag), so
 * this renders the real result text and nothing else. It used to print that
 * flag at the user as a roadmap note; the deferral belongs in the ledger and
 * STATUS, not on the transcript (CLAUDE.md §7). The result text above it
 * already says what happened.
 */
function ImageResultBody({ content, isError }: { content: string; isError: boolean }) {
  return (
    <pre
      className={`overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${
        isError ? 'text-tone-danger' : 'text-text-muted'
      }`}
    >
      {content}
    </pre>
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
          ? 'text-[#86efac] opacity-100'
          : 'text-text-subtle hover:text-[#d4d4d8]'
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
 * No copy affordance (operator call, 2026-08-02): unlike the prototype, own
 * messages carry no chip, so the bubble keeps uniform padding on every side.
 */
function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-accent/20 bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-text-primary">
        {content}
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
function ThinkingBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg border border-accent/15 bg-accent/[0.04]">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent">
          Thinking
        </span>
      </div>
      <div className="border-t border-accent/10 px-3.5 py-2.5 text-[13px] italic leading-relaxed text-text-subtle [&>*+*]:mt-2">
        <MarkdownErrorBoundary fallback={content}>
          <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
        </MarkdownErrorBoundary>
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

/**
 * A run of reasoning steps. One step draws as a single line (no head, no count,
 * nothing to collapse); an all-withheld run draws as bare lines, because a head
 * asserting "N steps" over rows with no readable content would imply content
 * that does not exist. Everything else gets the head + rail + steps. The whole
 * run collapses from its head; individual steps never fold away.
 */
function ReasoningRun({ steps }: { steps: ReasoningStepModel[] }) {
  const [collapsed, setCollapsed] = useState(false)
  const listId = useId()

  if (steps.length === 0) return null
  if (steps.length === 1) {
    const [step] = steps
    if (step.kind === 'withheld') return <WithheldReasoningLine />
    if (step.kind === 'heading') return <ReasoningLine content={step.text} />
  }
  if (steps.every(step => step.kind === 'withheld')) {
    return (
      <div className="flex flex-col">
        {steps.map(step => (
          <WithheldReasoningLine key={step.key} />
        ))}
      </div>
    )
  }

  const shown =
    steps.length > REASONING_RUN_MAX_STEPS
      ? steps.slice(steps.length - REASONING_RUN_MAX_STEPS)
      : steps
  return (
    <div className="group flex flex-col">
      <button
        type="button"
        aria-controls={listId}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}
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
        {steps.length > 1 ? (
          <span className="text-[10.5px] text-text-faint transition-colors duration-100 ease-out group-hover:text-text-subtle">
            {/* Counts what is ON SCREEN. The ceiling below drops the oldest steps,
                and a head that kept printing the raw total would assert a list
                longer than the one it labels. */}
            {shown.length === steps.length
              ? `${steps.length} steps`
              : `${shown.length} of ${steps.length} steps`}
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
  step: ReasoningStepModel
}) {
  if (step.kind === 'withheld') {
    return (
      <li className="relative py-0.5 text-[12.5px] leading-normal text-text-faint">
        <ReasoningNode placement="rail" withheld />
        {REASONING_WITHHELD_TEXT}
      </li>
    )
  }
  return (
    <li
      className="relative py-0.5 text-[12.5px] leading-normal text-text-subtle"
      title={REASONING_TITLE}
    >
      <ReasoningNode placement="rail" />
      {step.kind === 'heading' ? (
        <ReasoningHeading content={step.text} />
      ) : (
        <ReasoningProse content={step.text} />
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
function ReasoningProse({ content }: { content: string }) {
  const [hidden, setHidden] = useState(false)
  return (
    <>
      {hidden ? null : (
        <div className="mb-1.5 mt-1 border-l border-shell-seam pl-2.5 text-[13px] leading-relaxed text-text-subtle [&>*+*]:mt-2">
          <MarkdownErrorBoundary fallback={content}>
            <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
          </MarkdownErrorBoundary>
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
function ReasoningHeading({ content }: { content: string }) {
  return (
    <span className="break-words">
      <MarkdownErrorBoundary fallback={content}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          components={{ p: ({ children }) => <>{children}</> }}
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
 * SystemNoticeRow: the notice box for the three projected notice types
 * (api_retry / local_command_output / account_diagnostic), each with its own
 * glyph + tone. The type is carried by that glyph and tone alone: it used to
 * also print the raw discriminant in the corner, which is a debug tag, not a
 * word anyone reads (CLAUDE.md §7).
 */
function SystemNoticeBox({
  noticeType,
  content,
}: {
  noticeType: 'api_retry' | 'local_command_output' | 'account_diagnostic'
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
  'api_retry' | 'local_command_output' | 'account_diagnostic',
  { glyph: string; glyphTone: string }
> = {
  api_retry: { glyph: '↻', glyphTone: 'text-tone-warn' },
  local_command_output: { glyph: '›', glyphTone: 'text-text-muted' },
  account_diagnostic: { glyph: '!', glyphTone: 'text-tone-warn' },
}

/** Status → dot tone, shared by the standalone row and the agent card's finish. */
function agentCompletionTone(status: string | null): string {
  return status === 'failed' || status === 'killed'
    ? 'bg-tone-danger'
    : status === 'completed'
      ? 'bg-tone-good'
      : 'bg-text-subtle'
}

/**
 * TaskNotificationRow: a background agent's finish that could NOT be folded
 * into its agent card (no join key on the wire, or the card never arrived).
 * One line, the way both references render it: the prototype's `AgentEventRow`
 * (`Messages.jsx:843-870`) is a pip plus a name plus a state word, and the
 * terminal's `UserAgentNotificationMessage.tsx:46` is `● {summary}` and nothing
 * else.
 *
 * The banner text this row rides is MODEL-facing — it carries the task id, the
 * output-file path and the tool-use id — so it is never printed; only the
 * engine's own one-line `summary` is (bug, 2026-08-01). No summary means no
 * row, exactly as the terminal returns null without one: an empty banner shell
 * tells the operator less than nothing.
 *
 * No status word rides alongside: every summary the engine mints already ends
 * in its outcome (`Agent @Ada completed`, `… failed: …`, `… was stopped`,
 * `LocalAgentTask.tsx:325`), so a chip would print the same word twice. The
 * dot carries it as tone.
 */
function TaskNotificationBox({
  status,
  summary,
}: {
  status: string | null
  summary: string | null
}) {
  if (summary === null) return null
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-1.5">
      <span
        className={`size-1.5 shrink-0 rounded-full ${agentCompletionTone(status)}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
        {summary}
      </span>
    </div>
  )
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
 * A background agent's finish, shown INSIDE its own agent card rather than as a
 * second transcript row. This is the prototype's disposition: `data.js:153-165`
 * joins the completion to the named spawn card on the task id and drops the
 * duplicate row, because the notification is a `role:'user'` message upstream
 * and "rendering it as a human turn would misread the conversation".
 *
 * Mirrors `AgentTranscriptCard`'s own result grammar (`Messages.jsx:826-832`):
 * a labelled result body plus a stats line. The summary is NOT repeated here —
 * the card header already names the agent and shows its state, so the line
 * would say what the operator can already read (§7 "say only what is
 * surprising").
 */
function AgentCompletionBody({
  completion,
}: {
  completion: AgentCompletionProjection
}) {
  const { result, usage } = completion
  const stats = usage
    ? [
        `~${compactCount(usage.totalTokens)} tokens`,
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
      <span className="shrink-0 font-mono text-[9.5px] text-text-subtle/70">
        {style.tag}
      </span>
    </div>
  )
}

type InjectedTurnStyle = {
  glyph: string
  /** Heading when the origin names no sender. */
  heading: string
  /** Prefix in front of a named sender (`@` for a teammate, '' for a channel). */
  prefix: string
  /** Trailing debug tag, matching the SystemNoticeBox/TaskNotificationBox idiom. */
  tag: string
}

const INJECTED_TURN_STYLE: Record<string, InjectedTurnStyle> = {
  channel: { glyph: '←', heading: 'Channel message', prefix: '', tag: 'channel' },
  teammate: { glyph: '@', heading: 'Teammate', prefix: '@', tag: 'teammate' },
  coordinator: {
    glyph: '⤷',
    heading: 'Coordinator',
    prefix: '',
    tag: 'coordinator',
  },
  'deferred-continuation': {
    glyph: '⏱',
    heading: 'Continuation',
    prefix: '',
    tag: 'continuation',
  },
}

const INJECTED_TURN_FALLBACK: InjectedTurnStyle = {
  glyph: '⤷',
  heading: 'Injected message',
  prefix: '',
  tag: 'injected',
}

/**
 * ResultRow: the turn/session-end seam. Tone + label encode completed vs
 * errored; duration and cost ride as middot-separated detail.
 */
const RESULT_ERROR_LABELS = new Map([
  ['error_during_execution', 'Errored during execution'],
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
  // #6 (operator, 2026-07-19): the success turn-footer was removed — a completed
  // turn shows no seam. Only error/abort turns (isError) still surface a seam so
  // a broken turn stays visible. `isError` is the same signal that drives tone.
  if (!isError) return null
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

/** CompactBoundaryRow: the ✻ pink "memory" seam for conversation compaction. */
function CompactBoundarySeam({
  trigger,
  preTokens,
}: {
  trigger: 'manual' | 'auto'
  preTokens: number
}) {
  return (
    <Seam
      tone="accent"
      glyph="✻"
      label="Conversation compacted"
      detail={`${trigger} · ${preTokens.toLocaleString()} tokens`}
    />
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

type DiffLineKind = 'add' | 'del' | 'ctx'

// Exact prototype DiffView line grammar (Messages.jsx:182-186): a del/add row
// tints red-500/green-500 at 0.1 with #fca5a5/#86efac (red-300/green-300) body
// text; the sign glyph is the brighter tone-danger/tone-success (#f87171/#4ade80)
// and context stays in the ghost/faint greys the prototype uses (#52525b body,
// #3f3f46 sign). Static classes only.
const DIFF_ROW_CLASS: Record<DiffLineKind, string> = {
  // Exact prototype row washes rgba(34,197,94,0.1) / rgba(239,68,68,0.1). NOT the
  // green-500/red-500 utilities — Tailwind v4's oklch palette drifted those to
  // #00c758 / #fb2c36, so a literal hex keeps the prototype value exact.
  add: 'bg-[#22c55e]/10 text-[#86efac]',
  del: 'bg-[#ef4444]/10 text-[#fca5a5]',
  ctx: 'text-text-faint',
}

const DIFF_SIGN_CLASS: Record<DiffLineKind, string> = {
  add: 'text-tone-success',
  del: 'text-tone-danger',
  ctx: 'text-text-ghost',
}

// Word-level intra-line highlight (prototype DiffView, Messages.jsx:160-168): a
// CHANGED word carries the exact rgba(248,113,113,0.28) / rgba(74,222,128,0.26)
// wash (= tone-danger/28, tone-success/26) with a 2px radius + 1px x-pad; an
// UNCHANGED word dims to the prototype's #fca5a5 / #86efac at 0.55 alpha.
const WORD_EMPH_CLASS: Record<'del' | 'add', string> = {
  del: 'rounded-[2px] bg-tone-danger/28 px-px',
  add: 'rounded-[2px] bg-tone-success/26 px-px',
}
const WORD_DIM_CLASS: Record<'del' | 'add', string> = {
  del: 'text-[#fca5a5]/55',
  add: 'text-[#86efac]/55',
}

type WordDiffSide = { value: string; changed: boolean }[]
type DiffHunkModel = ToolDiffProjection['hunks'][number]

/**
 * Word-level intra-line highlight for a replaced line pair (prototype DiffView,
 * Messages.jsx:132-151). `diffWordsWithSpace` tokenizes old vs new; the prototype
 * only word-highlights when < 90% of the line changed (a near-total rewrite reads
 * better line-level). Returns null (→ line-level fallback) on that guard, on an
 * empty diff, or on ANY throw — DiffView is not under the prose error boundary
 * and SSR would not catch a throw here, so this must degrade in-place, never
 * bubble (display = degrade gracefully).
 */
function wordDiffPair(
  oldLine: string,
  newLine: string,
): { del: WordDiffSide; add: WordDiffSide } | null {
  try {
    const parts = diffWordsWithSpace(oldLine, newLine)
    let changed = 0
    let total = 0
    for (const part of parts) {
      total += part.value.length
      if (part.added || part.removed) changed += part.value.length
    }
    if (total === 0 || changed / total >= 0.9) return null
    const del: WordDiffSide = []
    const add: WordDiffSide = []
    for (const part of parts) {
      if (!part.added) del.push({ value: part.value, changed: part.removed === true })
      if (!part.removed) add.push({ value: part.value, changed: part.added === true })
    }
    return { del, add }
  } catch {
    return null
  }
}

/** One word-diffed line body: changed words get the emphasis wash, unchanged
 * words dim (prototype `renderLine`). */
function WordDiffBody({ side, segments }: { side: 'del' | 'add'; segments: WordDiffSide }) {
  return (
    <>
      {segments.map((seg, index) => (
        <span
          key={index}
          className={seg.changed ? WORD_EMPH_CLASS[side] : WORD_DIM_CLASS[side]}
        >
          {seg.value}
        </span>
      ))}
    </>
  )
}

/**
 * One hunk: classify each line, walk the dual old/new gutters from the hunk's
 * `oldStart`/`newStart`, and pair consecutive del-runs with add-runs for the
 * word-level intra-line highlight (prototype pairing, Messages.jsx:134-150).
 */
function DiffHunk({ hunk, hunkIndex }: { hunk: DiffHunkModel; hunkIndex: number }) {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  const rows = hunk.lines.map(line => {
    const kind: DiffLineKind = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : 'ctx'
    const body = kind === 'ctx' ? line : line.slice(1)
    const oldLabel = kind === 'add' ? '' : String(oldNo)
    const newLabel = kind === 'del' ? '' : String(newNo)
    if (kind !== 'add') oldNo++
    if (kind !== 'del') newNo++
    return { kind, body, oldLabel, newLabel }
  })
  // Pair each consecutive run of removes with the following run of adds; a
  // successful pair carries the per-side word segments for that row index.
  const wordInfo: Record<number, WordDiffSide> = {}
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'del') {
      i++
      continue
    }
    const dels: number[] = []
    while (i < rows.length && rows[i].kind === 'del') dels.push(i++)
    const adds: number[] = []
    while (i < rows.length && rows[i].kind === 'add') adds.push(i++)
    const pairs = Math.min(dels.length, adds.length)
    for (let p = 0; p < pairs; p++) {
      const seg = wordDiffPair(rows[dels[p]].body, rows[adds[p]].body)
      if (seg) {
        wordInfo[dels[p]] = seg.del
        wordInfo[adds[p]] = seg.add
      }
    }
  }
  return (
    <>
      {rows.map((row, lineIndex) => {
        const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
        const segments = wordInfo[lineIndex]
        return (
          <div
            key={`${hunkIndex}:${lineIndex}`}
            className={`flex whitespace-pre ${DIFF_ROW_CLASS[row.kind]}`}
          >
            <span className="w-[26px] shrink-0 select-none pr-[7px] text-right tabular-nums text-text-ghost">
              {row.oldLabel}
            </span>
            <span className="w-[26px] shrink-0 select-none pr-[7px] text-right tabular-nums text-text-ghost">
              {row.newLabel}
            </span>
            <span className="min-w-0 flex-1 border-l border-white/[0.05] pl-2.5 pr-3.5">
              <span className={DIFF_SIGN_CLASS[row.kind]}>{sign}</span>{' '}
              {segments ? (
                <WordDiffBody side={row.kind === 'del' ? 'del' : 'add'} segments={segments} />
              ) : (
                row.body
              )}
            </span>
          </div>
        )
      })}
    </>
  )
}

/**
 * `DiffView`/`MultiDiffCard` (INVENTORY W3 ⚓2): one file's hunks, dual old/new
 * line-number gutters + a +adds/−dels file-header count (P4-18b). Multiple hunks
 * in the SAME file (`FileEditTool`'s own multi-edit input) render as successive
 * blocks under one header — there is no seam shape for one result spanning many
 * separate files (`ToolDiffProjection` doc). Gutter numbers walk each hunk from
 * its `oldStart`/`newStart`. P4-18c adds the word-level intra-line highlight
 * (`DiffHunk`/`wordDiffPair`, prototype `Diff.diffWordsWithSpace`).
 */
function DiffView({ diff }: { diff: ToolDiffProjection }) {
  const { adds, dels } = countDiff(diff)
  return (
    <div className="font-mono text-xs leading-[1.65]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.05] pb-1.5 text-[11.5px] text-text-muted">
        <span className="min-w-0 flex-1 truncate">{diff.filePath}</span>
        {adds > 0 ? <span className="shrink-0 text-[#86efac]">+{adds}</span> : null}
        {dels > 0 ? <span className="shrink-0 text-[#fca5a5]">−{dels}</span> : null}
      </div>
      <div className="overflow-x-auto">
        {diff.hunks.map((hunk, hunkIndex) => (
          <DiffHunk key={hunkIndex} hunk={hunk} hunkIndex={hunkIndex} />
        ))}
      </div>
    </div>
  )
}
