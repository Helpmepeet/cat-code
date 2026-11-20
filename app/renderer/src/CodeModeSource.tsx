import { useMemo } from 'react'
import { VirtualLineList } from './VirtualLineList.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import { selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import type { CodeModeCall } from './codeMode.js'

/**
 * The Script's source, folded inside its card beside Output. It replaced a
 * side pane (2026-11-21) whose tabs, search and copy toolbar repeated what the
 * card already shows; the source was the only thing the card lacked.
 *
 * A line number is a button that selects the line, which also highlights the
 * card's step for that line. Lines that ran calls take the Script ink, and the
 * line a failure was attributed to turns red.
 */
export function CodeModeSource({ sessionId, cellId, code, calls, errorLine, open, onOpenChange }: {
  sessionId: string
  cellId: string
  code: string
  calls: readonly CodeModeCall[]
  errorLine: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const lines = useMemo(() => code.split('\n'), [code])
  return <div className="code-mode-script">
    <button type="button" className="code-mode-fold-head" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span className={`code-mode-caret${open ? ' is-open' : ''}`} aria-hidden>▸</span><span className="code-mode-output-mark" aria-hidden>{'{}'}</span> Source <span className="code-mode-output-count">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
    </button>
    {open ? <SourceBody sessionId={sessionId} cellId={cellId} lines={lines} calls={calls} errorLine={errorLine} /> : null}
  </div>
}

function SourceBody({ sessionId, cellId, lines, calls, errorLine }: { sessionId: string; cellId: string; lines: readonly string[]; calls: readonly CodeModeCall[]; errorLine: number | null }) {
  const selection = useCodeModeSelection(sessionId, cellId)
  const coloured = useMemo(() => selectHighlightedSourceRows(lines, 'javascript'), [lines])
  const callsByLine = useMemo(() => {
    const result = new Map<number, { count: number; failed: boolean; running: boolean }>()
    for (const call of calls) if (call.line) {
      const previous = result.get(call.line)
      result.set(call.line, { count: (previous?.count ?? 0) + 1, failed: !!previous?.failed || !!call.error || ['failed', 'blocked', 'cancelled'].includes(call.status), running: !!previous?.running || call.status === 'running' })
    }
    return result
  }, [calls])
  return <VirtualLineList lines={lines} className="code-mode-script-body" activeIndex={selection ? selection.line - 1 : null} activeRequest={selection?.token} renderLine={(line, index) => {
    const position = index + 1
    const state = callsByLine.get(position)
    const failed = !!state?.failed || errorLine === position
    return <div className={`code-mode-script-row${selection?.line === position ? ' is-active' : ''}`}>
      <button type="button" className={`code-mode-script-gutter${failed ? ' is-failed' : state ? ' is-executed' : ''}`}
        title={state ? `${state.count} ${state.count === 1 ? 'call' : 'calls'}${state.failed ? ', failed' : state.running ? ', running' : ''}` : undefined}
        aria-label={`Select line ${position}${state ? ', executed' : ''}`} aria-pressed={selection?.line === position}
        onClick={() => selectCodeModeLine(sessionId, cellId, position)}>{position}</button>
      <span className={coloured ? 'code-mode-script-code hljs' : 'code-mode-script-code'}>{coloured?.[index] ?? line}</span>
    </div>
  }} />
}
