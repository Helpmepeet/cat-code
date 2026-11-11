import { SidePaneNavigation } from './SidePaneNavigation.js'

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
} from './diffRowModel.js'
import { FileDiffNavigator } from './FileDiffNavigator.js'
import { parseReadSource, readSourceLanguage } from './readSource.js'
import {
  ActionChevronIcon,
  ActionCloseIcon,
} from './SessionActionIcons.js'
import {
  FAMILY_STYLE,
} from './toolCardPalette.js'
import {
  TOOL_OUTPUT_DEFAULT_WIDTH,
  TOOL_OUTPUT_MIN_WIDTH,
  TOOL_OUTPUT_WIDTH_STEP,
  clampToolOutputWidth,
  readToolOutputWidth,
  writeToolOutputWidth,
} from './toolOutputPanel.js'
import { SourceTextView } from './SourceTextView.js'
import { useSourceWrap } from './sourceWrap.js'
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
  const [wrap, setWrap] = useSourceWrap()
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
        <SidePaneNavigation />
        {embedded ? <span className="pane-title" title={model.target}>Full output</span> : <div className="tool-output-identity">
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
        </div>}
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
        <SourceTextView
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
    <SourceTextView
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
