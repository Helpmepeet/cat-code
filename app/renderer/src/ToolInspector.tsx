/**
 * P4-1 shared primitive — `ToolInspector` (Surfaces.jsx:1090-1147).
 *
 * A read-only side drawer over a transcript tool row's REAL input/result. It
 * reuses the projector's `ToolUseRow` shape (transcriptProjector.ts) with ZERO
 * casts and narrows tolerantly — a malformed/partial input never crashes the
 * drawer, it degrades to the `none` placeholder. The prototype's single fixture
 * `toolSummary` string is replaced by a derived summary PLUS the real structured
 * input.
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
 * Security (hard gate): this renders untrusted tool input and model/tool output.
 * Everything is a text node — `JSON.stringify` for the structured input, plain
 * strings for output/diff, and the search paints matched runs by SPLITTING the
 * line into text segments, never by building markup. NEVER
 * `dangerouslySetInnerHTML`, never `eval`, never a live control (the prototype's
 * "Open diff in IDE" affordance has no real verb and is dropped — flagged in the
 * report).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ToolUseRow,
} from './transcriptProjector.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import {
  describeOutputSearch,
  splitLineByQuery,
  stepMatchIndex,
} from './outputSearchModel.js'
import { useToast } from './toastContext.js'
import { toneClasses } from './tone.js'

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

        {model.output ? <OutputPanel text={model.output} /> : null}
      </div>
    </div>
  )
}

/** Off is the prototype's default: long lines scroll rather than reflow. */
const WRAP_BUTTON_CLASS = {
  on: 'border-accent/40 text-accent-soft',
  off: 'border-shell-seam text-text-muted hover:text-text-primary',
} as const

/** Literal classes only — an interpolated arbitrary value never reaches the JIT. */
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
 */
function OutputPanel({ text }: { text: string }) {
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)
  const search = describeOutputSearch(text, query, matchIndex)
  const matchCount = search.matches.length

  // Park the active match in the vertical middle of the scroller, like the
  // prototype (Messages.jsx:279-284). Scrolling the drawer's own box never
  // perturbs the transcript scroller behind it (App owns that one).
  useEffect(() => {
    const line = activeRef.current
    const box = scrollRef.current
    if (!line || !box) return
    box.scrollTop = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2
  }, [search.activeLine])

  const step = (delta: number): void => {
    setMatchIndex(index => stepMatchIndex(index, delta, matchCount))
  }

  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(text)
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
      <div
        ref={scrollRef}
        className="relative max-h-96 overflow-auto rounded-lg border border-shell-seam bg-black/40 py-2 font-mono text-[11.5px] leading-relaxed text-text-muted"
      >
        <div className={wrap ? 'min-w-full' : 'min-w-max'}>
          {search.lines.map((line, index) => {
            const lineNumber = index + 1
            const active = search.activeLine === lineNumber
            return (
              <div
                key={index}
                ref={active ? activeRef : undefined}
                className={`flex ${active ? 'bg-accent/15' : ''}`}
              >
                <span className="sticky left-0 w-[42px] shrink-0 select-none bg-app-bg pr-2.5 text-right text-text-ghost [font-variant-numeric:tabular-nums]">
                  {lineNumber}
                </span>
                <span
                  className={`flex-1 pl-3 pr-4 ${
                    wrap ? LINE_TEXT_CLASS.wrap : LINE_TEXT_CLASS.nowrap
                  }`}
                >
                  {splitLineByQuery(line, query).map((segment, segmentIndex) =>
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
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {search.hiddenLines > 0 ? (
        <div className="mt-1 font-mono text-[10px] text-text-subtle/70">
          {search.hiddenLines} more lines. Copy writes the full output.
        </div>
      ) : null}
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

/** Stringify tolerantly — a cyclic/exotic input degrades to a note, never throws. */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return json ?? String(value)
  } catch {
    return '[uninspectable input]'
  }
}
