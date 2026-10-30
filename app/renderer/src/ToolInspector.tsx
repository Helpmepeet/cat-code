/**
 * The full-output panel: a tool call's complete output, docked beside the
 * transcript in `SubagentWorkspace`'s right-hand slot.
 *
 * WHY DOCKED (operator, 2026-10-21). This used to be a 420px modal drawer over a
 * dimmed, blurred transcript, with its output in a 384px box inside a scroller
 * of its own, so most of a tall window was spent on nothing and the card it
 * came from could not be looked at while it was open. It now takes the slot the
 * worker panel already uses: the transcript stays readable and clickable, a
 * second `Open full output` swaps what the panel shows, and the body is the
 * panel's whole remaining height. The width is the operator's to drag and is
 * remembered (`toolOutputPanel.ts`).
 *
 * WHY IT IS OUTPUT AND DIFF ONLY (2026-08-13,
 * `docs/reports/2026-08-12-tool-inspector-ux-review.md`). The Tool / Summary /
 * Status / raw-Input stack that used to lead it restated the expanded card. The
 * header carries the row's identity in the card's own grammar (mark, word,
 * target), and the bodies are what the reveal band promised: the complete
 * output, searchable and copyable. A call that carries both changes and a text
 * result shows them as two tabs, each with its own search, rather than as two
 * stacked toolbars.
 *
 * COLOUR AND SEARCH. A file read, a written file and a diff paint in the code
 * theme while the search field is empty. A query switches every row to plain
 * text with its matches marked, because the highlighter's spans and the match
 * segments cannot both own one line's text.
 *
 * Security (hard gate): this renders untrusted tool input and model/tool output.
 * Everything is a text node or a highlighter-built element tree (`sourceHighlight.ts`),
 * and search paints matched runs by SPLITTING the line into text segments, never
 * by building markup. NEVER `dangerouslySetInnerHTML`, never `eval`.
 */

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  NestedToolUseRow,
  ToolDiffProjection,
} from './transcriptProjector.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import {
  selectDiffRows,
  selectRawDiffLines,
  selectRowWordSegments,
  type DiffRow,
} from './diffRowModel.js'
import { highlightedWordSegments } from './diffHighlight.js'
import { FileDiffNavigator } from './FileDiffNavigator.js'
import {
  describeOutputSearch,
  selectOutputLineChunk,
  stepMatchIndex,
} from './outputSearchModel.js'
import { parseReadSource, readSourceLanguage } from './readSource.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import {
  ActionCheckIcon,
  ActionChevronIcon,
  ActionCloseIcon,
  ActionCopyIcon,
} from './SessionActionIcons.js'
import {
  DIFF_ROW_CLASS,
  DIFF_SIGN_CLASS,
  FAMILY_STYLE,
  WORD_DIM_CLASS,
  WORD_EMPH_CLASS,
} from './toolCardPalette.js'
import {
  TOOL_OUTPUT_DEFAULT_WIDTH,
  TOOL_OUTPUT_MIN_WIDTH,
  TOOL_OUTPUT_WIDTH_STEP,
  clampToolOutputWidth,
  readToolOutputWidth,
  writeToolOutputWidth,
} from './toolOutputPanel.js'
import { useToast } from './toastContext.js'
import { VirtualLineList } from './VirtualLineList.js'
import './toolOutputPanel.css'

type OutputView = 'changes' | 'result'

const VIEW_LABEL: Record<OutputView, string> = {
  changes: 'Changes',
  result: 'Result',
}

export function ToolInspector({
  row,
  cwd = null,
  initialFileIndex = 0,
  embedded = false,
  back = null,
  onClose,
}: {
  row: NestedToolUseRow | null
  cwd?: string | null
  initialFileIndex?: number
  embedded?: boolean
  /** The worker panel this one replaced, which Back and Escape return to. */
  back?: { label: string; onBack: () => void } | null
  onClose?: () => void
}): ReactNode {
  if (!row) return null
  return (
    <OutputPanel
      row={row}
      cwd={cwd}
      initialFileIndex={initialFileIndex}
      embedded={embedded}
      back={back}
      onClose={onClose}
    />
  )
}

/** Hooks live here, under the null-row guard above, never beside it. */
function OutputPanel({
  row,
  cwd,
  initialFileIndex,
  embedded,
  back,
  onClose,
}: {
  row: NestedToolUseRow
  cwd: string | null
  initialFileIndex: number
  embedded: boolean
  back: { label: string; onBack: () => void } | null
  onClose?: () => void
}) {
  const model = useMemo(() => describeToolForInspector(row, cwd), [row, cwd])
  const views: OutputView[] = []
  if (model.diffs.length > 0) views.push('changes')
  if (model.output !== null) views.push('result')
  const [picked, setPicked] = useState<OutputView | null>(null)
  const view = picked !== null && views.includes(picked) ? picked : views[0] ?? null
  const [wrap, setWrap] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const text = useMemo(
    () => model.output === null ? null : selectTextSource(model.output, model.numberedRead),
    [model.output, model.numberedRead],
  )
  const changes = useMemo(() => countChanges(model.diffs), [model.diffs])

  // Into the body on open, so the keyboard scrolls and searches it at once.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const target = panel?.querySelector<HTMLElement>('[role="region"]') ??
      panel?.querySelector<HTMLElement>('.tool-output-close')
    target?.focus({ preventScroll: true })
  }, [])

  const dismiss = back?.onBack ?? onClose
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      const search = panelRef.current?.querySelector<HTMLInputElement>('input[data-output-search]')
      if (!search) return
      event.preventDefault()
      search.focus()
      search.select()
      return
    }
    if (event.key === 'Escape' && dismiss) {
      // Claimed so the session's own Escape listeners (a permission card's
      // deny) do not also act on it.
      event.preventDefault()
      dismiss()
    }
  }

  const base = FAMILY_STYLE[model.family]
  const mark = model.presentation?.mark ?? base.mark
  const word = model.presentation?.word ?? base.word

  return (
    <aside
      ref={panelRef}
      className="tool-output-panel"
      aria-label="Full output"
      onKeyDown={onKeyDown}
    >
      {embedded ? null : <ResizeHandle />}
      <header className="tool-output-header">
        <div className="tool-output-identity">
          {back ? (
            <button
              type="button"
              className="tool-output-back"
              aria-label={`Back to ${back.label}`}
              onClick={back.onBack}
            >
              <ActionChevronIcon />
              <span>{back.label}</span>
            </button>
          ) : null}
          <div className="tool-output-line">
            <span className={`tool-output-mark ${base.color}`} aria-hidden>{mark}</span>
            <span className={`tool-output-word ${base.color}`}>{word}</span>
            <span className="tool-output-target" title={model.target}>{model.target}</span>
          </div>
          <OutputFacts
            view={view}
            failed={model.failed}
            text={text}
            changes={changes}
            files={model.diffs.length}
          />
        </div>
        {onClose ? (
          <button
            type="button"
            className="tool-output-close"
            aria-label="Close full output"
            onClick={onClose}
          >
            <ActionCloseIcon />
          </button>
        ) : null}
      </header>

      {views.length > 1 ? (
        <div className="tool-output-tabs" role="tablist" aria-label="Output views">
          {views.map(option => (
            <button
              key={option}
              type="button"
              role="tab"
              className="tool-output-tab"
              aria-selected={option === view}
              tabIndex={option === view ? 0 : -1}
              onClick={() => setPicked(option)}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const next = views[(views.indexOf(option) + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length]
                setPicked(next)
                const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                tabs?.[views.indexOf(next)]?.focus()
              }}
            >
              {VIEW_LABEL[option]}
            </button>
          ))}
        </div>
      ) : null}

      {view === 'changes' ? (
        <div className="tool-output-view">
          <FileDiffNavigator
            diffs={model.diffs}
            initialFileIndex={initialFileIndex}
            showPath={model.diffs.length > 1}
            barClassName="tool-output-files"
            bodyClassName="tool-output-view"
            renderDiff={diff => <DiffBody diff={diff} wrap={wrap} onWrap={setWrap} />}
          />
        </div>
      ) : view === 'result' && text !== null ? (
        <OutputBody
          key={`result:${row.id}`}
          lines={text.lines}
          body={text.body}
          copy={text.body}
          gutter={index => text.numbers?.[index] ?? index + 1}
          language={model.outputLanguage}
          diffRows={null}
          wrap={wrap}
          onWrap={setWrap}
        />
      ) : (
        <p className="tool-output-empty">No output.</p>
      )}
    </aside>
  )
}

type TextSource = {
  /** One entry per painted row: the engine's read prefix is already removed. */
  lines: readonly string[]
  /** What search runs over and copy hands over. */
  body: string
  /** The file's own line numbers for a numbered read, else null. */
  numbers: readonly number[] | null
}

/**
 * A file READ arrives already numbered (`readSource.ts`), so the engine's `N\t`
 * prefix is parsed off here for the same three reasons it is on the card. The
 * gutter can then show the file's real lines rather than a count that restarts
 * at 1 on an offset read; a search for `1` no longer matches every line's
 * number; and copy hands over the file rather than the file plus a column of
 * digits. Other tools keep their output byte for byte, even when it resembles a
 * numbered file read.
 */
function selectTextSource(output: string, numberedRead: boolean): TextSource {
  const parsed = numberedRead ? parseReadSource(output) : null
  if (parsed === null || parsed.numbers === null) {
    return { lines: output.split('\n'), body: output, numbers: null }
  }
  return { lines: parsed.lines, body: parsed.lines.join('\n'), numbers: parsed.numbers }
}

function countChanges(diffs: readonly ToolDiffProjection[]): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) adds++
        else if (line.startsWith('-')) dels++
      }
    }
  }
  return { adds, dels }
}

/** The size of what is showing: how much there is to read, and how much changed. */
function OutputFacts({
  view,
  failed,
  text,
  changes,
  files,
}: {
  view: OutputView | null
  failed: boolean
  text: TextSource | null
  changes: { adds: number; dels: number }
  files: number
}) {
  const facts: ReactNode[] = []
  if (failed) facts.push(<span key="failed" className="text-tone-danger">Failed</span>)
  if (view === 'changes') {
    if (changes.adds > 0) facts.push(<span key="adds" className="text-[light-dark(#15803d,#86efac)]">+{formatCount(changes.adds)}</span>)
    if (changes.dels > 0) facts.push(<span key="dels" className="text-[light-dark(#dc2626,#fca5a5)]">−{formatCount(changes.dels)}</span>)
    if (files > 1) facts.push(<span key="files">{formatCount(files)} files</span>)
  } else if (view === 'result' && text !== null) {
    const first = text.numbers?.[0]
    const last = text.numbers?.[text.numbers.length - 1]
    facts.push(
      <span key="lines">
        {first !== undefined && last !== undefined && first !== 1
          ? `Lines ${formatCount(first)}–${formatCount(last)}`
          : `${formatCount(text.lines.length)} ${text.lines.length === 1 ? 'line' : 'lines'}`}
      </span>,
    )
  }
  if (facts.length === 0) return null
  return <div className="tool-output-facts">{facts}</div>
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * One file's patch as a body. Windowed for the same reason the card's diff is
 * (CC-62): nothing upstream caps a patch, so a whole-file write reaches here as
 * thousands of lines. Search runs over the line bodies without their signs, and
 * copy hands over the patch itself, signs included.
 */
function DiffBody({
  diff,
  wrap,
  onWrap,
}: {
  diff: ToolDiffProjection
  wrap: boolean
  onWrap: (wrap: boolean) => void
}) {
  const rows = useMemo(() => selectDiffRows(diff), [diff])
  // A context row keeps the patch's leading space (`selectDiffRows`). This body
  // draws every sign in its own column, so that space would set each unchanged
  // line one character right of the changed lines around it.
  const lines = useMemo(
    () => rows.map(row => row.kind === 'ctx' && row.body.startsWith(' ') ? row.body.slice(1) : row.body),
    [rows],
  )
  const body = useMemo(() => lines.join('\n'), [lines])
  const copy = useMemo(() => selectRawDiffLines(diff).join('\n'), [diff])
  if (rows.length === 0) return <p className="tool-output-empty">No diff lines.</p>
  return (
    <OutputBody
      lines={lines}
      body={body}
      copy={copy}
      gutter={index => rows[index]?.currentLabel ?? ''}
      language={readSourceLanguage(diff.filePath)}
      diffRows={rows}
      wrap={wrap}
      onWrap={onWrap}
    />
  )
}

/**
 * Literal classes only, and on the SCROLL BOX rather than on each row:
 * `VirtualLineList` folds its container's class list into the layout revision
 * that qualifies every measured row height, and a wrap toggle changes every one
 * of those heights without changing a character of text. Toggling Wrap
 * therefore invalidates the measurements taken under the old mode instead of
 * leaving stale ones behind rows that no longer match them.
 */
const LINE_TEXT_CLASS = {
  wrap: 'tool-output-scroller is-wrapped',
  nowrap: 'tool-output-scroller',
} as const

const MATCH_CLASS = 'rounded-sm bg-tone-warn/25 px-px text-[light-dark(#834a00,#fde68a)]'

/**
 * The toolbar and the body it acts on. Search state belongs to one body, so a
 * different file or view starts a fresh search.
 */
function OutputBody({
  lines,
  body,
  copy,
  gutter,
  language,
  diffRows,
  wrap,
  onWrap,
}: {
  lines: readonly string[]
  body: string
  copy: string
  gutter: (index: number) => ReactNode
  language: string | null
  diffRows: readonly DiffRow[] | null
  wrap: boolean
  onWrap: (wrap: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const search = useMemo(
    () => describeOutputSearch(body, query, matchIndex),
    [body, query, matchIndex],
  )
  // Memoized apart from the search, which re-runs on every keystroke while
  // this depends only on the body. Null past the highlighter's ceilings, and
  // for text that is not a file's source.
  const coloured = useMemo(
    () => selectHighlightedSourceRows(lines, language),
    [lines, language],
  )
  const matchCount = search.matchCount
  const step = (delta: number): void => {
    setMatchIndex(index => stepMatchIndex(index, delta, matchCount))
  }

  const copyOutput = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(copy)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
        toast('Copied output', { tone: 'success' })
      })
      .catch(() => {})
  }

  return (
    <>
      <div className="tool-output-toolbar">
        <label className="tool-output-search">
          <SearchIcon />
          <input
            type="text"
            data-output-search=""
            aria-label="Search output"
            placeholder="Search"
            value={query}
            spellCheck={false}
            onChange={event => {
              setQuery(event.target.value)
              setMatchIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && matchCount > 0) {
                event.preventDefault()
                step(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape' && query.length > 0) {
                // The first Escape clears the search; the next one closes.
                event.preventDefault()
                setQuery('')
                setMatchIndex(0)
              }
            }}
          />
          {search.searching ? (
            <>
              <span className="tool-output-count">{search.label}</span>
              <button
                type="button"
                className="tool-output-step"
                onClick={() => step(-1)}
                disabled={matchCount === 0}
                aria-label="Previous match"
              >
                <ChevronGlyph direction="up" />
              </button>
              <button
                type="button"
                className="tool-output-step"
                onClick={() => step(1)}
                disabled={matchCount === 0}
                aria-label="Next match"
              >
                <ChevronGlyph direction="down" />
              </button>
            </>
          ) : null}
        </label>
        <button
          type="button"
          className="tool-output-tool"
          onClick={() => onWrap(!wrap)}
          aria-pressed={wrap}
        >
          Wrap
        </button>
        <button
          type="button"
          className="tool-output-tool"
          data-copied={copied ? '' : undefined}
          onClick={copyOutput}
          aria-label={copied ? 'Output copied' : 'Copy output'}
        >
          {copied ? <ActionCheckIcon /> : <ActionCopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <VirtualLineList
        lines={search.lines}
        activeIndex={search.activeLine === null ? null : search.activeLine - 1}
        className={wrap ? LINE_TEXT_CLASS.wrap : LINE_TEXT_CLASS.nowrap}
        label="Output"
        renderLine={(bounded, index) => {
          const position = index + 1
          const active = search.activeLine === position
          const diffRow = diffRows?.[index]
          let content: ReactNode
          let themed = diffRow !== undefined
          if (search.searching) {
            // The list hands over a chunk cut from the start of the line. This
            // body holds the full line, so it re-cuts around the active match
            // instead: a match a megabyte into one logical line has to be
            // reachable, and only the search model knows where it is.
            const chunk = selectOutputLineChunk(search.lines[index] ?? '', query, {
              anchorOffset: active ? search.activeOffset ?? undefined : undefined,
            })
            content = (
              <>
                {chunk.truncatedStart ? '…' : null}
                {chunk.segments.map((segment, segmentIndex) =>
                  segment.match ? (
                    <mark key={segmentIndex} className={MATCH_CLASS}>{segment.text}</mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
                {chunk.truncatedEnd ? '…' : null}
              </>
            )
          } else {
            const colour = coloured?.[index]
            themed = themed || colour !== undefined
            content = colour ?? bounded
            const segments = diffRows === null ? null : selectRowWordSegments(diffRows, index)
            if (diffRow !== undefined && segments !== null) {
              const side = diffRow.kind === 'del' ? 'del' : 'add'
              content = highlightedWordSegments([content], segments, WORD_EMPH_CLASS[side], WORD_DIM_CLASS[side])
            }
          }
          return (
            <div
              className={`tool-output-row${diffRow ? ` ${DIFF_ROW_CLASS[diffRow.kind]}` : ''}${active ? ' is-active' : ''}`}
            >
              <span className="tool-output-gutter">{gutter(index)}</span>
              {diffRow ? (
                <span className={`tool-output-sign ${DIFF_SIGN_CLASS[diffRow.kind]}`}>
                  {diffRow.kind === 'add' ? '+' : diffRow.kind === 'del' ? '−' : ' '}
                </span>
              ) : null}
              <span className={themed ? 'tool-output-code hljs' : 'tool-output-code'}>{content}</span>
            </div>
          )
        }}
      />
    </>
  )
}

/**
 * The panel's left edge. Dragging or arrowing it sets the panel's width as a
 * CSS variable (never an inline style prop), and the stylesheet's `max-width`
 * keeps whatever is stored from crowding the transcript in a smaller window.
 * Double-click restores the default.
 */
function ResizeHandle() {
  // The panel is this element's parent, read through the handle's own ref: a
  // parent's ref is attached only after its children's layout effects run.
  const handleRef = useRef<HTMLDivElement | null>(null)
  const panel = (): HTMLElement | null => handleRef.current?.parentElement ?? null
  const [width, setWidth] = useState(readToolOutputWidth)
  const widthRef = useRef(width)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    widthRef.current = width
    panel()?.style.setProperty('--tool-output-width', `${width}px`)
  }, [width])

  // Zero is an unmeasured layout, not a window too narrow for any panel.
  const layoutWidth = (): number | null =>
    panel()?.parentElement?.clientWidth || null
  const commit = (next: number): void => {
    const clamped = clampToolOutputWidth(next, layoutWidth())
    setWidth(clamped)
    writeToolOutputWidth(clamped)
  }

  return (
    <div
      ref={handleRef}
      className="tool-output-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize output panel"
      aria-valuenow={width}
      aria-valuemin={TOOL_OUTPUT_MIN_WIDTH}
      tabIndex={0}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          startX: event.clientX,
          startWidth: panel()?.getBoundingClientRect().width || widthRef.current,
        }
        setDragging(true)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (start === null) return
        // The handle is on the LEFT edge, so moving left widens the panel.
        setWidth(clampToolOutputWidth(start.startWidth + start.startX - event.clientX, layoutWidth()))
      }}
      onPointerUp={() => {
        if (drag.current === null) return
        drag.current = null
        setDragging(false)
        writeToolOutputWidth(widthRef.current)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={() => commit(TOOL_OUTPUT_DEFAULT_WIDTH)}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') commit(widthRef.current + TOOL_OUTPUT_WIDTH_STEP)
        else if (event.key === 'ArrowRight') commit(widthRef.current - TOOL_OUTPUT_WIDTH_STEP)
        else return
        event.preventDefault()
      }}
    />
  )
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7.5" />
      <line x1="20.5" y1="20.5" x2="16.4" y2="16.4" />
    </svg>
  )
}

function ChevronGlyph({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points={direction === 'up' ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
    </svg>
  )
}
