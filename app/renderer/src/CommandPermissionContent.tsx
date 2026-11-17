import { memo, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react'
import { AgentFace } from './AgentChrome.js'
import type { AgentFaceIdentity } from './agentFace.js'
import { CodeCopyButton } from './CodeCopyButton.js'
import { ActionCloseIcon, ActionRunIcon } from './SessionActionIcons.js'
import { describeCommandSuggestion, formatPermissionInput } from './permissionPromptModel.js'
import type { PermissionRequest } from './permissionState.js'
import { shellPromptLines } from './shellTokens.js'
import { FAMILY_STYLE } from './toolCardPalette.js'

type Suggestion = NonNullable<PermissionRequest['request']['permission_suggestions']>[number]

export function CommandPermissionContent({
  request, titleId, worker, scriptSource, pendingCount, submitted, keysLive,
  selectedSuggestions, onSelectionChange, onAllow, onDeny, onSnooze,
}: {
  request: PermissionRequest['request']
  titleId: string
  worker?: { name: string | null; role: string; face: AgentFaceIdentity }
  scriptSource?: { line?: number }
  pendingCount?: number
  submitted: boolean
  keysLive: boolean
  selectedSuggestions: number[]
  onSelectionChange: (indices: number[]) => void
  onAllow: () => void
  onDeny: () => void
  onSnooze?: () => void
}) {
  const input = typeof request.input === 'object' && request.input !== null
    ? request.input as Record<string, unknown> : null
  const description = typeof input?.description === 'string' && input.description.trim() ? input.description : null
  const reason = request.decision_reason && request.decision_reason !==
    `Claude requested permissions to use ${request.tool_name}, but you haven't granted it yet.`
    ? request.decision_reason : undefined
  const command = typeof input?.command === 'string' ? input.command : formatPermissionInput(request.input)
  return <>
    <div className="command-permission-header">
      <span className={`command-permission-mark ${FAMILY_STYLE.bash.color}`} aria-hidden>{FAMILY_STYLE.bash.mark}</span>
      <h2 className="command-permission-title" id={titleId} title={description ? reason : undefined}>{description ?? 'Run command'}</h2>
      {!description && reason ? <span className="command-permission-reason" title={reason}>{reason}</span> : null}
      {worker ? <span className="command-permission-worker" title={`Relayed from ${worker.name ?? `a ${worker.role}`}`}>
        <AgentFace axes={worker.face.axes} fill={worker.face.fill} size={13} />
        <span>{worker.name ?? worker.role}</span>
      </span> : null}
      {scriptSource ? <span className="code-mode-permission-badge">from script{scriptSource.line ? ` · line ${scriptSource.line}` : ''}</span> : null}
      <span className="command-permission-header-actions">
        {pendingCount !== undefined && pendingCount > 1 ? <span className="command-permission-count" title={`${pendingCount} pending requests`} aria-label={`${pendingCount} pending requests`}>{pendingCount}</span> : null}
        {onSnooze ? <button type="button" className="command-permission-later" disabled={submitted} onClick={onSnooze}>Later</button> : null}
      </span>
    </div>
    <PermissionShellBlock command={command} bash={request.tool_name === 'Bash' && typeof input?.command === 'string'} />
    <div className="command-permission-footer">
      <div className="command-permission-suggestions">
        {(request.permission_suggestions ?? []).map((suggestion, index) => <CommandSuggestion
          key={index}
          suggestion={suggestion}
          checked={selectedSuggestions.includes(index)}
          disabled={submitted}
          onChange={checked => onSelectionChange(checked
            ? [...selectedSuggestions, index].sort((a, b) => a - b)
            : selectedSuggestions.filter(selected => selected !== index))}
        />)}
      </div>
      <div className="command-permission-actions">
        <button type="button" className="command-permission-button command-permission-deny rounded-md border border-shell-seam text-text-muted disabled:opacity-40" disabled={submitted} onClick={onDeny}>
          <ActionCloseIcon /><span>Deny</span>{keysLive ? <span className="command-permission-key">esc</span> : null}
        </button>
        <button type="button" className="command-permission-button command-permission-run rounded-md bg-accent font-semibold text-on-fill disabled:opacity-40" disabled={submitted} onClick={onAllow}>
          <ActionRunIcon /><span>Run</span>{keysLive ? <span className="command-permission-key">↵</span> : null}
        </button>
      </div>
    </div>
  </>
}

const PermissionShellBlock = memo(function PermissionShellBlock({ command, bash }: { command: string; bash: boolean }) {
  const lines = useMemo(() => bash ? shellPromptLines(command) : null, [command, bash])
  const [expanded, setExpanded] = useState(false)
  const [moreLines, setMoreLines] = useState(0)
  const sourceRef = useRef<HTMLElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const sourceId = useId()
  useEffect(() => {
    const source = sourceRef.current
    const pre = preRef.current
    if (!source || !pre) return
    let active = true
    const measure = () => {
      if (!active) return
      const lineHeight = parseFloat(getComputedStyle(pre).lineHeight)
      if (!(lineHeight > 0)) return
      // The source is never clamped. Its height includes wrapped lines even
      // while the pre is folded or capped at the expanded scrolling height.
      const renderedLines = Math.ceil(source.getBoundingClientRect().height / lineHeight - 0.01)
      setMoreLines(previous => {
        const next = Math.max(0, renderedLines - 12)
        return previous === next ? previous : next
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(source)
    void document.fonts?.ready.then(measure)
    return () => { active = false; observer?.disconnect() }
  }, [command, bash])
  return <div className="command-permission-shell relative overflow-hidden rounded-lg border border-shell-seam bg-app-bg" data-window-ground>
    <pre ref={preRef} className={`inline-command-code whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.65] ${expanded ? 'command-permission-expanded' : 'command-permission-folded'}`}>
      <code ref={sourceRef} id={sourceId} className="hljs command-permission-source">{lines ? lines.map((line, index) => <span key={index} className="inline-command-line">{line.prompt ? <span className="inline-command-prompt" aria-hidden>$</span> : null}{line.tokens.map((token, index) => <span key={index} className={`shell-token-${token.kind}`}>{token.text}</span>)}</span>) : command.split(/(\s+)/).map((text, index) => <span key={index} className={text.startsWith('-') ? 'command-permission-flag' : undefined}>{text}</span>)}</code>
    </pre>
    <CodeCopyButton code={command} />
    {moreLines > 0 ? <button type="button" className="command-permission-fold" aria-controls={sourceId} aria-expanded={expanded} onClick={() => {
      if (expanded && preRef.current) preRef.current.scrollTop = 0
      setExpanded(current => !current)
    }}>
      {expanded ? 'Show less' : `Show ${moreLines} more ${moreLines === 1 ? 'line' : 'lines'}`}
    </button> : null}
  </div>
})

function CommandSuggestion({ suggestion, checked, disabled, onChange }: {
  suggestion: Suggestion
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const { pre, code, destination } = useMemo(() => describeCommandSuggestion(suggestion), [suggestion])
  const labelRef = useRef<HTMLLabelElement>(null)
  const destinationRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const label = labelRef.current
    const where = destinationRef.current
    if (!label || !where) return
    let active = true
    const measure = () => {
      if (!active) return
      // Measure with the destination present, then remove it as a whole before
      // permitting any ellipsis on the rule. This also restores it on widening.
      where.hidden = false
      const rule = label.querySelector('code')
      where.hidden = label.scrollWidth > label.clientWidth || !!rule && rule.scrollWidth > rule.clientWidth
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(label)
    void document.fonts?.ready.then(measure)
    return () => { active = false; observer?.disconnect() }
  }, [pre, code, destination])
  const sentence = [pre, code, destination].filter(Boolean).join(' ')
  return <label ref={labelRef} className="command-permission-suggestion" title={sentence}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-label={sentence} />
    <span className="command-permission-suggestion-lead">{pre}</span>
    {code ? <code>{code}</code> : null}
    <span ref={destinationRef} className="command-permission-destination">{destination}</span>
  </label>
}
