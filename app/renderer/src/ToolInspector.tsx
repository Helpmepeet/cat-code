/**
 * P4-1 shared primitive — `ToolInspector` (Surfaces.jsx:1090-1147).
 *
 * A read-only side drawer over a transcript tool row's REAL input/result. It
 * reuses the projector's `ToolUseRow` shape (transcriptProjector.ts) with ZERO
 * casts and narrows tolerantly — a malformed/partial input never crashes the
 * drawer, it degrades to `—`. The prototype's single fixture `toolSummary`
 * string is replaced by a derived summary PLUS the real structured input.
 *
 * Security (hard gate): this renders untrusted tool input and model/tool output.
 * Everything is a text node — `JSON.stringify` for the structured input, plain
 * strings for output/diff. NEVER `dangerouslySetInnerHTML`, never `eval`, never
 * a live control (the prototype's "Open diff in IDE" affordance has no real verb
 * and is dropped — flagged in the report).
 */

import type { ReactNode } from 'react'
import type {
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolUseRow,
} from './transcriptProjector.js'
import { toneClasses, type Tone } from './tone.js'

export type ToolInspectorModel = {
  family: ToolFamily
  name: string
  /** A best-effort one-line summary derived from the real input (never throws). */
  summary: string
  status: ToolCardStatus
  statusLabel: string
  statusTone: Tone
  /** The real, structured tool input — rendered as read-only JSON text. */
  input: Record<string, unknown>
  /** A narrowed FileEditTool diff, when the result carried one. */
  diff: ToolDiffProjection | null
  /** The result's flattened text output, when non-empty. */
  output: string | null
}

/**
 * Keys whose value (if a non-empty string) makes the best summary line, most
 * salient first. The engine's real tool inputs use these
 * (BashTool `command`, Read/Edit `file_path`, Grep `pattern`, WebFetch `url`,
 * Agent `prompt`, …); anything unrecognised falls back to the first string
 * value, then to `—`. Tolerant by construction.
 */
const SUMMARY_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'name',
] as const

const STATUS_TONE: Record<ToolCardStatus, Tone> = {
  pending: 'accent',
  success: 'good',
  error: 'danger',
}

const STATUS_LABEL: Record<ToolCardStatus, string> = {
  pending: 'running',
  success: 'success',
  error: 'error',
}

export function describeToolForInspector(row: ToolUseRow): ToolInspectorModel {
  const input = isRecord(row.input) ? row.input : {}
  return {
    family: row.toolFamily,
    name: row.toolName,
    summary: deriveSummary(input),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? 'unknown',
    statusTone: STATUS_TONE[row.status] ?? 'default',
    input,
    diff: row.result?.diff ?? null,
    output: nonEmpty(row.result?.content),
  }
}

function deriveSummary(input: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  return 'none'
}

export function ToolInspector({
  row,
  onClose,
}: {
  row: ToolUseRow | null
  onClose?: () => void
}): ReactNode {
  if (!row) return null
  const model = describeToolForInspector(row)
  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-shell-seam bg-surface-panel">
      <div className="flex items-center justify-between border-b border-shell-seam px-[18px] py-3.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
            {model.family}
          </span>
          <span className="text-[13px] font-semibold text-text-primary">
            Tool inspector
          </span>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tool inspector"
            className="flex h-[22px] w-[22px] items-center justify-center text-base leading-none text-text-subtle hover:text-text-primary"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-[18px] py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SectionLabel>Tool</SectionLabel>
        <div className="mb-4 font-mono text-[12.5px] text-text-primary">
          {model.name}
        </div>

        <SectionLabel>Summary</SectionLabel>
        <div className="mb-4 break-all font-mono text-[12.5px] text-text-primary">
          {model.summary}
        </div>

        <SectionLabel>Status</SectionLabel>
        <div
          className={`mb-4 text-[12.5px] capitalize ${toneClasses(model.statusTone).text}`}
        >
          {model.statusLabel}
        </div>

        <SectionLabel>Input</SectionLabel>
        <pre className="mb-4 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-shell-seam bg-black/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-text-muted">
          {safeStringify(model.input)}
        </pre>

        {model.diff ? (
          <>
            <SectionLabel>Diff · {model.diff.filePath}</SectionLabel>
            <div className="mb-4 overflow-hidden rounded-lg border border-shell-seam">
              {model.diff.hunks.map((hunk, hunkIndex) => (
                <div key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={
                        'whitespace-pre px-3 font-mono text-[11.5px] leading-relaxed ' +
                        diffLineClass(line)
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {model.output ? (
          <>
            <SectionLabel>Output</SectionLabel>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-shell-seam bg-black/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-text-muted">
              {model.output}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-subtle">
      {children}
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('+')) return 'text-tone-good bg-tone-good/10'
  if (line.startsWith('-')) return 'text-tone-danger bg-tone-danger/10'
  return 'text-text-subtle'
}

/** Stringify tolerantly — a cyclic/exotic input degrades to a note, never throws. */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return json ?? String(value)
  } catch {
    return '[uninspectable input]'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
