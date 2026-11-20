import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MAX_SUGGESTION_SELECTIONS } from '../../shared/limits.js'
import { AgentFace } from './AgentChrome.js'
import type { AgentFaceIdentity } from './agentFace.js'
import { PermissionReasonMark } from './AutoModeReviewMark.js'
import { DiffRowView } from './DiffRowView.js'
import { selectRowWordSegments, selectSnippetDiffRows } from './diffRowModel.js'
import { basename, dirname } from './pathUtils.js'
import { describeCommandSuggestion, selectPermissionPreview } from './permissionPromptModel.js'
import type { PermissionRequest } from './permissionState.js'
import { readSourceLanguage } from './readSource.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import { FAMILY_STYLE } from './toolCardPalette.js'
import './EditPermissionContent.css'

const DEFAULT_REASON = "Claude requested permissions to use Edit, but you haven't granted it yet."
const FOLDED_LINES = 12

export function EditPermissionContent({
  request, titleId, worker, scriptSource, pendingCount, submitted, denyOnly,
  selectedSuggestions, onSelectionChange, onAllow, onDeny, onSnooze,
}: {
  request: PermissionRequest['request']
  titleId: string
  worker?: { name: string | null; role: string; face: AgentFaceIdentity }
  scriptSource?: { line?: number }
  pendingCount?: number
  submitted: boolean
  denyOnly: boolean
  selectedSuggestions: number[]
  onSelectionChange: (index: number, checked: boolean) => void
  onAllow: () => void
  onDeny: () => void
  onSnooze?: () => void
}) {
  const { input, decision_reason, blocked_path } = request
  const path = typeof input?.file_path === 'string' ? input.file_path : ''
  const reason = decision_reason === DEFAULT_REASON ? undefined : decision_reason
  // The contextual Auto mode handoff is the engine's sole producer of human_only.
  const reasonHeading = request.human_only === true ? 'Auto mode requested your decision' : 'Why approval is needed'
  const { rows, adds, dels } = useMemo(() => {
    const preview = selectPermissionPreview('Edit', input)
    const lines = preview?.kind === 'change' ? preview.lines : []
    let adds = 0
    let dels = 0
    for (const { kind } of lines) {
      if (kind === 'add') adds++
      if (kind === 'del') dels++
    }
    return { rows: selectSnippetDiffRows(lines), adds, dels }
  }, [input])
  const suggestions = !denyOnly && Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions : []
  const atSelectionLimit = selectedSuggestions.length >= MAX_SUGGESTION_SELECTIONS
  return <>
    <div className="edit-permission-block" data-window-ground>
      <div className="edit-permission-header">
        <span className={`edit-permission-mark ${FAMILY_STYLE.edit.color}`} aria-hidden>{FAMILY_STYLE.edit.mark}</span>
        <h2 className="edit-permission-path" id={titleId} title={path || undefined}>
          {path ? <><span className="sr-only">Edit </span>{dirname(path)}<span>{basename(path)}</span></> : <span>Edit</span>}
        </h2>
        {adds > 0 || dels > 0 ? <span className="edit-permission-counts">
          {adds > 0 ? <span className="edit-permission-adds">+{adds}</span> : null}
          {dels > 0 ? <span className="edit-permission-dels">−{dels}</span> : null}
        </span> : null}
        {pendingCount !== undefined && pendingCount > 1
          ? <span className="command-permission-count" title={`${pendingCount} pending requests`} aria-label={`${pendingCount} pending requests`}>{pendingCount}</span>
          : null}
        {reason ? <PermissionReasonMark heading={reasonHeading} reason={reason} /> : null}
      </div>
      {worker || scriptSource || blocked_path || input?.replace_all === true ? (
        <div className="edit-permission-context">
          {worker ? <span className="edit-permission-worker" title={`Relayed from ${worker.name ?? `a ${worker.role}`}`}>
            <AgentFace axes={worker.face.axes} fill={worker.face.fill} size={13} />
            <span>{worker.name ?? worker.role}</span>
          </span> : null}
          {scriptSource ? <span className="code-mode-permission-badge">from script{scriptSource.line ? ` · line ${scriptSource.line}` : ''}</span> : null}
          {input?.replace_all === true ? <span>Replace all matches</span> : null}
          {blocked_path ? <span>Blocked path <code>{blocked_path}</code></span> : null}
        </div>
      ) : null}
      <EditDiff rows={rows} path={path} />
    </div>
    <div className="edit-permission-answer">
      {suggestions.length > 0 ? <div className="edit-permission-suggestions">
        {suggestions.map((suggestion, index) => {
          const { pre, code, destination } = describeCommandSuggestion(suggestion)
          const checked = selectedSuggestions.includes(index)
          return <label className="edit-permission-suggestion" key={index}>
            <input
              type="checkbox"
              checked={checked}
              disabled={submitted || (atSelectionLimit && !checked)}
              onChange={event => onSelectionChange(index, event.target.checked)}
            />
            <span>{pre}{' '}{code ? <><code>{code}</code>{' '}</> : null}<span>{destination}</span></span>
          </label>
        })}
        {atSelectionLimit && suggestions.length > MAX_SUGGESTION_SELECTIONS ? (
          <p role="status">Up to {MAX_SUGGESTION_SELECTIONS} suggestions per approval. Deselect one to choose another.</p>
        ) : null}
      </div> : null}
      <div className="edit-permission-actions">
        {onSnooze ? <button type="button" disabled={submitted} onClick={onSnooze}>Later</button> : null}
        <button type="button" title={denyOnly ? undefined : 'Esc'} disabled={submitted} onClick={onDeny}>Deny</button>
        {denyOnly ? null : <button type="button" className="edit-permission-apply" title="Enter" disabled={submitted} onClick={onAllow}>Apply</button>}
      </div>
    </div>
  </>
}

const EditDiff = memo(function EditDiff({ rows, path }: {
  rows: ReturnType<typeof selectSnippetDiffRows>
  path: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLDivElement>(null)
  const sourceId = useId()
  const [expanded, setExpanded] = useState(false)
  const [visualLines, setVisualLines] = useState(rows.length)
  const paintedRows = useMemo(() => {
    const bodies = rows.map(row => row.body)
    const coloured = selectHighlightedSourceRows(bodies, readSourceLanguage(path))
    return rows.map((row, index) => (
      <DiffRowView key={index} row={row} body={coloured?.[index] ?? row.body}
        segments={selectRowWordSegments(rows, index)} showLineNumber={false} />
    ))
  }, [rows, path])

  useLayoutEffect(() => {
    const node = source.current
    if (!node || rows.length === 0) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight)
      const height = node.getBoundingClientRect().height
      // The inner source never clamps, so its height includes wrapped lines.
      setVisualLines(lineHeight > 0 && height > 0
        ? Math.max(rows.length, Math.round(height / lineHeight)) : rows.length)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [rows])

  if (rows.length === 0) return <div className="edit-permission-empty">No diff lines.</div>

  const moreLines = Math.max(0, visualLines - FOLDED_LINES)
  const isOpen = expanded && moreLines > 0
  return <>
    <div ref={scroller} id={sourceId} className="edit-permission-diff" data-expanded={isOpen}
      tabIndex={isOpen ? 0 : undefined} aria-label={isOpen ? 'Edit diff' : undefined}>
      <div ref={source}>{paintedRows}</div>
    </div>
    {moreLines > 0 ? <button type="button" className="edit-permission-fold" aria-controls={sourceId} aria-expanded={isOpen} onClick={() => {
      if (isOpen && scroller.current) scroller.current.scrollTop = 0
      setExpanded(!isOpen)
    }}>
      {isOpen ? 'Show less' : `Show ${moreLines} more ${moreLines === 1 ? 'line' : 'lines'}`}
    </button> : null}
  </>
})
