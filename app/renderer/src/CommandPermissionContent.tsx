import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { MAX_SUGGESTION_SELECTIONS } from '../../shared/limits.js'
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
  onSelectionChange: (index: number, checked: boolean) => void
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
  const [inputShown, setInputShown] = useState(false)
  const inputId = useId()
  const formattedInput = useMemo(() => formatPermissionInput(request.input), [request.input])
  const command = typeof input?.command === 'string' ? input.command : undefined
  const sandboxOverride = request.tool_name === 'Bash' && input?.dangerouslyDisableSandbox === true
  const atSelectionLimit = selectedSuggestions.length >= MAX_SUGGESTION_SELECTIONS
  const suggestions = request.permission_suggestions ?? []
  return <>
    <div className="command-permission-header">
      <span className={`command-permission-mark ${FAMILY_STYLE.bash.color}`} aria-hidden>{FAMILY_STYLE.bash.mark}</span>
      <h2 className="command-permission-title" id={titleId}>{description ?? 'Run command'}</h2>
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
    {reason || request.blocked_path || sandboxOverride ? (
      <div className="command-permission-context">
        {reason ? <p>{reason}</p> : null}
        {request.blocked_path ? <p>Blocked path <code>{request.blocked_path}</code></p> : null}
        {sandboxOverride ? <p className="text-tone-warn">Requested to run outside the Bash sandbox.</p> : null}
      </div>
    ) : null}
    <PermissionShellBlock command={command ?? formattedInput} bash={request.tool_name === 'Bash' && command !== undefined} />
    <div className="command-permission-footer">
      {suggestions.length > 0 ? <div className="command-permission-suggestions">
        {suggestions.map((suggestion, index) => <CommandSuggestion
          key={index}
          suggestion={suggestion}
          checked={selectedSuggestions.includes(index)}
          disabled={submitted || (atSelectionLimit && !selectedSuggestions.includes(index))}
          onChange={checked => onSelectionChange(index, checked)}
        />)}
        {atSelectionLimit && suggestions.length > MAX_SUGGESTION_SELECTIONS ? (
          <p className="command-permission-selection-limit" role="status">Up to {MAX_SUGGESTION_SELECTIONS} suggestions per approval. Deselect one to choose another.</p>
        ) : null}
      </div> : null}
      {command !== undefined ? <button
        type="button"
        className="command-permission-input-toggle"
        aria-expanded={inputShown}
        aria-controls={inputId}
        onClick={() => setInputShown(shown => !shown)}
      >Full input</button> : null}
      <div className="command-permission-actions">
        <button type="button" className="command-permission-button command-permission-deny rounded-md border border-shell-seam text-text-muted disabled:opacity-40" disabled={submitted} onClick={onDeny}>
          <ActionCloseIcon /><span>Deny</span>{keysLive ? <span className="command-permission-key">esc</span> : null}
        </button>
        <button type="button" className="command-permission-button command-permission-run rounded-md bg-accent font-semibold text-on-fill disabled:opacity-40" disabled={submitted} onClick={onAllow}>
          <ActionRunIcon /><span>Run</span>{keysLive ? <span className="command-permission-key">↵</span> : null}
        </button>
      </div>
    </div>
    {command !== undefined ? <pre id={inputId} className="command-permission-input" aria-label="Command input" hidden={!inputShown} tabIndex={0}>{formattedInput}</pre> : null}
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
  const sentence = [pre, code, destination].filter(Boolean).join(' ')
  return <label className="command-permission-suggestion">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-label={sentence} />
    <span className="command-permission-suggestion-body">
      {pre}{' '}
      {code ? <><code>{code}</code>{' '}</> : null}
      <span className="command-permission-destination">{destination}</span>
    </span>
  </label>
}
