import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { SourceTextView } from './SourceTextView.js'
import { useSourceWrap } from './sourceWrap.js'
import './codeMode.css'
import { selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { SidePaneNavigation } from './SidePaneNavigation.js'
import { ActionCloseIcon } from './SessionActionIcons.js'
import { codeModeLiveView } from './codeModeLiveView.js'

/** Uses the same bounded, searchable source renderer as file and tool output. */
export function CodeModeInspector({ row, onClose }: { row: NestedToolUseRow; onClose?: () => void }) {
  const cell = codeModeLiveView(row)
  const [tab, setTab] = useState('script')
  const selection = useCodeModeSelection(row.sessionId, row.toolUseId)
  useLayoutEffect(() => { if (selection?.revealToken) setTab('script') }, [selection?.revealToken])
  const root = useRef<HTMLElement>(null)
  useLayoutEffect(() => { root.current?.querySelector<HTMLElement>('[role="region"]')?.focus({ preventScroll: true }) }, [])
  const [wrap, setWrap] = useSourceWrap()
  const code = cell?.code ?? (typeof row.input.code === 'string' ? row.input.code : '')
  const body = tab === 'script' ? code : cell?.output ?? row.result?.content ?? ''
  const lines = useMemo(() => body.split('\n'), [body])
  const callsByLine = useMemo(() => {
    const result = new Map<number, { count: number; failed: boolean; running: boolean }>()
    for (const call of cell?.calls ?? []) if (call.line) {
      const previous = result.get(call.line)
      result.set(call.line, { count: (previous?.count ?? 0) + 1, failed: !!previous?.failed || !!call.error || ['failed', 'blocked', 'cancelled'].includes(call.status), running: !!previous?.running || call.status === 'running' })
    }
    return result
  }, [cell])
  return <aside ref={root} className="tool-output-panel code-mode-panel" aria-label="Script inspector" onKeyDown={event => {
    if (!event.defaultPrevented && event.key === 'Escape' && onClose) { event.preventDefault(); onClose() }
  }}>
    <header className="tool-output-header"><SidePaneNavigation /><strong className="code-mode-word">SCRIPT</strong><span className="tool-output-target">{cell?.description ?? (typeof row.input.description === 'string' ? row.input.description : '')}</span>{onClose ? <button className="tool-output-close" onClick={onClose} aria-label="Close script inspector"><ActionCloseIcon /></button> : null}</header>
    <div role="tablist" aria-label="Script views" className="code-mode-tabs" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const next = tab === 'script' ? 'output' : 'script'
        setTab(next)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next === 'script' ? 0 : 1]?.focus()
      }
    }}>
      <button role="tab" tabIndex={tab === 'script' ? 0 : -1} aria-selected={tab === 'script'} onClick={() => setTab('script')}>Script</button>
      <button role="tab" tabIndex={tab === 'output' ? 0 : -1} aria-selected={tab === 'output'} onClick={() => setTab('output')}>Output</button>
    </div>
    {cell?.error ? <pre className="code-mode-error">{cell.line ? `Line ${cell.line}: ` : ''}{cell.error}</pre> : null}
    <SourceTextView key={`${row.toolUseId}:${tab}`} lines={lines} body={body} copy={body} language={tab === 'script' ? 'javascript' : /^\s*(?:\{|\[)/.test(body) ? 'json' : null} diffRows={null} wrap={wrap} onWrap={setWrap}
      lineTarget={tab === 'script' ? selection : undefined}
      gutter={index => {
        if (tab !== 'script') return index + 1
        const state = callsByLine.get(index + 1)
        return <button className={state?.failed || cell?.line === index + 1 && cell.error ? 'code-mode-source-line-error' : undefined} title={state ? `${state.count} calls${state.failed ? ', failed' : state.running ? ', running' : ''}` : undefined} aria-label={`Select line ${index + 1}${state ? ', executed' : ''}`} aria-pressed={selection?.line === index + 1} onClick={() => selectCodeModeLine(row.sessionId, row.toolUseId, index + 1)}>{index + 1}{state ? state.count > 1 ? ` ×${state.count}` : ' ·' : ''}</button>
      }} />
  </aside>
}
