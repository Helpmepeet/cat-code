/**
 * Renders the projector's view models (transcriptProjector.ts — §5 layer 2).
 * P1-3: structure over polish — a markdown text row and a bare tool card
 * styled with the P0-2 tokens only. P2-2 extends the tool card with its
 * derived status, family, and (when the result narrowed to one)
 * DiffView/MultiDiffCard — still structural, not the prototype's pixel
 * design (that is later visual-polish work); subagent rows nest via
 * `NestedTranscriptRow.children`, never interleaved at top level (D2/C4).
 */

import Markdown from 'react-markdown'
import type { SessionId } from '../../shared/protocol.js'
import {
  selectNestedTranscriptRows,
  type NestedTranscriptRow,
  type TranscriptState,
  type ToolCardStatus,
  type ToolDiffProjection,
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
  if (row.kind === 'assistant-text') {
    return (
      <div className="font-sans text-sm leading-relaxed [&>*+*]:mt-2 [&_code]:font-mono [&_a]:text-accent [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
        <Markdown>{row.content}</Markdown>
      </div>
    )
  }

  // P2-1 row families have dedicated presentation work outside this slice.
  if (row.kind !== 'tool-use') return null

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
