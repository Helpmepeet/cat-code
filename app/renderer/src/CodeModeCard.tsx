import { memo, useContext, useMemo, type ReactNode } from 'react'
import { BoundedChildList } from './BoundedChildList.js'
import { ToolOutputContext } from './toolOutputPanel.js'
import { ToolCardStyleContext } from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { codeModeForRow, codeModeDigest, codeModeStepDigest, type CodeModeCall } from './codeMode.js'
import { codeModeChildIsReviewing, codeModeLiveView } from './codeModeLiveView.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { codeModeChildView } from './codeModeChildView.js'
import './codeMode.css'
import { revealCodeModeLine, selectCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import { CodeModeOutput } from './CodeModeOutput.js'
import { CodeModePartialChanges } from './CodeModePartialChanges.js'
import { FocusedNamedCallContext } from './transcriptMode.js'
import { focusedCallPhase } from './focusedCallText.js'
import { deriveToolFamily } from './transcriptProjector.js'
import { FAMILY_STYLE } from './toolCardPalette.js'

function CodeModeGroup({ id, selected, errors, label, digest, issue, family, onSelect, lineLink, children }: { id: string; selected: boolean; errors: boolean; label: string; digest: string | null; issue: string | null; family: { mark: string; color: string }; onSelect: () => void; lineLink: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useToolCardExpanded(`code-mode-group:${id}`, selected || errors)
  return <div className={`code-mode-step${selected ? ' is-selected' : ''}`}>
    <div className="code-mode-group-header"><button type="button" aria-expanded={open} onClick={() => { onSelect(); setOpen(!open) }}><span className={`code-mode-caret${open ? ' is-open' : ''}`} aria-hidden>▸</span><span className={`code-mode-member-mark ${family.color}`} aria-hidden>{family.mark}</span><span className="code-mode-member-target">{label}</span><span className="code-mode-digest">{digest}</span>{issue ? <><span className={`code-mode-dot ${issue === 'Stopped' ? 'code-mode-dot-cancelled' : errors ? 'code-mode-dot-failed' : 'code-mode-dot-running'}`} aria-hidden /><span className={issue === 'Stopped' ? 'code-mode-stopped' : errors ? 'code-mode-error' : 'code-mode-status'}>{issue}</span></> : null}</button>{lineLink}</div>
    {open ? <div className="code-mode-group-body">{children}</div> : null}
  </div>
}

export const CodeModeCard = memo(function CodeModeCard({ row, renderChild, renderCall, waitingForApproval = false }: { row: NestedToolUseRow; renderChild: (row: NestedToolUseRow['children'][number]) => ReactNode; renderCall?: (row: NestedToolUseRow) => ReactNode; waitingForApproval?: boolean }) {
  const cell = codeModeLiveView(row)
  const open = useContext(ToolOutputContext)
  const selection = useCodeModeSelection(row.sessionId, row.toolUseId)
  const style = useContext(ToolCardStyleContext)
  const headerless = useContext(FocusedNamedCallContext) === row.toolUseId
  const { expanded: defaults } = useContext(ToolsExpandedContext)
  const hasCallErrors = useMemo(() => cell?.calls.some(call => !!call.error || ['failed', 'error', 'blocked', 'cancelled'].includes(call.status)) ?? false, [cell])
  const [expandedChoice, setPicked] = useToolCardExpanded(row.toolUseId, row.status === 'pending' || row.status === 'error' || hasCallErrors || defaults)
  const expanded = headerless || expandedChoice
  const steps = useMemo(() => {
    const groups: { key: string; line?: number; calls: CodeModeCall[] }[] = []
    const lineCount = cell?.code ? cell.code.split('\n').length : 0
    for (const call of cell?.calls ?? []) {
      const line = call.line && call.line <= lineCount ? call.line : undefined
      const last = groups.at(-1)
      if (line && last?.line === line && last.calls[0]?.name === call.name && deriveToolFamily(call.name) !== 'edit') last.calls.push(call)
      else groups.push({ key: call.toolUseId, line, calls: [call] })
    }
    return groups
  }, [cell])
  const keys = useMemo(() => steps.map(step => step.key), [steps])
  const selectedStep = useMemo(() => selection ? steps.find(step => step.line === selection.line) : undefined, [steps, selection])
  const revealRequest = useMemo(() => selectedStep && selection ? { key: selectedStep.key, sequence: selection.token } : null, [selectedStep, selection])
  const extraChildren = useMemo(() => {
    const audited = new Set(cell?.calls.map(call => call.toolUseId))
    return row.children.filter(child => child.kind !== 'tool-use' || (
      !audited.has(child.toolUseId) && !(cell && child.codeMode?.cellId === row.toolUseId)
    ))
  }, [row.children, row.toolUseId, cell])
  const childKeys = useMemo(() => extraChildren.map(child => child.id), [extraChildren])
  const childrenByCall = useMemo(() => new Map(row.children.flatMap(child =>
    child.kind === 'tool-use' && child.sessionId === row.sessionId &&
      (!cell?.generation || !child.codeMode || child.codeMode.cellId === row.toolUseId && child.codeMode.generation === cell.generation)
      ? [[child.toolUseId, child] as const] : [])), [row.children, row.sessionId, row.toolUseId, cell])
  const description = cell?.description ?? (typeof row.input.description === 'string' ? row.input.description : 'Script')
  const phase = focusedCallPhase({ ...row, awaitingApproval: waitingForApproval ? true : undefined }, true)
  const status = phase === 'preparing' ? 'writing' : phase === 'reviewing' ? 'reviewing' : phase === 'approval' ? 'approval' : phase === 'queued' ? 'waiting' :
    cell?.status ?? (row.status === 'cancelled' ? 'cancelled' : row.status === 'error' ? row.autoModeReview?.outcome === 'blocked' ? 'blocked' : 'failed' : row.status === 'success' ? 'completed' : 'running')
  const statusLabel = status === 'writing' ? 'Writing' : status === 'reviewing' ? 'Reviewing' : status === 'approval' ? 'Waiting for approval' : status === 'waiting' ? 'Waiting' : status === 'running' ? 'Running' : status === 'yielded' ? 'Paused' : status === 'unknown' ? 'Outcome unknown' : status
  const showApproval = phase === 'approval'
  const partial = !!cell?.changedFiles.length && ['failed', 'cancelled', 'blocked', 'yielded'].includes(status)
  const changedKeys = useMemo(() => cell?.changedFiles.map((file, index) => `${index}:${file.path}`) ?? [], [cell])
  return <section className={`code-mode${headerless ? ' code-mode-headerless' : ''}`} data-card-style={style} aria-label={`Script: ${description}`}>
    {headerless ? open || showApproval ? <div className="code-mode-source-action">
      {showApproval ? <span className="code-mode-status">Waiting for approval</span> : null}
      {open ? <button className="code-mode-source" onClick={() => open(row)}>Open</button> : null}
    </div> : null : <header className="code-mode-header">
      <button className="code-mode-disclosure" aria-expanded={expanded} onClick={() => setPicked(!expanded)}>
        <span className="code-mode-mark" aria-hidden>{'{}'}</span><span className="code-mode-word">SCRIPT</span><span className="code-mode-description">{description}</span>
        {!expanded && cell ? <span className="code-mode-digest">{codeModeDigest(cell)}</span> : null}
        <span className={`code-mode-status code-mode-status-${status}`}>{statusLabel}</span><span className={`code-mode-dot code-mode-dot-${status}`} aria-hidden />
      </button>
      {open ? <button className="code-mode-source" onClick={() => open(row)}>Open</button> : null}
    </header>}
    {partial && cell ? <CodeModePartialChanges files={cell.changedFiles} /> : null}
    {expanded ? <div className="code-mode-body">
      {cell?.error ? <pre className="code-mode-error">{cell.error}</pre> : null}
      <BoundedChildList keys={keys} estimatedChildHeight={44} revealRequest={revealRequest} renderChild={index => {
        const step = steps[index]!
        const errors = step.calls.filter(call => call.error || ['failed', 'error', 'cancelled', 'blocked'].includes(call.status))
        const issue = errors.length ? errors.every(call => call.status === 'cancelled') ? 'Stopped' : errors.every(call => call.status === 'blocked') ? 'Blocked' : 'Failed' : null
        const selected = !!step.line && step.line === selection?.line
        const renderMember = (call: CodeModeCall) => {
          const child = childrenByCall.get(call.toolUseId)
          const sourceLine = step.line === call.line ? call.line : undefined
          return <div className={`code-mode-linked-call${sourceLine && sourceLine === selection?.line ? ' is-selected' : ''}`} onClick={() => { if (sourceLine) revealCodeModeLine(row.sessionId, row.toolUseId, sourceLine) }} onFocusCapture={() => { if (sourceLine) selectCodeModeLine(row.sessionId, row.toolUseId, sourceLine) }}>
            {(renderCall ?? renderChild)(codeModeChildView(row, call, child))}
          </div>
        }
        const lineLink = step.line && open ? <button className="code-mode-line" aria-label={`Show line ${step.line} in the script`} title={`Show line ${step.line} in the script`} onClick={() => { selectCodeModeLine(row.sessionId, row.toolUseId, step.line!); open(row) }}>L{step.line}</button> : null
        if (step.calls.length === 1) return <div className={`code-mode-step${selected ? ' is-selected' : ''}`}><div className="code-mode-single">{renderMember(step.calls[0]!)}{lineLink}</div></div>
        const running = step.calls.some(call => call.status === 'running' || call.status === 'pending')
        const reviewing = status === 'reviewing' && step.calls.some(call => {
          const child = childrenByCall.get(call.toolUseId)
          return child && codeModeChildIsReviewing(child)
        })
        const settled = step.calls.filter(call => call.status !== 'running' && call.status !== 'pending').length
        return <CodeModeGroup id={`${row.sessionId}:${row.toolUseId}:${step.key}`} selected={selected} errors={errors.length > 0} label={step.calls[0]?.name === 'Read' ? `${step.calls.length} files` : `${step.calls.length} ${step.calls[0]?.name ?? 'tool'} calls`} digest={running ? `${settled} of ${step.calls.length}` : codeModeStepDigest(step.calls)} issue={issue ?? (reviewing ? 'Reviewing' : running ? 'Running' : null)} family={FAMILY_STYLE[deriveToolFamily(step.calls[0]!.name)]} onSelect={() => { if (step.line) revealCodeModeLine(row.sessionId, row.toolUseId, step.line) }} lineLink={lineLink}>
          <BoundedChildList keys={step.calls.map(call => call.toolUseId)} estimatedChildHeight={38} renderChild={callIndex => renderMember(step.calls[callIndex]!)} />
        </CodeModeGroup>
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
