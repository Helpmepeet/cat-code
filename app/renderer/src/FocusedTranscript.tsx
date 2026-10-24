import { memo, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { FocusedDisclosure } from './FocusedDisclosure.js'
import { focusedNamedCall, summarizeFocusedWork, type FocusedSegment, type FocusedSummary, type FocusedTurnItem } from './focusedTranscriptLayout.js'
import { FAMILY_STYLE } from './toolCardPalette.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import type { NestedTranscriptRow, ToolFamily } from './transcriptProjector.js'
import { AgentRevealContext, containsAgentTool } from './transcriptAgentReveal.js'
import { TranscriptMotionContext } from './transcriptMotion.js'
import './focusedTranscript.css'

type RowRenderer = (rows: readonly NestedTranscriptRow[], narration: boolean) => ReactNode
type ReasoningRenderer = (rows: readonly NestedTranscriptRow[], live: boolean) => ReactNode

/** Covers the stylesheet's settle: content fades, then the height closes. */
const TURN_BODY_EXIT_MS = 480
/** The head keeps its live wording until the body has started to settle. */
const HEAD_SETTLE_MS = 320
const CASCADE_MS = 1200
/** The stylesheet's `.focused-tick-out` duration. */
const TICK_OUT_MS = 180

export const FocusedTranscript = memo(function FocusedTranscript({ turn, renderRows, renderReasoning }: {
  turn: FocusedTurnItem
  renderRows: RowRenderer
  renderReasoning: ReasoningRenderer
}) {
  const bodyId = useId()
  // Disclosure choices are independent of the Tool call detail preference.
  const [open, setOpen] = useToolCardExpanded(turn.id, !turn.completed)
  const reveal = useContext(AgentRevealContext)
  const revealMatch = reveal !== null && containsAgentTool(turn.rows, reveal.toolUseId)
  useEffect(() => {
    if (revealMatch) setOpen(true)
  }, [reveal?.sequence, revealMatch])
  const [cascading, setCascading] = useState(false)
  const cascadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (cascadeTimer.current) clearTimeout(cascadeTimer.current) }, [])
  const headLive = useSettling(turn.live)
  const label = headLive ? 'Working' : 'Worked'
  const time = headLive || turn.durationMs === null ? '' : formatDuration(turn.durationMs)
  const settled = useMemo(() => headLive
    ? summarizeFocusedWork(turn.rows.filter(row => row.kind === 'tool-use' && row.status !== 'pending'))
    : turn, [turn, headLive])
  const detail = [time, settled.toolCalls === 0 ? '' : settled.compact].filter(Boolean).join(' · ')
  const segments = turn.segments.filter(segment => segment.kind !== 'stretch' || segment.toolCalls > 0)
  const last = segments.at(-1)
  const latestUpdate = turn.live ? [...segments].reverse().find(segment => segment.kind === 'update')?.id : undefined
  const toggle = () => {
    setOpen(!open)
    if (open || prefersReducedMotion()) return
    if (cascadeTimer.current) clearTimeout(cascadeTimer.current)
    setCascading(true)
    cascadeTimer.current = setTimeout(() => setCascading(false), CASCADE_MS)
  }
  return (
    <section className="focused-turn" data-focused-turn={turn.id} data-focused-completed={turn.completed ? '' : undefined}
      data-focused-live={turn.live ? '' : undefined}>
      <button type="button" className="focused-fold-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle} data-pane-anchor-exclude="">
        <span className="focused-fold-chevron" data-open={open ? '' : undefined} aria-hidden><FocusedChevron /></span>
        <FocusedTicker tickKey={label} className="focused-fold-label"><span className="focused-shimmer">{label}</span></FocusedTicker>
        <FocusedTicker tickKey={detail} className="focused-fold-detail">{detail}</FocusedTicker>
        <DiffTotals summary={settled} />
        <FailureMark summary={turn} />
      </button>
      <FocusedDisclosure open={open} id={bodyId} exitMs={TURN_BODY_EXIT_MS} className="focused-turn-disclosure">
        <div className="focused-turn-body" data-cascade={cascading ? '' : undefined}>
          {segments.map(segment => <FocusedSegmentBlock key={segment.id} segment={segment} live={turn.live}>
            {segment.kind === 'update'
              ? <div data-focused-update data-latest={segment.id === latestUpdate ? '' : undefined}>{renderRows(segment.rows, true)}</div>
              : segment.kind === 'reasoning' ? renderReasoning(segment.rows, turn.live && !turn.answering && segment === last)
              : <FocusedStep segment={segment} live={turn.live} renderRows={renderRows} />}
          </FocusedSegmentBlock>)}
        </div>
      </FocusedDisclosure>
    </section>
  )
})

function FocusedSegmentBlock({ segment, live, children }: { segment: FocusedSegment; live: boolean; children: ReactNode }) {
  const id = useId()
  const motion = useContext(TranscriptMotionContext)
  const arriving = live && segment.rows.some(row => motion.rows.active.has(row.id) || motion.freshProse.has(row.id))
  return <FocusedDisclosure open id={id} animateArrival={arriving} className="focused-segment">{children}</FocusedDisclosure>
}

function FocusedStep({ segment, live, renderRows }: { segment: FocusedSegment; live: boolean; renderRows: RowRenderer }) {
  const bodyId = useId()
  // A settled stretch that failed opens with its rows when the turn is reopened.
  const [open, setOpen] = useToolCardExpanded(segment.id, !live && segment.errorCount > 0)
  const reveal = useContext(AgentRevealContext)
  const revealMatch = reveal !== null && containsAgentTool(segment.rows, reveal.toolUseId)
  useEffect(() => {
    if (revealMatch) setOpen(true)
  }, [reveal?.sequence, revealMatch])
  const active = live ? segment.activeLabel : null
  const named = segment.activeLabel === null ? focusedNamedCall(segment.rows) : null
  const split = (label: string) => [label.slice(0, label.indexOf(' ')), label.slice(label.indexOf(' ') + 1)] as const
  const [key, text] = active
    ? [`run:${active}`, <><span className="focused-step-verb">{split(active)[0]}</span>{' '}<span className="focused-step-target">{split(active)[1]}</span></>]
    : segment.activeLabel
      ? [`stop:${segment.activeLabel}`, `Stopped ${split(segment.activeLabel)[1]}`]
      : named
        ? [`named:${named.verb}:${named.target}`, <>{named.verb} <span className="focused-step-target">{named.target}</span></>]
        : [`sum:${segment.summary}`, capitalize(segment.summary)]
  const mainTool = (live ? segment.rows.find(row => row.kind === 'tool-use' && row.status === 'pending') : null)
    ?? segment.rows.find(row => row.kind === 'tool-use')
  const family = mainTool?.kind === 'tool-use' ? mainTool.toolFamily : null
  return (
    <div className="focused-step">
      <button type="button" className="focused-step-head" data-open={open ? '' : undefined} data-running={active ? '' : undefined}
        aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="focused-step-gutter" aria-hidden>
          <span className={`focused-step-mark ${family !== null && STEP_MARK_COLORED.has(family) ? FAMILY_STYLE[family].color : ''}`}>{family === null ? '·' : stepMark(family)}</span>
          <span className="focused-step-chevron"><FocusedChevron /></span>
        </span>
        <FocusedTicker tickKey={key} className="focused-step-text">{text}</FocusedTicker>
        <DiffTotals summary={segment} />
        <FailureMark summary={segment} />
      </button>
      <FocusedDisclosure open={open} id={bodyId}>
        <div className="focused-step-body">{renderRows(segment.rows, false)}</div>
      </FocusedDisclosure>
    </div>
  )
}

/** Step marks keep Focused's compact set; the families named here take their tool colour. */
const STEP_MARK_COLORED: ReadonlySet<ToolFamily> = new Set(['bash', 'read', 'grep', 'edit', 'write', 'web', 'skill', 'agent'])
function stepMark(family: ToolFamily): string {
  return family === 'bash' ? '$' : family === 'grep' ? '⌕' : family === 'edit' || family === 'write' ? '±' : '≡'
}

/** Text that changes in place leaves upward while its replacement rises in. */
function FocusedTicker({ tickKey, className, children }: { tickKey: string; className: string; children: ReactNode }) {
  const [shown, setShown] = useState(tickKey)
  const [outgoing, setOutgoing] = useState<{ key: string; node: ReactNode } | null>(null)
  const previous = useRef<ReactNode>(children)
  if (shown !== tickKey) {
    setShown(tickKey)
    setOutgoing(prefersReducedMotion() ? null : { key: shown, node: previous.current })
  }
  useEffect(() => { previous.current = children })
  // `animationend` is not guaranteed (a hidden window, a cancelled animation),
  // so the leaving copy is also cleared once its animation would have finished.
  useEffect(() => {
    if (!outgoing) return
    const timer = setTimeout(() => setOutgoing(null), TICK_OUT_MS + 40)
    return () => clearTimeout(timer)
  }, [outgoing])
  return (
    <span className={`focused-ticker ${className}`}>
      {outgoing ? <span key={`out:${outgoing.key}`} className="focused-tick-out" aria-hidden onAnimationEnd={() => setOutgoing(null)}>{outgoing.node}</span> : null}
      <span key={`in:${tickKey}`} className={outgoing ? 'focused-tick-in' : undefined}>{children}</span>
    </span>
  )
}

/** Holds the live wording briefly after the turn ends so the settle reads in order. */
function useSettling(live: boolean): boolean {
  const [held, setHeld] = useState(live)
  useEffect(() => {
    if (live) { setHeld(true); return }
    if (prefersReducedMotion()) { setHeld(false); return }
    const timer = setTimeout(() => setHeld(false), HEAD_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [live])
  return live || held
}

function FailureMark({ summary }: { summary: FocusedSummary }) {
  if (summary.errorCount > 0) return <span className="focused-fail-note">{summary.errorCount} failed</span>
  return summary.hasErrors ? <span className="focused-status-dot" data-failed role="img" aria-label="A tool failed" /> : null
}

function DiffTotals({ summary }: { summary: FocusedSummary }) {
  return summary.additions + summary.deletions > 0 ? <span className="focused-diff">
    {summary.additions > 0 ? <span className="focused-diff-add">+{summary.additions}</span> : null}
    {summary.deletions > 0 ? <span className="focused-diff-remove">−{summary.deletions}</span> : null}
  </span> : null
}

function FocusedChevron() {
  return (
    <svg className="focused-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}
function capitalize(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1) }
