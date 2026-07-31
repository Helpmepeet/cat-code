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
import { useToast } from './toastContext.js'
import {
  groupAgentDelegates,
  selectNestedTranscriptRows,
  type NestedToolUseRow,
  type NestedTranscriptRow,
  type TranscriptDisplayItem,
  type TranscriptState,
  type ToolCardStatus,
  type ToolDiffProjection,
  type ToolFamily,
  type UserImageSource,
} from './transcriptProjector.js'
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
import {
  findNestedToolUseRow,
  resolveToolCardExpanded,
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
  restorePhase,
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
  /** IS-C (M5) — restore affordance phase; null for an ordinary live pane. */
  restorePhase?: RestorePhase | null
}) {
  return (
    <TranscriptRowsView
      rows={selectNestedTranscriptRows(state, activeSessionId)}
      accounts={accounts ?? null}
      orchestratorActive={orchestratorActive ?? false}
      onToggleOrchestrator={onToggleOrchestrator}
      cwd={cwd ?? null}
      branch={branch ?? null}
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
  restorePhase = null,
}: {
  rows: NestedTranscriptRow[]
  accounts?: AccountsSnapshot | null
  orchestratorActive?: boolean
  onToggleOrchestrator?: (next: boolean) => void
  cwd?: string | null
  branch?: string | null
  restorePhase?: RestorePhase | null
}) {
  // P4-1: the tool row a card asked to inspect (null = drawer closed). Owned here
  // — above the memoized rows — so opening the drawer never mutates a row and the
  // overlay is a sibling of the transcript column, not nested in a scrolling row.
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const openInspector = useCallback((row: ToolUseNestedRow) => setInspectedId(row.id), [])
  const closeInspector = useCallback(() => setInspectedId(null), [])
  const { mode: reasoningMode } = useContext(ReasoningLayoutContext)
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
    const items: readonly ReasoningLayoutItem[] = groupDisplayItems(
      groupAgentDelegates(rows),
      reasoningMode,
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
        {items.map(item => (
          <DisplayItemView item={item} key={displayItemKey(item)} />
        ))}
      </div>
    )
  }

  return (
    <ToolInspectorContext.Provider value={openInspector}>
      {content}
      <ToolInspectorOverlay row={inspected} onClose={closeInspector} />
    </ToolInspectorContext.Provider>
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
  useEffect(() => {
    if (!row) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [row, onClose])
  if (!row) return null
  return (
    <div className="fixed inset-0 z-[200] flex justify-end">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex h-full shadow-2xl">
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

function displayItemKey(item: ReasoningLayoutItem): string {
  return item.kind === 'single' ? item.row.id : item.id
}

/**
 * One display item — an agent DelegateGroup, a reasoning run, or a single row.
 * The `default` branch carries the same compile-time `never` tripwire as the row
 * switch: a new display-item kind breaks the build here until it gets a case.
 */
function DisplayItemView({ item }: { item: ReasoningLayoutItem }) {
  switch (item.kind) {
    case 'agent-group':
      return <DelegateGroup members={item.members} />
    case 'reasoning-run':
      return <ReasoningRun steps={item.steps} />
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
 * runs group exactly like the top level, so a delegated GPT turn reads the same
 * inside a card as outside one.
 */
function NestedRowList({ rows }: { rows: NestedTranscriptRow[] }) {
  const { mode } = useContext(ReasoningLayoutContext)
  const items = groupDisplayItems(toDisplayItems(rows), mode)
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
      return <TaskNotificationBox status={row.status} content={row.content} />

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
 * FIXED Dracula stylesheet in `theme.css` — never dynamic Tailwind). Long bodies
 * (>60 lines) collapse behind a "Show N more lines" control. A streaming body
 * carries a blinking caret.
 *
 * Raw HTML stays OFF (react-markdown v10 default — no `rehype-raw`,
 * no `allowDangerousHtml`): a transcript can carry untrusted model/tool output.
 * `rehype-highlight` emits React <span> elements (not injected HTML), so
 * highlighting adds no raw-HTML surface.
 */
const PROSE_COLLAPSE_LINES = 60

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
  const [expanded, setExpanded] = useState(false)
  const totalLines = content.split('\n').length
  const collapsible = totalLines > PROSE_COLLAPSE_LINES
  const shown =
    collapsible && !expanded
      ? content.split('\n').slice(0, PROSE_COLLAPSE_LINES).join('\n')
      : content
  // The prototype's `showCopy` gate (Messages.jsx:2068): no chip while the reply
  // is still arriving (there is no settled answer to take yet, and the caret owns
  // that corner), and none on an empty turn.
  const copyable = !streaming && content.trim().length > 0
  return (
    // P4-38 host contract for `BubbleCopyChip`: `group relative` makes this body
    // the hover/focus group the absolute chip anchors to, and `pr-8` reserves the
    // corner so the revealed glyph never lands on the last line's text. Without
    // all three the chip anchors to a distant ancestor and stays invisible.
    <div className="group relative pr-8">
      <MarkdownErrorBoundary fallback={content}>
        <div className="font-sans font-light text-sm leading-relaxed [&>*+*]:mt-2 [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-shell-seam [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-accent-soft">
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {shown}
          </Markdown>
        </div>
      </MarkdownErrorBoundary>
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom"
          aria-hidden
        />
      ) : null}
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="mt-1 font-mono text-[11px] text-accent hover:underline"
        >
          {expanded
            ? 'Collapse'
            : `Show ${totalLines - PROSE_COLLAPSE_LINES} more lines`}
        </button>
      ) : null}
      {/* Payload is the RAW markdown `content`, never the truncated `shown`: a
          collapsed body still copies the whole reply. The chip sits at the
          wrapper's bottom-right, which in the collapsed branch is the reveal
          button's own row, opposite edge, inside the reserved gutter. */}
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
    case 'read':
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
  children?: ReactNode
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = resolveToolCardExpanded(userExpanded, defaultExpanded ?? false)
  const fam = FAMILY_STYLE[family]
  const st = STATE_STYLE[status]
  const hasBody = children !== undefined && children !== null
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.025] font-sans">
      <button
        type="button"
        onClick={() => setUserExpanded(!expanded)}
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
  // D2/C2: the Agent tool_use is rendered as the Agent member of this same
  // tool-card family (specialized body + C4 child nesting), not a sibling row.
  if (row.toolFamily === 'agent') return <AgentToolCard row={row} />

  const content = row.result?.content ?? ''
  const isImageDone = row.toolFamily === 'imagegen' && row.status === 'success'
  return (
    <div className="w-full">
      <ToolCardShell
        family={row.toolFamily}
        target={deriveTarget(row)}
        status={row.status}
        sub={deriveSub(row)}
        defaultExpanded={row.status === 'error' || isImageDone}
        collapsedExtra={
          row.toolFamily === 'bash' && content.length > 0 ? (
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
 * P4-1 "Open full output ↗" — the footer affordance inside a tool card's expanded
 * body (prototype Messages.jsx:563 "Inspector"/566 "Open full output"). Opens the
 * `ToolInspector` drawer over this card's real projected row. Sits below the body
 * so a collapsed card stays quiet; a running/errored card (default-expanded) shows
 * it immediately.
 */
function ToolInspectorLaunch({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mt-2 flex justify-end border-t border-shell-seam pt-2">
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/[0.06] px-2.5 py-1 font-mono text-[10.5px] text-accent-soft hover:bg-accent/10"
      >
        Open full output
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
  return (
    <ToolCardShell
      family="agent"
      target={deriveTarget(row)}
      status={row.status}
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
      {childCount > 0 ? (
        <div className="flex flex-col gap-2 border-l border-accent/20 pl-3">
          <NestedRowList rows={row.children} />
        </div>
      ) : null}
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
    case 'read':
      return <NumberedBody content={content} onOpenFull={openFull} />
    case 'write':
      return <AdditionsBody content={content} onOpenFull={openFull} />
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

/** Semantic bash line tint (prototype `logLineColor`), mapped to tone tokens. */
function bashLineClass(line: string): string {
  if (/(\bFAIL\b|\bERROR\b|\berror\b|npm ERR!|✕|✘|UnhandledPromise|failed)/.test(line)) {
    return 'text-tone-danger'
  }
  if (/(\bWARN(ING)?\b|exceed|collision)/i.test(line)) return 'text-tone-warn'
  if (/(\bPASS\b|✓|compiled|succeeded|\bpassed\b)/.test(line)) {
    return 'text-tone-success'
  }
  if (/^\s*(>|@ |at )/.test(line)) return 'text-text-subtle'
  return 'text-text-muted'
}

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
  const renderLines = (slice: string[]) => (
    <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed">
      {slice.map((line, index) => (
        <div key={index} className={isError ? 'text-tone-danger' : bashLineClass(line)}>
          {line || ' '}
        </div>
      ))}
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

/** Collapsed tail-peek: the last few output lines, faded (prototype bash peek). */
function BashTailPeek({ content }: { content: string }) {
  const lines = content.split('\n').filter(line => line.length > 0)
  if (lines.length === 0) return null
  const tail = lines.slice(-3)
  return (
    <div className="border-t border-shell-seam bg-black/20 px-3 py-1.5">
      <pre className="overflow-hidden whitespace-pre font-mono text-[11px] leading-relaxed text-text-subtle/80">
        {tail.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </pre>
    </div>
  )
}

/**
 * The file-READ body. `startLine` exists because the tail is not the head: after
 * the window splits, numbering the tail from 1 would label the last lines of a
 * 900-line file as its first six.
 */
function NumberedLines({ lines, startLine }: { lines: string[]; startLine: number }) {
  return (
    <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed text-text-muted">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="mr-3 w-8 shrink-0 select-none text-right tabular-nums text-text-subtle/60">
            {startLine + index}
          </span>
          <span className="min-w-0">{line || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

function NumberedBody({
  content,
  onOpenFull,
}: {
  content: string
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines)
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      <NumberedLines lines={window.head} startLine={1} />
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          <NumberedLines lines={window.tail} startLine={window.tailStartLine} />
        </>
      ) : null}
    </div>
  )
}

/** File-write additions view: every line prefixed with a green `+`. */
function AdditionLines({ lines }: { lines: string[] }) {
  return (
    <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed text-tone-success">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="mr-2 w-3 shrink-0 select-none text-right">+</span>
          <span className="min-w-0">{line || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

function AdditionsBody({
  content,
  onOpenFull,
}: {
  content: string
  onOpenFull: (() => void) | null
}) {
  const lines = content.split('\n')
  const { window, revealMore } = useInlineOutputWindow(lines)
  return (
    <div className={INLINE_OUTPUT_SCROLLER}>
      <AdditionLines lines={window.head} />
      {window.truncated ? (
        <>
          <InlineRevealBand
            hidden={window.hidden}
            revealStep={window.revealStep}
            onReveal={revealMore}
            onOpenFull={onOpenFull}
          />
          <AdditionLines lines={window.tail} />
        </>
      ) : null}
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
 * tile + Open/Copy actions need a projector data-contract change (§5 flag),
 * so this renders the real result text with a note instead of an invented tile.
 */
function ImageResultBody({ content, isError }: { content: string; isError: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <pre
        className={`overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${
          isError ? 'text-tone-danger' : 'text-text-muted'
        }`}
      >
        {content}
      </pre>
      {!isError ? (
        <span className="font-mono text-[10px] italic text-text-subtle/70">
          inline image tile pending a projector image-payload seam
        </span>
      ) : null}
    </div>
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
    <div className="flex items-center gap-2.5 border-y border-shell-seam bg-white/[0.015] px-3 py-1.5">
      <span className="shrink-0 font-mono text-[11px] text-text-subtle">
        {hidden} {hidden === 1 ? 'line' : 'lines'} hidden
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onReveal}
        className="shrink-0 rounded-md border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-text-muted hover:bg-white/[0.04]"
      >
        Show {revealStep} more
      </button>
      {onOpenFull ? (
        <button
          type="button"
          onClick={onOpenFull}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/25 bg-accent/[0.06] px-2.5 py-0.5 font-mono text-[11px] text-accent-soft hover:bg-accent/10"
        >
          Open full output
          <span aria-hidden>↗</span>
        </button>
      ) : null}
    </div>
  )
}

/**
 * Per-host wording. The prototype splits it: the assistant side toasts `Copied
 * response` (Messages.jsx:2067) and the user twin `Copied message` (`:2097`).
 * P4-38 parameterizes rather than forks `BubbleCopyChip`, so the reveal, tick,
 * timing and colour grammar stay ONE implementation across both hosts.
 */
const COPY_CHIP_TEXT = {
  message: {
    idle: 'Copy message',
    done: 'Message copied',
    toast: 'Copied message',
  },
  response: {
    idle: 'Copy response',
    done: 'Response copied',
    toast: 'Copied response',
  },
} as const

/**
 * P4-33 — the hover-reveal copy chip inside a user bubble (Messages.jsx:2094);
 * P4-38 mounts the same chip on the assistant body (`:2077`).
 * Quiet until the host is hovered or something inside it takes focus, then a
 * small clipboard glyph in the bottom-right corner; the tick pins itself visible
 * for a beat so the confirmation survives the pointer leaving.
 *
 * HOST CONTRACT: the chip is `absolute`, so its host must be the positioned
 * hover group AND reserve the corner — `group relative … pr-8`. Mounted under a
 * host that is neither, it anchors to a distant ancestor and never reveals.
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
 */
function UserBubble({ content }: { content: string }) {
  // No chip on an empty turn — there would be nothing to put on the clipboard
  // (the prototype's `showCopy` gate, Messages.jsx:2098).
  const copyable = content.trim().length > 0
  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br border border-accent/20 bg-accent/10 px-4 py-2.5 pr-8 text-sm leading-relaxed text-text-primary">
        {content}
        {copyable ? (
          <BubbleCopyChip content={content} subject="message" />
        ) : null}
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

/** Steps kept visible before the older ones fold away, mirroring the
 * "Show N more lines" idiom `AssistantProse` uses for long bodies. */
const REASONING_RUN_VISIBLE_STEPS = 4

/**
 * A run of reasoning steps. One step draws as a single line (no head, no count,
 * nothing to collapse); an all-withheld run draws as bare lines, because a head
 * asserting "N steps" over rows with no readable content would imply content
 * that does not exist. Everything else gets the head + rail + steps, with the
 * older steps folded once the run grows past `REASONING_RUN_VISIBLE_STEPS`.
 */
function ReasoningRun({ steps }: { steps: ReasoningStepModel[] }) {
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)
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

  const hidden = showAll ? 0 : Math.max(0, steps.length - REASONING_RUN_VISIBLE_STEPS)
  const shown = hidden > 0 ? steps.slice(hidden) : steps
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
            {steps.length} steps
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <ol
          id={listId}
          className="ml-2 mt-0.5 border-l border-white/10 pl-[17px] transition-colors duration-100 ease-out group-hover:border-white/[0.16]"
        >
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="py-0.5 text-[11.5px] text-text-faint hover:text-text-subtle"
              >
                {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
              </button>
            </li>
          ) : null}
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
 * glyph + tone and a trailing debug tag.
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
      <span className="shrink-0 font-mono text-[9.5px] text-text-subtle/70">
        {noticeType}
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

/**
 * TaskNotificationRow: an engine-injected agent-completion banner. Rendered
 * system-side (left, notice grammar) — NOT the right-aligned user bubble it used
 * to fall into (bug-sweep #4, 2026-07-21). Status tints a small badge; the full
 * banner text is preserved verbatim so nothing the operator saw before is lost.
 */
function TaskNotificationBox({
  status,
  content,
}: {
  status: string | null
  content: string
}) {
  const statusTone =
    status === 'failed' || status === 'killed'
      ? 'text-tone-danger'
      : status === 'completed'
        ? 'text-tone-good'
        : 'text-text-subtle'
  return (
    <div className="flex items-start gap-2 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-1.5">
      <span className="text-[12px] leading-5 text-accent" aria-hidden>
        ⤷
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-text-muted">Agent task</span>
          {status ? (
            <span className={`font-mono text-[10px] ${statusTone}`}>{status}</span>
          ) : null}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text-muted">
          {content}
        </div>
      </div>
      <span className="shrink-0 font-mono text-[9.5px] text-text-subtle/70">task</span>
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
  const label = isError
    ? subtype === 'error_max_turns'
      ? 'Stopped · max turns reached'
      : 'Errored'
    : 'Completed'
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
