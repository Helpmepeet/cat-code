import { memo, useContext, useMemo, type ReactNode } from 'react'
import { BoundedChildList } from './BoundedChildList.js'
import { ToolOutputContext } from './toolOutputPanel.js'
import { ToolCardStyleContext } from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { codeModeForRow, codeModeDigest, codeModeStepDigest, codeModeSteps, type CodeModeEnvelope } from './codeMode.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { projectCodeModeCall } from './transcriptProjector.js'
import './codeMode.css'
import { selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import { CodeModeOutput } from './CodeModeOutput.js'
import { CodeModePartialChanges } from './CodeModePartialChanges.js'

export const CodeModeCard = memo(function CodeModeCard({ row, renderChild, waitingForApproval = false }: { row: NestedToolUseRow; renderChild: (row: NestedToolUseRow['children'][number]) => ReactNode; waitingForApproval?: boolean }) {
  const cell = useMemo<CodeModeEnvelope | undefined>(() => {
    const audit = codeModeForRow(row)
    if (audit) return audit
    if (row.result) return undefined
    const calls = row.children.flatMap(child => child.kind === 'tool-use' ? [{
      toolUseId: child.toolUseId, name: child.toolName, input: child.input,
      status: child.status, line: child.codeMode?.line,
      ...(child.result?.isError ? { error: child.result.content } : {}),
    }] : [])
    if (!calls.length) return undefined
    return { kind: 'code-mode', cellId: row.toolUseId, generation: '', description: typeof row.input.description === 'string' ? row.input.description : 'Script',
      code: typeof row.input.code === 'string' ? row.input.code : '', status: 'running', output: '', calls, changedFiles: [] }
  }, [row.result, row.children, row.input, row.toolUseId, row.toolName])
  const open = useContext(ToolOutputContext)
  const selection = useCodeModeSelection(row.sessionId, row.toolUseId)
  const style = useContext(ToolCardStyleContext)
  const { expanded: defaults } = useContext(ToolsExpandedContext)
  const hasCallErrors = useMemo(() => cell?.calls.some(call => !!call.error || ['failed', 'error', 'blocked', 'cancelled'].includes(call.status)) ?? false, [cell])
  const [expanded, setPicked] = useToolCardExpanded(row.toolUseId, row.status === 'pending' || row.status === 'error' || hasCallErrors || defaults)
  const steps = useMemo(() => cell ? codeModeSteps(cell) : [], [cell])
  const keys = useMemo(() => steps.map(step => step.key), [steps])
  const selectedStep = useMemo(() => selection ? steps.find(step => step.calls.some(call => call.line === selection.line)) : undefined, [steps, selection])
  const revealRequest = useMemo(() => selectedStep && selection ? { key: selectedStep.key, sequence: selection.token } : null, [selectedStep, selection])
  const extraChildren = useMemo(() => {
    const audited = new Set(cell?.calls.map(call => call.toolUseId))
    return row.children.filter(child => child.kind !== 'tool-use' || !audited.has(child.toolUseId))
  }, [row.children, cell])
  const childKeys = useMemo(() => extraChildren.map(child => child.id), [extraChildren])
  const childrenByCall = useMemo(() => new Map(row.children.flatMap(child => child.kind === 'tool-use' ? [[child.toolUseId, child] as const] : [])), [row.children])
  const description = cell?.description ?? (typeof row.input.description === 'string' ? row.input.description : 'Script')
  const status = cell?.status ?? (row.status === 'cancelled' ? 'cancelled' : row.status === 'error' ? row.autoModeReview?.outcome === 'blocked' ? 'blocked' : 'failed' : row.status === 'success' ? 'completed' : 'running')
  const partial = !!cell?.changedFiles.length && ['failed', 'cancelled', 'blocked', 'yielded'].includes(status)
  const changedKeys = useMemo(() => cell?.changedFiles.map((file, index) => `${index}:${file.path}`) ?? [], [cell])
  return <section className="code-mode" data-card-style={style} aria-label={`Script: ${description}`}>
    <header className="code-mode-header">
      <button className="code-mode-disclosure" aria-expanded={expanded} onClick={() => setPicked(!expanded)}>
        <span className="code-mode-word">SCRIPT</span><span className="code-mode-description">{description}</span>
        {!expanded && cell ? <span className="code-mode-digest">{codeModeDigest(cell)}</span> : null}
        <span className={`code-mode-status code-mode-status-${status}`}>{waitingForApproval ? 'Waiting for approval' : status === 'yielded' ? 'Paused' : status}</span>
      </button>
      {open ? <button className="code-mode-source" onClick={() => open(row)}>Open</button> : null}
    </header>
    {partial && cell ? <CodeModePartialChanges files={cell.changedFiles} /> : null}
    {expanded ? <div className="code-mode-body">
      {cell?.error ? <pre className="code-mode-error">{cell.error}</pre> : null}
      <BoundedChildList keys={keys} estimatedChildHeight={44} revealRequest={revealRequest} renderChild={index => {
        const step = steps[index]!
        const errors = step.calls.filter(call => call.error || ['failed', 'error', 'cancelled', 'blocked'].includes(call.status))
        const issue = errors.length ? errors.every(call => call.status === 'cancelled') ? 'Stopped' : errors.every(call => call.status === 'blocked') ? 'Blocked' : 'Failed' : null
        const selected = step.calls.some(call => call.line === selection?.line)
        return <details className={`code-mode-step${selected ? ' is-selected' : ''}`} open={errors.length > 0}>
          <summary onClick={() => { if (step.line) selectCodeModeLine(row.sessionId, row.toolUseId, step.line) }}><span>{step.label.length > 180 ? `${step.label.slice(0, 180)}…` : step.label}</span><span className="code-mode-digest">{codeModeStepDigest(step.calls)}</span>{issue ? <span className="code-mode-error"> {issue}</span> : step.calls.some(call => call.status === 'running' || call.status === 'pending') ? <span className="code-mode-status"> Running</span> : null}{step.line && open ? <button className="code-mode-line" onClick={event => { event.preventDefault(); selectCodeModeLine(row.sessionId, row.toolUseId, step.line!); open(row) }}>Line {step.line}</button> : null}</summary>
          <BoundedChildList keys={step.calls.map(call => call.toolUseId)} estimatedChildHeight={38} renderChild={callIndex => {
            const call = step.calls[callIndex]!
            const child = childrenByCall.get(call.toolUseId)
            const sourceLine = step.line !== undefined ? call.line : undefined
            const selectSource = () => { if (sourceLine) selectCodeModeLine(row.sessionId, row.toolUseId, sourceLine) }
            return <div className={`code-mode-linked-call${sourceLine && sourceLine === selection?.line ? ' is-selected' : ''}`} onClick={selectSource} onFocusCapture={selectSource}>
              {renderChild(child ?? projectCodeModeCall(row, call))}
            </div>
          }} />
        </details>
      }} />
      <BoundedChildList keys={childKeys} estimatedChildHeight={52} renderChild={index => renderChild(extraChildren[index]!)} />
      {!partial && cell?.changedFiles.length ? <details><summary>{cell.changedFiles.length} files changed</summary><BoundedChildList keys={changedKeys} estimatedChildHeight={28} renderChild={index => {
        const file = cell.changedFiles[index]!
        return <div className="code-mode-file">{file.path}{file.additions !== undefined ? ` +${file.additions}` : ''}{file.deletions !== undefined ? ` −${file.deletions}` : ''}</div>
      }} /></details> : null}
      <CodeModeOutput output={codeModeForRow(row)?.output ?? row.result?.content} />
    </div> : null}
  </section>
})
