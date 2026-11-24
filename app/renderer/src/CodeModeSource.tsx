import { memo, useMemo, useRef, useState } from 'react'
import { VirtualLineList } from './VirtualLineList.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import { selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { codeModeSourceFolds, codeModeSourceRows } from './codeModeSourceFolds.js'
import type { CodeModeCall } from './codeMode.js'

/**
 * A line number is a button that selects the line, which also highlights the
 * card's step for that line. Lines that ran calls take the Script ink, and the
 * line a failure was attributed to turns red.
 */
export const CodeModeSource = memo(function CodeModeSource({ sessionId, cellId, lines, calls, errorLine }: {
  sessionId: string
  cellId: string
  lines: readonly string[]
  calls: readonly CodeModeCall[]
  errorLine: number | null
}) {
  const selection = useCodeModeSelection(sessionId, cellId)
  const scroller = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())
  const [reveal, setReveal] = useState<{ line: number; selectionToken?: number } | null>(null)
  const folds = useMemo(() => codeModeSourceFolds(lines), [lines])
  const selectedFold = selection ? folds.find(({ from, to }) => selection.line > from + 1 && selection.line <= to) : undefined
  const rows = useMemo(() => codeModeSourceRows(lines, folds, revealed, selectedFold), [lines, folds, revealed, selectedFold])
  const displayLines = useMemo(() => folds.length ? rows.map(row => row.text) : lines, [folds, rows, lines])
  const coloured = useMemo(() => selectHighlightedSourceRows(displayLines, 'javascript'), [displayLines])
  const callsByRow = useMemo(() => {
    const result = new Map<number, { count: number; failed: boolean; running: boolean; line: number }>()
    for (const call of calls) if (call.line) {
      const index = indexForLine(rows, call.line)
      if (index === null) continue
      const previous = result.get(index)
      const failed = !!call.error || ['failed', 'blocked', 'cancelled'].includes(call.status)
      result.set(index, { count: (previous?.count ?? 0) + 1, failed: !!previous?.failed || failed,
        running: !!previous?.running || call.status === 'running', line: failed ? call.line : previous?.line ?? call.line })
    }
    return result
  }, [calls, rows])
  const selectedRow = selection ? indexForLine(rows, selection.line) : null
  const openingFold = reveal && reveal.selectionToken === selection?.token ? reveal : null
  const scrollTo = openingFold ? indexForLine(rows, openingFold.line) : selectedRow
  return <VirtualLineList lines={displayLines} scrollerRef={scroller} label="Source"
    className={`code-mode-script-body${folds.length ? ' code-mode-source-with-folds' : ''}`}
    activeIndex={scrollTo} activeRequest={openingFold ? -openingFold.line : selection?.token}
    align={openingFold ? 'start' : 'center'} widthAffectsRowHeight={false} renderLine={(line, index) => {
    const row = rows[index]!
    const from = row.from + 1, to = row.to + 1
    const state = callsByRow.get(index)
    const hasError = errorLine !== null && errorLine >= from && errorLine <= to
    const failed = !!state?.failed || hasError
    const active = selectedRow === index
    const position = active ? selection!.line : hasError ? errorLine : state?.line ?? from
    return <div className={`code-mode-script-row${active ? ' is-active' : ''}`}>
      <button type="button" className={`code-mode-script-gutter${failed ? ' is-failed' : state ? ' is-executed' : ''}`}
        title={state ? `${state.count} ${state.count === 1 ? 'call' : 'calls'}${state.failed ? ', failed' : state.running ? ', running' : ''}` : undefined}
        aria-label={`Select line ${position}${state ? ', executed' : ''}`} aria-pressed={active}
        onClick={() => selectCodeModeLine(sessionId, cellId, position)}>{from === to ? from : `${from}–${to}`}</button>
      <span className={coloured ? 'code-mode-script-code hljs' : 'code-mode-script-code'}>{coloured?.[index] ?? line}
        {row.folds.map(fold => <button key={fold.from} type="button" className="code-mode-script-fold"
          aria-label={`Show ${fold.to - fold.from - 1} lines of text starting on line ${fold.from + 1}`} onClick={() => {
            scroller.current?.focus({ preventScroll: true })
            setRevealed(open => new Set(open).add(fold.from))
            setReveal({ line: fold.from + 1, selectionToken: selection?.token })
          }}>{fold.to - fold.from - 1} lines</button>)}
      </span>
    </div>
  }} />
})

function indexForLine(rows: ReturnType<typeof codeModeSourceRows>, line: number): number | null {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.to < line - 1) low = middle + 1
    else high = middle
  }
  return low < rows.length ? low : null
}
