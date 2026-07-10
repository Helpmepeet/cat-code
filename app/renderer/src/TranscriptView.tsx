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
  memo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import type { SessionId } from '../../shared/protocol.js'
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
  deriveAgentDisplayVocabulary,
  type AgentToolSource,
} from './agentIdentity.js'
import {
  AgentRoleDot,
  AgentStateLabel,
  Baton,
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './AgentChrome.js'

// Perf (2026-07-08, F3): memoized so an App re-render that did NOT change this
// session's transcript slice (a keystroke in the composer, another session's
// frame) skips the whole subtree. `state`/`activeSessionId` are referentially
// stable across those, and `selectNestedTranscriptRows` is slice-cached, so the
// `rows` handed to TranscriptRowsView keep identity when nothing changed.
export const TranscriptView = memo(function TranscriptView({
  state,
  activeSessionId,
}: {
  state: TranscriptState
  activeSessionId: SessionId | null
}) {
  return (
    <TranscriptRowsView
      rows={selectNestedTranscriptRows(state, activeSessionId)}
    />
  )
})

export const TranscriptRowsView = memo(function TranscriptRowsView({
  rows,
}: {
  rows: NestedTranscriptRow[]
}) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-text-subtle">No transcript rows yet.</div>
    )
  }

  // D2/§3 DelegateGroup: coalesce co-spawned parallel agents into ONE grouped
  // card at read time — a pure derivation over the already-nested rows, never a
  // new frame or message type (C3). Non-agent rows and lone agents pass through.
  const items: TranscriptDisplayItem[] = groupAgentDelegates(rows)
  return (
    <div className="flex flex-col gap-3">
      {items.map(item =>
        item.kind === 'agent-group' ? (
          <DelegateGroup key={item.id} members={item.members} />
        ) : (
          <TranscriptRowView key={item.row.id} row={item.row} />
        ),
      )}
    </div>
  )
})

// Memoized per row: a slice-cached read reuses unchanged row objects, so only
// the rows that actually changed re-render (markdown re-parses once per body).
const TranscriptRowView = memo(function TranscriptRowView({
  row,
}: {
  row: NestedTranscriptRow
}) {
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
      return (
        <ThinkingBlock content={row.content} reasoningKind={row.reasoningKind} />
      )

    case 'redacted-thinking':
      return <RedactedThinkingBlock />

    case 'system-notice':
      return (
        <SystemNoticeBox noticeType={row.noticeType} content={row.content} />
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
 * P4-18c assistant prose. react-markdown for the core GFM-less set (headings,
 * bold/italic, inline code, lists, links, hr, blockquote) wrapped in a
 * render-error boundary (a throw degrades to the plain source, never a React
 * crash — display = degrade gracefully). Fenced code blocks render in a framed
 * panel with a per-block copy button. Long bodies (>60 lines) collapse behind a
 * "Show N more lines" control. A streaming body carries a blinking caret.
 *
 * §5 deferrals (need a new dep, gated on operator approval — CLAUDE.md §7 "no
 * new deps without asking"): GFM pipe TABLES (`remark-gfm`) and fenced-code
 * SYNTAX-TOKEN highlighting (a highlighter). Code renders framed + copyable but
 * un-colorized; tables render as raw text until the deps are approved.
 */
const PROSE_COLLAPSE_LINES = 60

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
  return (
    <div>
      <MarkdownErrorBoundary fallback={content}>
        <div className="font-sans text-sm leading-relaxed [&>*+*]:mt-2 [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-shell-seam [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-accent-soft">
          <Markdown components={MARKDOWN_COMPONENTS}>{shown}</Markdown>
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

/** Flatten react-markdown code children (string, or node array) to raw text. */
function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (typeof children === 'number') return String(children)
  return ''
}

const MARKDOWN_COMPONENTS = {
  // react-markdown wraps a fenced block in <pre><code>; unwrap the <pre> and let
  // the <code> renderer own the framed CodeBlock (avoids a nested <pre>).
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  code: ({ className, children }: ComponentPropsWithoutRef<'code'>) => {
    const match = /language-(\w+)/.exec(className ?? '')
    const text = childrenToText(children)
    if (!match && !text.includes('\n')) {
      return <code className={className}>{children}</code>
    }
    return <CodeBlock lang={match?.[1] ?? ''} code={text.replace(/\n$/, '')} />
  },
}

/**
 * Fenced code block: framed panel + language label + per-block copy button.
 * Syntax-token highlighting is a §5 dep-gated deferral (no highlighter in
 * `app/`) — the code renders plain but framed and copyable.
 */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
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
    <div className="my-2 overflow-hidden rounded-md border border-shell-seam bg-black/30">
      <div className="flex items-center justify-between border-b border-shell-seam px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-text-subtle">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="font-mono text-[10px] text-text-subtle transition-colors hover:text-text-primary"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed text-text-muted">
        <code>{code}</code>
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
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)
  const fam = FAMILY_STYLE[family]
  const st = STATE_STYLE[status]
  const hasBody = children !== undefined && children !== null
  return (
    <div className="w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.025] font-sans">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
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
      </ToolCardShell>
      {row.children.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-l border-accent/20 pl-3">
          {row.children.map(child => (
            <TranscriptRowView key={child.id} row={child} />
          ))}
        </div>
      ) : null}
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
          {row.children.map(child => (
            <TranscriptRowView key={child.id} row={child} />
          ))}
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
      return <BashBody content={content} isError={errorTone} />
    case 'read':
      return <NumberedBody content={content} />
    case 'write':
      return <AdditionsBody content={content} />
    case 'imagegen':
      return <ImageResultBody content={content} isError={errorTone} />
    default:
      return <PlainLinesBody content={content} isError={errorTone} />
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

const MAX_INLINE_TOOL_LINES = 400

function BashBody({ content, isError }: { content: string; isError: boolean }) {
  const lines = content.split('\n')
  const shown = lines.slice(0, MAX_INLINE_TOOL_LINES)
  return (
    <div>
      <pre className="max-h-[340px] overflow-auto whitespace-pre font-mono text-[11.5px] leading-relaxed">
        {shown.map((line, index) => (
          <div key={index} className={isError ? 'text-tone-danger' : bashLineClass(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>
      <ToolOverflowNote total={lines.length} shown={shown.length} unit="lines" />
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

function NumberedBody({ content }: { content: string }) {
  const lines = content.split('\n').slice(0, MAX_INLINE_TOOL_LINES)
  return (
    <pre className="max-h-[340px] overflow-auto whitespace-pre font-mono text-[11.5px] leading-relaxed text-text-muted">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="mr-3 w-8 shrink-0 select-none text-right tabular-nums text-text-subtle/60">
            {index + 1}
          </span>
          <span className="min-w-0">{line || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

/** File-write additions view: every line prefixed with a green `+`. */
function AdditionsBody({ content }: { content: string }) {
  const lines = content.split('\n').slice(0, MAX_INLINE_TOOL_LINES)
  return (
    <pre className="max-h-[340px] overflow-auto whitespace-pre font-mono text-[11.5px] leading-relaxed text-tone-success">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="mr-2 w-3 shrink-0 select-none text-right">+</span>
          <span className="min-w-0">{line || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

function PlainLinesBody({ content, isError }: { content: string; isError: boolean }) {
  const lines = content.split('\n')
  const shown = lines.slice(0, MAX_INLINE_TOOL_LINES).join('\n')
  return (
    <div>
      <pre
        className={`max-h-[340px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${
          isError ? 'text-tone-danger' : 'text-text-muted'
        }`}
      >
        {shown}
      </pre>
      <ToolOverflowNote total={lines.length} shown={lines.slice(0, MAX_INLINE_TOOL_LINES).length} unit="lines" />
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

function ToolOverflowNote({
  total,
  shown,
  unit,
}: {
  total: number
  shown: number
  unit: string
}) {
  if (total <= shown) return null
  return (
    <div className="mt-1 border-t border-shell-seam pt-1 font-mono text-[10px] text-text-subtle/70">
      {total - shown} more {unit} — open the full-output inspector to view all
    </div>
  )
}

/**
 * "User side" grammar (Messages.jsx UserBubble): right-aligned, accent-tinted,
 * bottom-right-notched bubble. Shared shape with the command echo + image rows
 * so a user's own turns read as one column against the assistant's left body.
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
function ThinkingBlock({
  content,
  reasoningKind,
}: {
  content: string
  reasoningKind?: string
}) {
  return (
    <div className="rounded-lg border border-accent/15 bg-accent/[0.04]">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent">
          Thinking
        </span>
        {reasoningKind ? (
          <span className="font-mono text-[10px] text-text-subtle">
            {reasoningKind}
          </span>
        ) : null}
      </div>
      <div className="whitespace-pre-wrap border-t border-accent/10 px-3.5 py-2.5 text-[13px] italic leading-relaxed text-text-subtle">
        {content}
      </div>
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

const DIFF_ROW_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-tone-success/10 text-tone-success',
  del: 'bg-tone-danger/10 text-tone-danger',
  ctx: 'text-text-subtle',
}

const DIFF_SIGN_CLASS: Record<DiffLineKind, string> = {
  add: 'text-tone-success',
  del: 'text-tone-danger',
  ctx: 'text-text-subtle/50',
}

/**
 * `DiffView`/`MultiDiffCard` (INVENTORY W3 ⚓2): one file's hunks, dual old/new
 * line-number gutters + a +adds/−dels file-header count (P4-18b). Multiple hunks
 * in the SAME file (`FileEditTool`'s own multi-edit input) render as successive
 * blocks under one header — there is no seam shape for one result spanning many
 * separate files (`ToolDiffProjection` doc). Gutter numbers walk each hunk from
 * its `oldStart`/`newStart`. Word-level intra-line highlight (`Diff.diffWords`)
 * is a §5 deferral — it needs a diff-tokenizer dep not in `app/`.
 */
function DiffView({ diff }: { diff: ToolDiffProjection }) {
  const { adds, dels } = countDiff(diff)
  return (
    <div className="font-mono text-xs leading-[1.65]">
      <div className="flex items-center gap-2.5 border-b border-shell-seam pb-1.5 text-[11.5px] text-text-muted">
        <span className="min-w-0 flex-1 truncate">{diff.filePath}</span>
        {adds > 0 ? <span className="shrink-0 text-tone-success">+{adds}</span> : null}
        {dels > 0 ? <span className="shrink-0 text-tone-danger">−{dels}</span> : null}
      </div>
      <div className="overflow-x-auto">
        {diff.hunks.map((hunk, hunkIndex) => {
          let oldNo = hunk.oldStart
          let newNo = hunk.newStart
          return hunk.lines.map((line, lineIndex) => {
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
            const sign = kind === 'add' ? '+' : kind === 'del' ? '−' : ' '
            return (
              <div
                key={`${hunkIndex}:${lineIndex}`}
                className={`flex whitespace-pre ${DIFF_ROW_CLASS[kind]}`}
              >
                <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-text-subtle/50">
                  {oldLabel}
                </span>
                <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-text-subtle/50">
                  {newLabel}
                </span>
                <span className="min-w-0 flex-1 border-l border-shell-seam pl-2.5">
                  <span className={DIFF_SIGN_CLASS[kind]}>{sign}</span> {body}
                </span>
              </div>
            )
          })
        })}
      </div>
    </div>
  )
}
