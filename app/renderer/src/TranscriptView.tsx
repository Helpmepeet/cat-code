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

import Markdown from 'react-markdown'
import type { SessionId } from '../../shared/protocol.js'
import {
  selectNestedTranscriptRows,
  type NestedTranscriptRow,
  type TranscriptState,
  type ToolCardStatus,
  type ToolDiffProjection,
  type UserImageSource,
} from './transcriptProjector.js'

export function TranscriptView({
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
}

export function TranscriptRowsView({ rows }: { rows: NestedTranscriptRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-text-subtle">No transcript rows yet.</div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map(row => (
        <TranscriptRowView key={row.id} row={row} />
      ))}
    </div>
  )
}

function TranscriptRowView({ row }: { row: NestedTranscriptRow }) {
  // Captured before the switch narrows `row` to `never` in the default branch,
  // so the tolerant fallback can name the drifted kind without an `as` cast.
  const rowKind: string = row.kind
  switch (row.kind) {
    case 'assistant-text':
      // Prose/markdown depth (GFM tables, code highlighting, streaming caret,
      // copy chip) is 18c; 18a keeps the bare react-markdown body.
      return (
        <div className="font-sans text-sm leading-relaxed [&>*+*]:mt-2 [&_code]:font-mono [&_a]:text-accent [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
          <Markdown>{row.content}</Markdown>
        </div>
      )

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

    case 'session-init':
      return (
        <SessionInitBanner
          cwd={row.cwd}
          model={row.model}
          tools={row.tools}
          permissionMode={row.permissionMode}
        />
      )

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
}

/**
 * P2-2 tool card (generic family + name + status + input + result + nested
 * subagent children). Per-family VISUALS (Bash tail-peek, FileRead numbering,
 * Grep results, image tiles, agent activity chrome) are 18b — they replace
 * this generic body; 18a leaves it untouched and only preserves D2/C4 nesting.
 */
function ToolCard({
  row,
}: {
  row: Extract<NestedTranscriptRow, { kind: 'tool-use' }>
}) {
  return (
    <div className="rounded border border-accent/40 bg-app-bg p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wide text-accent">
          {row.toolFamily}
        </span>
        <span className="font-mono text-xs text-text-primary">{row.toolName}</span>
        <ToolStatusBadge status={row.status} />
      </div>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
        {JSON.stringify(row.input, null, 2)}
      </pre>
      {row.result ? (
        <div
          className={
            row.result.isError
              ? 'mt-2 whitespace-pre-wrap rounded border border-tone-danger/40 bg-app-bg p-2 font-mono text-xs text-tone-danger'
              : 'mt-2 whitespace-pre-wrap rounded border border-text-subtle/40 bg-app-bg p-2 font-mono text-xs text-text-muted'
          }
        >
          {row.result.diff ? (
            <DiffView diff={row.result.diff} />
          ) : (
            row.result.content
          )}
        </div>
      ) : null}
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
 * SessionInitRow: the ✦ session-start banner — cwd, model, tool count, and
 * permission mode from the real `system/init` frame.
 */
function SessionInitBanner({
  cwd,
  model,
  tools,
  permissionMode,
}: {
  cwd: string
  model: string
  tools: string[]
  permissionMode: string
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-2">
      <span className="text-[13px] leading-none text-text-subtle" aria-hidden>
        ✦
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold uppercase tracking-[0.07em] text-text-subtle">
          Session started
        </div>
        <div className="truncate font-mono text-[11.5px] text-text-muted">
          {cwd}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <MetaPair label="model" value={model} />
          <MetaPair label="tools" value={String(tools.length)} />
          <MetaPair label="mode" value={permissionMode} />
        </div>
      </div>
    </div>
  )
}

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] text-text-subtle/70">{label}</span>
      <span className="font-mono text-[11px] text-text-muted">{value}</span>
    </span>
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

function ToolStatusBadge({ status }: { status: ToolCardStatus }) {
  const label = status === 'pending' ? 'running' : status
  // `--tone-warn` is deliberately left unset (theme.css P1-0 TODO: no
  // source-approved color yet) — `pending` uses the accent token instead of
  // an undefined class that would silently no-op.
  const tone =
    status === 'error'
      ? 'text-tone-danger'
      : status === 'pending'
        ? 'text-accent'
        : 'text-tone-success'
  return <span className={`font-mono text-xs ${tone}`}>{label}</span>
}

/**
 * `DiffView`/`MultiDiffCard` (INVENTORY W3 ⚓2): one file's hunks. Multiple
 * hunks in the SAME file (`FileEditTool`'s own multi-edit input) render as
 * successive hunk blocks under one file header — there is no seam shape for
 * a single result spanning many separate files (`ToolDiffProjection` doc).
 */
function DiffView({ diff }: { diff: ToolDiffProjection }) {
  return (
    <div>
      <div className="mb-1 font-mono text-xs text-text-primary">
        {diff.filePath}
      </div>
      {diff.hunks.map((hunk, index) => (
        <pre
          key={`${hunk.oldStart}:${hunk.newStart}:${index}`}
          className="overflow-x-auto whitespace-pre font-mono text-xs"
        >
          {hunk.lines.map((line, lineIndex) => (
            <div
              key={lineIndex}
              className={
                line.startsWith('+')
                  ? 'text-tone-success'
                  : line.startsWith('-')
                    ? 'text-tone-danger'
                    : 'text-text-muted'
              }
            >
              {line}
            </div>
          ))}
        </pre>
      ))}
    </div>
  )
}
