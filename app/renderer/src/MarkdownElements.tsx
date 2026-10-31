import { useContext, useId, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { inlineCommandSourceKey, isInteractiveShellCommand, type InlineCommandRun, type InlineCommandSource } from '../../shared/inlineCommand.js'
import { InlineCommandContext } from './inlineCommandState.js'
import { shellPromptLines } from './shellTokens.js'
import { childrenToText } from './markdownText.js'
import { ActionCopyIcon, ActionRewindIcon, ActionRunIcon, ActionStopIcon } from './SessionActionIcons.js'

export function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
  // The code renderer owns the frame and its <pre>, so do not nest another one.
  return <>{children}</>
}

export function MarkdownTable({ children }: ComponentPropsWithoutRef<'table'>) {
  // Keep the transcript's left-aligned cells without forwarding inline styles.
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-white/[0.08]">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  )
}

export function MarkdownTableHeader({ children }: ComponentPropsWithoutRef<'th'>) {
  return (
    <th className="whitespace-nowrap border-b border-white/[0.12] bg-white/[0.03] px-3 py-[7px] text-left font-semibold text-[light-dark(#27272a,#e4e4e7)]">
      {children}
    </th>
  )
}

export function MarkdownTableCell({ children }: ComponentPropsWithoutRef<'td'>) {
  return (
    <td className="border-b border-white/[0.05] px-3 py-[7px] align-top text-[light-dark(#52525b,#c4c4c8)]">
      {children}
    </td>
  )
}

export function MarkdownCode({
  className,
  children,
  inlineSource,
  renderOutput,
}: ComponentPropsWithoutRef<'code'> & { inlineSource?: InlineCommandSource; renderOutput?: (run: InlineCommandRun) => ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? '')
  const text = childrenToText(children)
  // Inline code (single backtick, no language, no newline) stays inline.
  if (!match && !text.includes('\n')) {
    return <code className={className}>{children}</code>
  }
  // Fenced block: `children` carries rehype-highlight's colored <span> tree for
  // DISPLAY; `text` is the raw source used by the copy button.
  return (
    <MarkdownCodeBlock
      code={text.replace(/\n$/, '')}
      language={match?.[1]}
      inlineSource={inlineSource}
      renderOutput={renderOutput}
      highlighted={children}
    />
  )
}

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export function MarkdownCallout({
  node,
  children,
}: ComponentPropsWithoutRef<'aside'> & {
  node?: { properties?: Record<string, unknown> }
}) {
  const kind = calloutKindOf(node?.properties?.dataCalloutKind)
  if (kind === null) return <aside>{children}</aside>

  return (
    <aside className="md-callout" data-callout-kind={kind}>
      <div className="md-callout-label">{calloutLabel(kind)}</div>
      <div className="md-callout-body">{children}</div>
    </aside>
  )
}

function calloutKindOf(value: unknown): CalloutKind | null {
  switch (value) {
    case 'note':
    case 'tip':
    case 'important':
    case 'warning':
    case 'caution':
      return value
    default:
      return null
  }
}

function calloutLabel(kind: CalloutKind): string {
  switch (kind) {
    case 'note':
      return 'Note'
    case 'tip':
      return 'Tip'
    case 'important':
      return 'Important'
    case 'warning':
      return 'Warning'
    case 'caution':
      return 'Caution'
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/** Highlighted children are display-only; copy always uses the complete source. */
export function MarkdownCodeBlock({
  code,
  highlighted,
  streaming = false,
  inlineSource,
  language,
  windowed = false,
  displayRange,
  renderOutput,
}: {
  renderOutput?: (run: InlineCommandRun) => ReactNode
  windowed?: boolean
  displayRange?: readonly [number, number]
  language?: string
  code: string
  highlighted: ReactNode
  /** The fence is still arriving, so there is no finished block to copy. */
  streaming?: boolean
  inlineSource?: InlineCommandSource
}) {
  const [copied, setCopied] = useState(false)
  const commands = useContext(InlineCommandContext)
  const sourceKey = inlineSource ? inlineCommandSourceKey(inlineSource) : undefined
  const run = sourceKey ? [...(commands?.runs ?? [])].reverse().find(run => inlineCommandSourceKey(run.source) === sourceKey) : undefined
  const pending = sourceKey ? commands?.pending.has(sourceKey) : false
  const completedAttempt = sourceKey ? commands?.requests.some(request => inlineCommandSourceKey(request.source) === sourceKey && request.status === 'completed') : false
  const error = sourceKey ? commands?.errors.get(sourceKey) : undefined
  const running = run?.status === 'running'
  const busy = !!commands && (commands.pending.size > 0 || commands.runs.some(run => run.status === 'running'))
  const descriptionId = useId()
  const unavailable = pending ? 'Wait for the command to start.'
    : !commands?.generation ? 'Connect to the session before running a command.'
      : commands.blockedReason ?? (busy ? 'Wait for the current command to finish.'
        : isInteractiveShellCommand(code) ? 'This command needs an interactive terminal.' : undefined)
  const action = running ? 'Stop' : pending ? 'Starting' : run || error || completedAttempt ? 'Run again' : 'Run'
  const runnable = !!inlineSource && !!commands
  const outcome = run?.status === 'failed' ? (run.exitCode === null ? 'Failed' : `Exit ${run.exitCode}`)
    : run?.status === 'stopped' ? 'Stopped' : run?.status === 'interrupted' ? 'Interrupted' : ''
  const promptLines = useMemo(() => inlineSource && (!windowed || displayRange)
    ? shellPromptLines(code, displayRange?.[0], displayRange?.[1]) : null, [code, inlineSource, windowed, displayRange?.[0], displayRange?.[1]])
  const copy = (): void => {
    if (streaming) return
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  // `data-window-ground`: this frame repeats the page ground rather than painting
  // a surface of its own, which is the whole grammar of a fenced block here
  // (`theme.css`: code sits IN the page, not on a coloured slab). Opaque that is
  // invisible, because `bg-app-bg` IS the page. Under glass the page goes
  // translucent and this did not, so the block became the flat slab the grammar
  // exists to avoid, whichever way the wallpaper pushed it. Marked so glass
  // clears it and the toggle stops changing this block's relationship to the
  // page it sits in.
  return (
    <div
      className="relative my-3 overflow-hidden rounded-lg border border-shell-seam bg-app-bg"
      data-window-ground
    >
      <pre className={`whitespace-pre-wrap break-words py-3.5 pl-3.5 font-mono text-[12.5px] leading-[1.65] ${inlineSource ? 'inline-command-code pr-3.5' : 'pr-10'}`} data-language={language}>
      {runnable ? (
          <span className="inline-command-controls">
            {outcome ? <span className="inline-command-meta"><span className={`inline-command-dot ${run?.status === 'failed' ? 'text-tone-danger' : 'text-tone-warn'}`} aria-hidden />{outcome}</span> : null}
            <button type="button" className={`inline-command-action ${running ? 'text-tone-danger' : action === 'Run' || pending ? 'text-accent' : 'text-text-subtle'}`}
              aria-label={action} aria-busy={pending || undefined}
              aria-disabled={!running && !!unavailable}
              aria-describedby={!running && unavailable ? descriptionId : undefined}
              title={!running && unavailable ? unavailable : action}
              onClick={() => {
                if (running && run) commands.stop(run)
                else if (!unavailable) commands.start(inlineSource)
              }}
            >{running ? <ActionStopIcon /> : action === 'Run again' ? <ActionRewindIcon /> : <ActionRunIcon />}<span>{action}</span></button>
            <span id={descriptionId} className="inline-command-tooltip" role="tooltip">{!running && unavailable ? unavailable : action}</span>
            <button type="button" className={`inline-command-control ${copied ? 'text-[light-dark(#15803d,#86efac)]' : 'text-text-subtle'}`} onClick={copy} aria-label={copied ? 'Code copied' : 'Copy code'} title={copied ? 'Code copied' : 'Copy code'}>{copied ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="20 6 9 17 4 12" /></svg> : <ActionCopyIcon />}</button>
            <span className="inline-command-tooltip inline-command-copy-tooltip" role="tooltip">{copied ? 'Code copied' : 'Copy code'}</span>
          </span>
      ) : null}
        <code className="hljs">{promptLines ? promptLines.map((line, index) => <span key={index} className="inline-command-line">{line.prompt ? <span className="inline-command-prompt" aria-hidden>$</span> : null}{line.tokens.map((token, index) => <span key={index} className={`shell-token-${token.kind}`}>{token.text}</span>)}</span>) : highlighted}</code>
      </pre>
      {!inlineSource ? (
      <button
        type="button"
        onClick={copy}
        disabled={streaming}
        title={streaming ? 'Code still writing' : copied ? 'Code copied' : 'Copy code'}
        aria-label={streaming ? 'Code still writing' : copied ? 'Code copied' : 'Copy code'}
        className={`absolute right-2 top-1 z-[1] inline-flex size-7 items-center justify-center rounded-md transition-colors ${
          streaming
            ? 'cursor-default text-text-ghost'
            : copied
              ? 'text-[light-dark(#15803d,#86efac)]'
              : 'text-text-subtle hover:bg-white/[0.06] hover:text-text-primary'
        }`}
      >
        {copied ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <ActionCopyIcon />
        )}
      </button>
      ) : null}
      {!run && completedAttempt ? <p className="border-t border-shell-seam px-3.5 py-3 text-xs text-text-subtle">Command output is no longer retained.</p> : null}
      {run ? renderOutput?.(run) : null}
      {error ? <p role="alert" className="border-t border-shell-seam px-3.5 py-2 text-xs text-text-muted">{error}</p> : null}
    </div>
  )
}
