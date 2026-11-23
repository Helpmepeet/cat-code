import { useContext, type ReactNode } from 'react'
import { FilePathMenuContext } from './filePathActions.js'
import { selectedTextInside } from './transcriptPaneFiles.js'
import { displayFilePath } from './transcriptToolTarget.js'
import type { NestedToolUseRow, ToolFamily } from './transcriptProjector.js'
import { FAMILY_STYLE } from './toolCardPalette.js'

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completed', failed: 'Failed', blocked: 'Blocked', cancelled: 'Stopped',
  running: 'Running', unknown: 'Outcome unknown',
}

export function CodeModeDot({ status, pulse }: { status?: string; pulse?: boolean }) {
  const label = status && STATUS_LABELS[status]
  return <span className={`code-mode-dot${status ? ` code-mode-dot-${status}` : ''}${pulse ? ' animate-pulse' : ''}`}
    role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true} />
}

export function CodeModeCaret({ open }: { open: boolean }) {
  return <svg className={`code-mode-caret${open ? ' is-open' : ''}`} viewBox="0 0 10 10" aria-hidden>
    <path d="M3.5 1.8 6.7 5 3.5 8.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
}

export function CodeModePath({ path, sessionId, cwd, prefix = '' }: {
  path: string; sessionId: NestedToolUseRow['sessionId']; cwd: string | null; prefix?: string
}) {
  const fileMenu = useContext(FilePathMenuContext)
  const relative = displayFilePath(path, cwd)
  const shown = relative.startsWith(prefix) ? relative.slice(prefix.length) : relative
  const at = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1
  return <span className="code-mode-path" title={path} data-file-actions=""
    onContextMenu={event => {
      if (!fileMenu || selectedTextInside(event.currentTarget)) return
      event.preventDefault()
      event.stopPropagation()
      fileMenu.openFilePathMenu({ type: 'pointer', x: event.clientX, y: event.clientY },
        path, sessionId, cwd ? { sourceCwd: cwd } : undefined)
    }}>
    {at > 0 ? <span className="code-mode-path-dir">{shown.slice(0, at)}</span> : null}
    <span className="code-mode-path-base">{shown.slice(at) || shown}</span>
  </span>
}

export function CodeModeStepHeader({ className, expanded, onToggle, family, label, digest, status, phase, review,
  lineLink, fileOpen, pulse }: {
  className: string; expanded: boolean; onToggle?(): void; family?: ToolFamily; label: ReactNode
  digest?: ReactNode; status?: string; phase?: string; review?: ReactNode; lineLink?: ReactNode
  fileOpen?: ReactNode; pulse?: boolean
}) {
  const mark = family && FAMILY_STYLE[family]
  const Head = onToggle ? 'button' : 'div'
  // The line link appears over the counts, which hide on hover, so it ends where
  // the toggle ends. The review mark stays outside it, reachable for its tooltip.
  return <div className={`code-mode-step-header ${className}${lineLink ? ' has-line-link' : ''}`}>
    <Head className="code-mode-member" {...(onToggle ? { type: 'button' as const, 'aria-expanded': expanded, onClick: onToggle } : {})}>
      {onToggle ? <CodeModeCaret open={expanded} /> : <span className="code-mode-caret" aria-hidden />}
      {mark ? <span className={`code-mode-member-mark ${mark.color}`} aria-hidden>{mark.mark}</span> : null}
      <span className="code-mode-member-target">{label}</span>
      {digest ? <span className="code-mode-member-digest">{digest}</span> : null}
    </Head>
    {lineLink ? <div className="code-mode-step-actions">{lineLink}</div> : null}
    {review}
    {phase ? <span className="code-mode-member-status">{phase}</span> : null}
    {fileOpen}
    <CodeModeDot status={status} pulse={pulse} />
  </div>
}
