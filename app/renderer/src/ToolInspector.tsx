/**
 * P4-1 shared primitive — `ToolInspector` (Surfaces.jsx:1090-1147).
 *
 * A read-only side drawer over a transcript tool row's REAL result. It reuses
 * the projector's `ToolUseRow` shape (transcriptProjector.ts) with ZERO casts
 * and narrows tolerantly — a malformed/partial input never crashes the drawer,
 * it degrades to the `none` placeholder.
 *
 * P4-37 adds the output tools the prototype's `OutputInspector` carries
 * (Messages.jsx:255-352): copy, literal search with wrap-around match stepping
 * and scroll-to-centre, and a soft-wrap toggle. Every windowed tool card points
 * the user here (`InlineRevealBand`, P4-36), so this drawer is the app's only
 * route to a full output and it has to be readable, searchable and copyable. The
 * search DECISIONS live in `outputSearchModel.ts` because this package renders
 * to static markup and cannot exercise a keystroke; this file is the thin DOM
 * half.
 *
 * WHY IT IS OUTPUT AND DIFF ONLY (2026-08-13,
 * `docs/reports/2026-08-12-tool-inspector-ux-review.md`). It used to open on a
 * Tool / Summary / Status / raw-Input stack and put the output last, so landing
 * here from `Open full output` meant scrolling past four fields the expanded
 * card had already shown in its own purpose-built body. Those four are gone and
 * the row's identity moved into the header, which is the one thing the card
 * cannot say once it is dimmed behind the backdrop. The drawer is now what its
 * one entry point promises: the complete output, searchable and copyable. The
 * raw structured input is no longer surfaced anywhere for a resolved call —
 * flagged in that report, not lost by accident.
 *
 * Security (hard gate): this renders untrusted tool input and model/tool output.
 * Everything is a text node — the derived summary, plain strings for
 * output/diff, and the search paints matched runs by SPLITTING the line into
 * text segments, never by building markup. NEVER
 * `dangerouslySetInnerHTML`, never `eval`, never a live control (the prototype's
 * "Open diff in IDE" affordance has no real verb and is dropped — flagged in the
 * report).
 */

import { useMemo, useState, type ReactNode } from 'react'
import type {
  ToolDiffProjection,
  ToolUseRow,
} from './transcriptProjector.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import { selectRawDiffLines } from './diffRowModel.js'
import {
  describeOutputSearch,
  selectOutputLineChunk,
  stepMatchIndex,
} from './outputSearchModel.js'
import { parseReadSource } from './readSource.js'
import { useToast } from './toastContext.js'
import { VirtualLineList } from './VirtualLineList.js'

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
      <div className="flex items-center justify-between gap-2 border-b border-shell-seam px-[18px] py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
            {model.family}
          </span>
          {/* WHICH output, not WHAT this drawer is. The generic title used to sit
              here above a Tool/Summary/Status/Input stack that restated the card
              the user had already expanded; the header now carries the only fact
              the card cannot supply once it is dimmed behind the backdrop, which
              is the row this output belongs to. */}
          <span className="min-w-0 truncate font-mono text-[12.5px] text-text-primary">
            {model.summary}
          </span>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close full output"
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-base leading-none text-text-subtle hover:text-text-primary"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-[18px] py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* CURRENTLY UNREACHABLE, and kept deliberately rather than deleted.
            `ToolCardBody` returns `DiffView` before any windowed body
            (`TranscriptView.tsx`, the `row.result?.diff` early return), so a row
            with a diff never renders a reveal band, and the band is now the only
            route in. Before 2026-08-13 the card footer was the other route and
            this section really did paint. Deleting it would be a second parity
            cut nobody has approved, and it comes back the moment a diff body
            gains a route; do not treat a passing test on it as proof of a live
            surface. Raised for an owner decision alongside that removal. */}
        {model.diff ? (
          <>
            <SectionLabel>Diff · {model.diff.filePath}</SectionLabel>
            <DiffPanel diff={model.diff} />
          </>
        ) : null}

        {model.output ? <OutputPanel text={model.output} /> : null}
      </div>
    </div>
  )
}

/**
 * The drawer's own diff body: the raw patch lines, tinted by sign.
 *
 * Windowed for the same reason the card's diff is (CC-62): nothing upstream
 * caps a patch, so a whole-file write reaches here as thousands of lines and
 * this panel used to mount every one of them. The row list stays complete; only
 * the mounted range is bounded, and the virtualizer bounds each row's
 * characters too, which is what a minified line needs.
 */
function DiffPanel({ diff }: { diff: ToolDiffProjection }) {
  const lines = useMemo(() => selectRawDiffLines(diff), [diff])
  return (
    <VirtualLineList
      lines={lines}
      activeIndex={null}
      className="mb-4 max-h-96 overflow-auto rounded-lg border border-shell-seam whitespace-pre px-3 font-mono text-[11.5px] leading-relaxed"
      renderLine={line => <div className={diffLineClass(line)}>{line}</div>}
    />
  )
}

/** Off is the prototype's default: long lines scroll rather than reflow. */
const WRAP_BUTTON_CLASS = {
  on: 'border-accent/40 text-accent-soft',
  off: 'border-shell-seam text-text-muted hover:text-text-primary',
} as const

/**
 * Literal classes only — an interpolated arbitrary value never reaches the JIT.
 *
 * These sit on the SCROLL BOX rather than on each line, and `white-space` and
 * `overflow-wrap` both inherit, so the rows read the same rule either way. The
 * reason for moving them is geometry: `VirtualLineList` folds its container's
 * class list into the layout revision that qualifies every measured row height,
 * and a wrap toggle changes every one of those heights without changing a
 * character of text. Toggling Wrap therefore invalidates the measurements taken
 * under the old mode instead of leaving stale ones behind rows that no longer
 * match them.
 */
const LINE_TEXT_CLASS = {
  wrap: 'whitespace-pre-wrap break-words',
  nowrap: 'whitespace-pre',
} as const

const STEP_BUTTON_CLASS = {
  enabled: 'text-text-muted hover:text-text-primary',
  disabled: 'text-text-ghost',
} as const

/**
 * The output body plus its toolbar (prototype `OutputInspector`,
 * Messages.jsx:325-352). A separate component because the drawer returns early
 * on a null row: hooks live under that guard, never beside it.
 *
 * A file READ arrives already numbered (`readSource.ts`), so this drawer had the
 * same double-gutter the read card had: the engine's `N\t` prefix inside every
 * line, and this panel's own `index + 1` beside it. The prefix is parsed off
 * here for the same three reasons it is on the card. The gutter can then show
 * the file's real lines rather than a count that restarts at 1 on an offset
 * read; a search for `1` no longer matches every line's number; and copy hands
 * over the file rather than the file plus a column of digits. Any output that
 * is NOT the engine's numbered shape passes through byte for byte.
 *
 * Syntax coloring stops at the card and does not come in here: this body paints
 * matched runs by splitting each line into segments, and a highlighter returns
 * ONE token tree for the whole block whose spans cross line boundaries. The two
 * cannot both own the text. Search is what a drawer is for, so search wins.
 */
function OutputPanel({ text }: { text: string }) {
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  // Memoized against the search below, which re-runs on every keystroke while
  // this depends only on the output itself.
  const source = useMemo(() => parseReadSource(text), [text])
  const body = useMemo(
    () => (source.numbers === null ? text : source.lines.join('\n')),
    [source, text],
  )
  const search = useMemo(
    () => describeOutputSearch(body, query, matchIndex),
    [body, query, matchIndex],
  )
  const matchCount = search.matches.length

  const step = (delta: number): void => {
    setMatchIndex(index => stepMatchIndex(index, delta, matchCount))
  }

  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(body)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
        toast('Copied output', { tone: 'success' })
      })
      .catch(() => {})
  }

  return (
    <>
      <SectionLabel>Output</SectionLabel>
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-shell-seam bg-white/[0.02] px-2 focus-within:border-accent/35">
          <span className="shrink-0 text-text-faint">
            <SearchIcon />
          </span>
          <input
            type="text"
            aria-label="Search output"
            placeholder="Search output…"
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setMatchIndex(0)
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text-primary outline-none placeholder:text-text-subtle"
          />
          {search.searching ? (
            <>
              <span className="shrink-0 text-[11px] text-text-faint [font-variant-numeric:tabular-nums]">
                {search.label}
              </span>
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={matchCount === 0}
                aria-label="Previous match"
                className={`shrink-0 px-0.5 text-[13px] leading-none ${
                  matchCount === 0
                    ? STEP_BUTTON_CLASS.disabled
                    : STEP_BUTTON_CLASS.enabled
                }`}
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={matchCount === 0}
                aria-label="Next match"
                className={`shrink-0 px-0.5 text-[13px] leading-none ${
                  matchCount === 0
                    ? STEP_BUTTON_CLASS.disabled
                    : STEP_BUTTON_CLASS.enabled
                }`}
              >
                ›
              </button>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setWrap(current => !current)}
          aria-pressed={wrap}
          title="Toggle soft wrap"
          className={`h-7 shrink-0 rounded-lg border px-2 text-[11.5px] transition-colors ${
            wrap ? WRAP_BUTTON_CLASS.on : WRAP_BUTTON_CLASS.off
          }`}
        >
          Wrap
        </button>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Output copied' : 'Copy output'}
          title="Copy output"
          className={`h-7 shrink-0 rounded-lg border px-2 text-[11.5px] transition-colors ${
            copied
              ? 'border-shell-seam text-[#86efac]'
              : 'border-shell-seam text-text-muted hover:text-text-primary'
          }`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <VirtualLineList
        lines={search.lines}
        activeIndex={search.activeLine === null ? null : search.activeLine - 1}
        className={`relative max-h-96 overflow-auto rounded-lg border border-shell-seam bg-black/40 py-2 font-mono text-[11.5px] leading-relaxed text-text-muted ${
          wrap ? LINE_TEXT_CLASS.wrap : LINE_TEXT_CLASS.nowrap
        }`}
        renderLine={(_bounded, index) => {
          // Two different numbers. The search model tracks POSITION in the
          // painted body; the gutter shows the file's own line when the
          // payload carried one.
          const position = index + 1
          const lineNumber = source.numbers?.[index] ?? position
          const active = search.activeLine === position
          // The list hands over a chunk already cut to the character budget,
          // from the start of the line. This panel holds the full line itself,
          // so it re-cuts around the active match instead: a match a megabyte
          // into one logical line has to be reachable, and only the search
          // model knows where it is.
          const chunk = selectOutputLineChunk(
            search.lines[index] ?? '',
            query,
            { anchorToMatch: active },
          )
          return (
            <div key={index} className={`flex ${active ? 'bg-accent/15' : ''}`}>
              <span className="sticky left-0 w-[42px] shrink-0 select-none bg-app-bg pr-2.5 text-right text-text-ghost [font-variant-numeric:tabular-nums]">
                {lineNumber}
              </span>
              <span className="flex-1 pl-3 pr-4">
                {chunk.truncatedStart ? '…' : null}
                {chunk.segments.map((segment, segmentIndex) =>
                  segment.match ? (
                    <mark
                      key={segmentIndex}
                      className="rounded-sm bg-tone-warn/25 px-px text-[#fde68a]"
                    >
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
                {chunk.truncatedEnd ? '…' : null}
              </span>
            </div>
          )
        }}
      />
    </>
  )
}

function SearchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
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
