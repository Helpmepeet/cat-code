import { memo, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react'
import { AutoModeReviewFooter, AutoModeReviewMark, AutoModeReviewReason } from './AutoModeReviewMark.js'
import { summarizeAutoModeReviews, visibleAutoModeReason } from './autoModeReview.js'
import { BoundedChildList } from './BoundedChildList.js'
import { CodeModeOutput } from './CodeModeOutput.js'
import { CodeModePartialChanges } from './CodeModePartialChanges.js'
import { CodeModeSource } from './CodeModeSource.js'
import { CodeModeCaret, CodeModeDot, CodeModePath, CodeModeStepHeader } from './CodeModeStep.js'
import { codeModeForRow, type CodeModeCall } from './codeMode.js'
import { codeModeChildView } from './codeModeChildView.js'
import { codeModeDisplayOutput } from './codeModeDisplayOutput.js'
import { codeModeChildIsReviewing, codeModeLiveView } from './codeModeLiveView.js'
import { revealCodeModeLine, useCodeModeSelection } from './codeModeSelection.js'
import { codeModeMcpName, codeModeStepDirectory, codeModeStepHasError, codeModeSteps, type CodeModeStep } from './codeModeSteps.js'
import { FilePathMenuContext } from './filePathActions.js'
import { focusedCallPhase } from './focusedCallText.js'
import { FAMILY_STYLE } from './toolCardPalette.js'
import { createToolCardExpansionStore, ToolCardExpansionContext, useToolCardExpanded, useToolCardExpansionStore } from './toolCardExpansion.js'
import { TOOL_CARD_BAND_CLASS, TOOL_CARD_BODY_CLASS, TOOL_CARD_HEADER_CLASS, TOOL_CARD_SHELL_CLASS, ToolCardStyleContext } from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { TranscriptFileScopeContext, scopedTranscriptFilePath } from './transcriptFileScope.js'
import { FocusedNamedCallContext } from './transcriptMode.js'
import type { FocusedLiveState, NestedToolUseRow } from './transcriptProjector.js'
import { displayFilePath } from './transcriptToolTarget.js'
import './codeMode.css'

const NO_CALLS: readonly CodeModeCall[] = []
const NO_LINES: readonly string[] = []

export type CodeModeMemberPresentation = {
  cwd: string | null
  file: string | null
  status?: string
  error?: string
  sourceLine?: number
  onRevealLine: (line: number) => void
  grouped: boolean
  pathPrefix?: string
  openResult: boolean
}

export function CodeModeLineLink({ line, onReveal }: { line?: number; onReveal(line: number): void }) {
  if (!line) return null
  const label = `Show line ${line} in the source`
  return <button type="button" className="code-mode-line" aria-label={label} title={label}
    onClick={() => onReveal(line)}>L{line}</button>
}

function codeModeGroupDefaultOpen(step: CodeModeStep): boolean {
  return step.members.some(member => codeModeStepHasError(member.status))
}

function CodeModeGroup({ expansionKey, step, selected, sessionId, childApprovals, onRevealLine, onToggleFiles, renderMember }: {
  expansionKey: string
  step: CodeModeStep
  selected: boolean
  sessionId: NestedToolUseRow['sessionId']
  childApprovals: FocusedLiveState['awaitingApproval'] | null
  onRevealLine: (line: number) => void
  onToggleFiles: () => void
  renderMember: (member: CodeModeStep['members'][number], grouped: boolean, prefix?: string) => ReactNode
}) {
  const first = step.members[0]!
  const running = step.members.filter(member => member.status === 'running')
  const status = step.members.find(member => member.status === 'failed')?.status
    ?? step.members.find(member => member.status === 'blocked')?.status
    ?? running[0]?.status ?? step.members.find(member => member.status === 'cancelled')?.status
  const [open, setOpen] = useToolCardExpanded(expansionKey, codeModeGroupDefaultOpen(step))
  const keys = useMemo(() => step.members.map(member => member.call.toolUseId), [step])
  const prefix = first.family === 'read' ? codeModeStepDirectory(step) : undefined
  const count = step.members.length
  const fileCount = first.family === 'read' ? new Set(step.members.map(member =>
    member.file && scopedTranscriptFilePath(member.file, member.cwd ?? undefined))).size : 0
  const label = first.family === 'edit' && first.file ? <>
    <CodeModePath path={first.file} cwd={first.cwd} sessionId={sessionId} />
    <span className="code-mode-member-aside">{count} edits</span>
  </> : first.family === 'read' ? <>
    <span className="code-mode-member-main">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
    {prefix ? <span className="code-mode-member-aside">{prefix}</span> : null}
  </> : <>
    <span className="code-mode-member-main">{first.family === 'mcp' ? codeModeMcpName(first.call.name) : first.call.name}</span>
    <span className="code-mode-member-aside code-mode-member-count">{count} calls</span>
  </>
  const phase = running.some(({ call }) => childApprovals?.[call.toolUseId]) ? 'Waiting for approval'
    : running.some(({ child }) => child && codeModeChildIsReviewing(child)) ? 'Reviewing' : undefined
  const reviews = useMemo(() => summarizeAutoModeReviews(step.members.map(({ child }) => child?.autoModeReview)), [step])
  const sourceLine = step.members.find(member => member.line !== undefined)?.line
  const digest = step.adds || step.dels ? <CodeModeCounts adds={step.adds} dels={step.dels} />
    : running.length > 0 ? `${count - running.length} of ${count}` : undefined
  return <div className={`code-mode-step${selected ? ' is-selected' : ''}`}>
    <CodeModeStepHeader className="code-mode-group-header" expanded={open} onToggle={() => {
      setOpen(!open)
      if (first.family !== 'edit' && step.changedPaths.size) onToggleFiles()
    }}
      family={first.family} label={label} digest={digest} status={status} phase={phase} review={<AutoModeReviewMark summary={reviews} />}
      lineLink={sourceLine ? <CodeModeLineLink line={sourceLine} onReveal={onRevealLine} /> : null} />
    {open ? <BoundedChildList className="code-mode-group-body" keys={keys} estimatedChildHeight={22}
      renderChild={index => renderMember(step.members[index]!, true, prefix)} /> : null}
  </div>
}

export function CodeModeCounts({ adds, dels }: { adds: number; dels: number }) {
  return <>
    {adds > 0 ? <span className="code-mode-add">+{adds}</span> : null}
    {dels > 0 ? <span className="code-mode-del">−{dels}</span> : null}
  </>
}

export const CodeModeCard = memo(function CodeModeCard({ row, renderChild, renderCall, waitingForApproval = false, childApprovals = null }: {
  row: NestedToolUseRow
  renderChild: (row: NestedToolUseRow['children'][number]) => ReactNode
  renderCall?: (row: NestedToolUseRow, presentation: CodeModeMemberPresentation) => ReactNode
  waitingForApproval?: boolean
  childApprovals?: FocusedLiveState['awaitingApproval'] | null
}) {
  const cell = codeModeLiveView(row)
  const audit = codeModeForRow(row)
  const calls = cell?.calls ?? NO_CALLS
  const selection = useCodeModeSelection(row.sessionId, row.toolUseId)
  const { style } = useContext(ToolCardStyleContext)
  const { expanded: defaults } = useContext(ToolsExpandedContext)
  const headerless = useContext(FocusedNamedCallContext) === row.toolUseId
  const fileCwd = useContext(FilePathMenuContext)?.cwd ?? null
  const scopes = useContext(TranscriptFileScopeContext)
  const cwd = scopes?.get(row.id) ?? fileCwd
  const id = `${row.sessionId}:${row.toolUseId}`
  const code = cell?.code ?? (typeof row.input.code === 'string' ? row.input.code : '')
  const lines = useMemo(() => code ? code.split('\n') : NO_LINES, [code])
  const { steps, reasons, families } = useMemo(() => codeModeSteps({
    parent: row, calls, lineCount: lines.length, cwd, scopes: scopes ?? undefined, generation: cell?.generation,
  }), [row, calls, lines.length, cwd, scopes, cell?.generation])
  const hasCallErrors = useMemo(() => calls.some(call => !!call.error || codeModeStepHasError(call.status)), [calls])
  const [expandedChoice, setPicked] = useToolCardExpanded(row.toolUseId, row.status === 'pending' || row.status === 'error' || hasCallErrors || defaults)
  const expanded = headerless || expandedChoice
  const sharedExpansionStore = useToolCardExpansionStore()
  const expansionStore = useMemo(() => sharedExpansionStore ?? createToolCardExpansionStore(), [sharedExpansionStore])
  const [groupRevision, onToggleFiles] = useReducer((revision: number) => revision + 1, 0)
  const [sourceOpen, setSourceOpen] = useToolCardExpanded(`code-mode-source:${id}`, false)
  const [outputOpen, setOutputOpen] = useToolCardExpanded(`code-mode-output:${id}`, false)
  const showLine = useCallback((line: number) => {
    setSourceOpen(true)
    revealCodeModeLine(row.sessionId, row.toolUseId, line)
  }, [row.sessionId, row.toolUseId, setSourceOpen])
  const keys = useMemo(() => steps.map(step => step.key), [steps])
  const selectedStep = useMemo(() => selection ? steps.find(step => step.members.some(member => member.line === selection.line)) : undefined, [steps, selection])
  const revealRequest = useMemo(() => selectedStep && selection ? { key: selectedStep.key, sequence: selection.token } : null, [selectedStep, selection])
  const extraChildren = useMemo(() => {
    const audited = new Set(calls.map(call => call.toolUseId))
    return row.children.filter(child => child.kind !== 'tool-use' || (
      !audited.has(child.toolUseId) && !(cell && child.codeMode?.cellId === row.toolUseId)
    ))
  }, [row.children, row.toolUseId, calls, !!cell])
  const childKeys = useMemo(() => extraChildren.map(child => child.id), [extraChildren])
  const description = cell?.description ?? (typeof row.input.description === 'string' ? row.input.description : 'Script')
  const phase = focusedCallPhase({ ...row, awaitingApproval: waitingForApproval ? true : undefined }, true)
  const status = phase === 'preparing' ? 'writing' : phase === 'reviewing' ? 'reviewing' : phase === 'approval' ? 'approval' : phase === 'queued' ? 'waiting' :
    cell?.status ?? (row.status === 'cancelled' ? 'cancelled' : row.status === 'error' ? row.autoModeReview?.outcome === 'blocked' ? 'blocked' : 'failed' : row.status === 'success' ? 'completed' : 'running')
  const statusLabel = status === 'writing' ? 'Writing' : status === 'reviewing' ? 'Reviewing' : status === 'approval' ? 'Waiting for approval' : status === 'waiting' ? 'Waiting' : status === 'yielded' ? 'Paused' : status === 'unknown' ? 'Outcome unknown' : null
  const partial = !!cell?.changedFiles.length && (codeModeStepHasError(status) || status === 'yielded')
  const changedFiles = cell?.changedFiles
  const unlistedChanges = useMemo(() => {
    if (!expanded || !changedFiles?.length) return []
    const visiblePaths = new Set<string>()
    for (const step of steps) {
      if (!step.changedPaths.size) continue
      const first = step.members[0]!
      const key = `code-mode-group:${id}:${step.key}`
      if (step.members.length === 1 || (expansionStore.get(key) ?? codeModeGroupDefaultOpen(step))) {
        for (const path of step.changedPaths) visiblePaths.add(path)
      } else if (first.family === 'edit' && first.file) {
        const path = scopedTranscriptFilePath(first.file, first.cwd ?? undefined)
        if (step.changedPaths.has(path)) visiblePaths.add(path)
      }
    }
    return changedFiles.filter(file => !visiblePaths.has(scopedTranscriptFilePath(file.path, cwd ?? undefined)))
  }, [expanded, changedFiles, steps, id, expansionStore, groupRevision, cwd])
  const changedKeys = useMemo(() => unlistedChanges.map(file => file.path), [unlistedChanges])
  const showError = cell?.error && !reasons.has(cell.error) && visibleAutoModeReason(row.autoModeReview) !== cell.error
  const loneBash = steps.length === 1 && steps[0]?.members.length === 1 && steps[0].members[0]?.call.name === 'Bash'
    ? steps[0].members[0] : undefined
  const bashResult = useMemo(() => loneBash ? codeModeChildView(row, loneBash.call, loneBash.child).result : undefined, [row, loneBash])
  const output = useMemo(() => {
    if (!audit) return row.result?.content
    const explained = new Set(reasons)
    if (audit.error) explained.add(audit.error)
    return codeModeDisplayOutput(audit, explained)
  }, [audit, row.result, reasons])
  const showOutput = output === undefined || (!!output && (!bashResult?.content || output.trim() !== bashResult.content.trim()))
  const outputLineCount = useMemo(() => {
    if (!output) return 0
    let count = 1
    for (let index = 0; index < output.length; index++) if (output[index] === '\n') count++
    return count
  }, [output])

  const renderMember = (member: CodeModeStep['members'][number], grouped: boolean, prefix?: string) => {
    const child = codeModeChildView(row, member.call, member.child)
    const editGroup = grouped && member.family === 'edit'
    return <div className="code-mode-linked-call">
      {renderCall ? renderCall(child, {
        cwd: member.cwd, file: member.file, status: member.status, error: member.error,
        sourceLine: !grouped || editGroup ? member.line : undefined,
        onRevealLine: showLine, grouped, pathPrefix: prefix,
        openResult: !!loneBash && !!bashResult,
      }) : renderChild(child)}
    </div>
  }

  return <section className={`code-mode ${headerless ? 'code-mode-headerless' : TOOL_CARD_SHELL_CLASS[style]}`}
    data-card-style={style} aria-label={`Script: ${description}`}>
    {headerless ? status === 'approval' ? <div className="code-mode-source-action">
      <span className="code-mode-status">Waiting for approval</span>
    </div> : null : <header className="code-mode-header">
      <button type="button" className={`code-mode-disclosure ${TOOL_CARD_HEADER_CLASS[style]}`}
        aria-expanded={expanded} onClick={() => setPicked(!expanded)}>
        <span className="code-mode-mark" aria-hidden>{'{}'}</span>
        <span className="code-mode-word">SCRIPT</span>
        <span className="code-mode-description" title={description}>{description}</span>
        {status === 'approval' || !families.size ? null : <span className="code-mode-tally">{[...families].map(([family, count]) => {
          const { mark, word, color } = FAMILY_STYLE[family]
          return <span key={family} title={`${word}: ${count} ${count === 1 ? 'call' : 'calls'}`}>
            <i className={color} aria-hidden>{mark}</i><span aria-label={`${word} ${count}`}>{count}</span>
          </span>
        })}</span>}
        <AutoModeReviewMark review={row.autoModeReview} />
        {statusLabel ? <span className={`code-mode-status code-mode-status-${status}`}>{statusLabel}</span> : null}
        <CodeModeDot status={status} />
      </button>
    </header>}
    {partial && cell && !expanded ? <div className={TOOL_CARD_BAND_CLASS[style]}>
      <CodeModePartialChanges files={cell.changedFiles} cwd={cwd} id={id} />
    </div> : null}
    {expanded ? <div className={`code-mode-body ${headerless ? '' : TOOL_CARD_BODY_CLASS[style]}`}>
      <AutoModeReviewReason review={row.autoModeReview} />
      {showError ? <pre className="code-mode-error">{cell.line ? `Line ${cell.line}: ` : ''}{cell.error}</pre> : null}
      <ToolCardExpansionContext.Provider value={expansionStore}>
        <BoundedChildList keys={keys} estimatedChildHeight={22} revealRequest={revealRequest} renderChild={index => {
          const step = steps[index]!
          const selected = !!selection && step.members.some(member => member.line === selection.line)
          if (step.members.length === 1) return <div className={`code-mode-step${selected ? ' is-selected' : ''}`}>
            {renderMember(step.members[0]!, false)}
          </div>
          return <CodeModeGroup expansionKey={`code-mode-group:${id}:${step.key}`} step={step} selected={selected}
            sessionId={row.sessionId} childApprovals={childApprovals} onRevealLine={showLine}
            onToggleFiles={onToggleFiles} renderMember={renderMember} />
        }} />
      </ToolCardExpansionContext.Provider>
      <BoundedChildList keys={childKeys} estimatedChildHeight={52} renderChild={index => renderChild(extraChildren[index]!)} />
      {partial && cell && unlistedChanges.length > 0 ? <CodeModePartialChanges files={cell.changedFiles} cwd={cwd} id={id} /> : null}
      {!partial && unlistedChanges.length > 0 ? <details className="code-mode-changes"><summary>{unlistedChanges.length === 1 ? '1 file changed' : `${unlistedChanges.length} files changed`}</summary>
        <BoundedChildList keys={changedKeys} estimatedChildHeight={22} renderChild={index => {
          const file = unlistedChanges[index]!
          return <div className="code-mode-file">{displayFilePath(file.path, cwd)}{file.additions !== undefined ? ` +${file.additions}` : ''}{file.deletions !== undefined ? ` −${file.deletions}` : ''}</div>
        }} />
      </details> : null}
      <AutoModeReviewFooter review={row.autoModeReview} />
      {code || showOutput ? <div className="code-mode-footer">
        {code ? <button type="button" className="code-mode-fold-head code-mode-script" aria-expanded={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}>
          <CodeModeCaret open={sourceOpen} />Source <span className="code-mode-output-count">{lines.length}</span>
        </button> : null}
        {showOutput ? <button type="button" className="code-mode-fold-head code-mode-output-toggle" aria-expanded={outputOpen} onClick={() => setOutputOpen(!outputOpen)}>
          <CodeModeCaret open={outputOpen} />Output <span className="code-mode-output-count">{output === undefined ? 'Waiting for output' : outputLineCount}</span>
        </button> : null}
      </div> : null}
      {code && sourceOpen ? <CodeModeSource sessionId={row.sessionId} cellId={row.toolUseId} lines={lines}
        calls={calls} errorLine={cell?.error && cell.line ? cell.line : null} /> : null}
      {showOutput && outputOpen ? <CodeModeOutput output={output} lineCount={outputLineCount} /> : null}
    </div> : null}
  </section>
})
