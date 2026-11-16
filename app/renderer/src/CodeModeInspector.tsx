import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { SourceTextView } from './SourceTextView.js'
import { useSourceWrap } from './sourceWrap.js'
import './codeMode.css'
import { selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { SidePaneNavigation } from './SidePaneNavigation.js'
import { ActionCloseIcon } from './SessionActionIcons.js'
import { codeModeLiveView } from './codeModeLiveView.js'
import { deriveToolFamily } from './transcriptProjector.js'
import { FAMILY_STYLE } from './toolCardPalette.js'

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
  const codeLineCount = useMemo(() => code ? code.split('\n').length : 0, [code])
  const body = tab === 'script' ? code : cell?.output ?? row.result?.content ?? ''
  const lines = useMemo(() => body.split('\n'), [body])
  const callsByLine = useMemo(() => {
    const result = new Map<number, { count: number; failed: boolean; running: boolean; name: string }>()
    for (const call of cell?.calls ?? []) if (call.line) {
      const previous = result.get(call.line)
      result.set(call.line, { count: (previous?.count ?? 0) + 1, failed: !!previous?.failed || !!call.error || ['failed', 'blocked', 'cancelled'].includes(call.status), running: !!previous?.running || call.status === 'running', name: previous?.name ?? call.name })
    }
    return result
  }, [cell])
  return <aside ref={root} className="tool-output-panel code-mode-panel" aria-label="Script inspector" onKeyDown={event => {
    if (!event.defaultPrevented && event.key === 'Escape' && onClose) { event.preventDefault(); onClose() }
  }}>
    <header className="tool-output-header"><SidePaneNavigation /><div className="code-mode-panel-identity"><div className="code-mode-panel-title"><span className="code-mode-mark" aria-hidden>{'{}'}</span><strong className="code-mode-word">SCRIPT</strong><span className="tool-output-target">{cell?.description ?? (typeof row.input.description === 'string' ? row.input.description : '')}</span></div><div className="code-mode-panel-facts">{tab === 'script' ? <><span>{codeLineCount} lines</span>{cell ? <span>{cell.calls.length} {cell.calls.length === 1 ? 'call' : 'calls'}</span> : null}</> : <span>{body ? `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` : 'empty'}</span>}</div></div>{onClose ? <button className="tool-output-close" onClick={onClose} aria-label="Close script inspector"><ActionCloseIcon /></button> : null}</header>
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
        const family = state ? FAMILY_STYLE[deriveToolFamily(state.name)] : null
        return <button className={state?.failed || cell?.line === index + 1 && cell.error ? 'code-mode-source-line-error' : undefined} title={state ? `${state.count} calls${state.failed ? ', failed' : state.running ? ', running' : ''}` : undefined} aria-label={`Select line ${index + 1}${state ? ', executed' : ''}`} aria-pressed={selection?.line === index + 1} onClick={() => selectCodeModeLine(row.sessionId, row.toolUseId, index + 1)}>{index + 1}{family ? <span className={`code-mode-gutter-mark ${family.color}`} aria-hidden> {family.mark}{state!.count > 1 ? `×${state!.count}` : ''}</span> : null}</button>
      }} />
  </aside>
}
