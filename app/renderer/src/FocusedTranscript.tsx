import { memo, useContext, useEffect, useId, type ReactNode } from 'react'
import { FocusedDisclosure } from './FocusedDisclosure.js'
import type { FocusedSegment, FocusedSummary, FocusedTurnItem } from './focusedTranscriptLayout.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { AgentRevealContext, containsAgentTool } from './transcriptAgentReveal.js'
import './focusedTranscript.css'

type RowRenderer = (rows: readonly NestedTranscriptRow[], narration: boolean) => ReactNode

export const FocusedTranscript = memo(function FocusedTranscript({ turn, renderRows }: {
  turn: FocusedTurnItem
  renderRows: RowRenderer
}) {
  const bodyId = useId()
  // Disclosure choices are independent of the Tool call detail preference.
  const [open, setOpen] = useToolCardExpanded(turn.id, !turn.completed)
  const reveal = useContext(AgentRevealContext)
  const revealMatch = reveal !== null && containsAgentTool(turn.rows, reveal.toolUseId)
  useEffect(() => {
    if (revealMatch) setOpen(true)
  }, [reveal?.sequence, revealMatch])
  const label = turn.live ? 'Working' : 'Worked'
  const time = turn.durationMs === null ? '' : formatDuration(turn.durationMs)
  const detail = [time, turn.live && turn.toolCalls === 0 ? '' : turn.summary].filter(Boolean).join(' · ')
  return (
    <section className="focused-turn" data-focused-turn={turn.id} data-focused-completed={turn.completed ? '' : undefined}>
      <button type="button" className="focused-fold-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="focused-fold-chevron" data-open={open ? '' : undefined} aria-hidden>▸</span>
        <span key={label} className="focused-fold-label focused-text-arrival">{label}</span>
        <span key={detail} className="focused-fold-detail focused-text-arrival">{detail}</span>
        <DiffTotals summary={turn} />
        {turn.hasErrors ? <span className="focused-status-dot" data-failed role="img" aria-label="A tool failed" /> : null}
      </button>
      <FocusedDisclosure open={open} id={bodyId}>
        <div className="focused-turn-body">
          {turn.segments.map(segment => segment.kind === 'update'
            ? <div key={segment.id} data-focused-update>{renderRows(segment.rows, true)}</div>
            : <FocusedStep key={segment.id} segment={segment} live={turn.live} renderRows={renderRows} />)}
        </div>
      </FocusedDisclosure>
    </section>
  )
})

function FocusedStep({ segment, live, renderRows }: { segment: FocusedSegment; live: boolean; renderRows: RowRenderer }) {
  const bodyId = useId()
  const [open, setOpen] = useToolCardExpanded(segment.id, false)
  const reveal = useContext(AgentRevealContext)
  const revealMatch = reveal !== null && containsAgentTool(segment.rows, reveal.toolUseId)
  useEffect(() => {
    if (revealMatch) setOpen(true)
  }, [reveal?.sequence, revealMatch])
  const active = live ? segment.activeLabel : null
  const text = active ?? (!live && segment.activeLabel
    ? `Stopped ${segment.activeLabel.slice(segment.activeLabel.indexOf(' ') + 1)}`
    : capitalize(segment.summary))
  const mainTool = (live ? segment.rows.find(row => row.kind === 'tool-use' && row.status === 'pending') : null)
    ?? segment.rows.find(row => row.kind === 'tool-use')
  const mark = mainTool?.kind === 'tool-use'
    ? mainTool.toolFamily === 'bash' ? '›_' : mainTool.toolFamily === 'grep' ? '⌕'
      : mainTool.toolFamily === 'edit' || mainTool.toolFamily === 'write' ? '±' : '≡'
    : '·'
  // Live reasoning is carried by the working line until a tool joins it.
  // Afterward it remains retrievable even if the turn ends before any tool.
  if (live && segment.toolCalls === 0) return null
  return (
    <div className="focused-step">
      <button type="button" className="focused-step-head" data-open={open ? '' : undefined} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="focused-step-gutter" aria-hidden><span className="focused-step-mark">{mark}</span><span className="focused-step-chevron">▸</span></span>
        <span key={text} className="focused-step-text focused-text-arrival">{active ? <><span>{active.split(' ', 1)[0]}</span>{' '}<span className="focused-step-target">{active.slice(active.indexOf(' ') + 1)}</span></> : text}</span>
        <DiffTotals summary={segment} />
        {segment.hasErrors ? <span className="focused-status-dot" data-failed role="img" aria-label="A tool failed" /> : null}
        {active ? <span className="focused-status-dot" data-running role="img" aria-label="Running" /> : null}
      </button>
      <FocusedDisclosure open={open} id={bodyId}>
        <div className="focused-step-body">{renderRows(segment.rows, false)}</div>
      </FocusedDisclosure>
    </div>
  )
}

function DiffTotals({ summary }: { summary: FocusedSummary }) {
  return summary.additions + summary.deletions > 0 ? <span className="focused-diff">
    <span className="focused-diff-add">+{summary.additions}</span>
    <span className="focused-diff-remove">−{summary.deletions}</span>
  </span> : null
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}
function capitalize(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1) }
