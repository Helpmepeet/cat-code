import { duration, firstWaitPhrase, preparingCalls, rollingCalls, type FocusedCall } from './focusedLive.js'
import { focusedCallLine, focusedCallMark, type FocusedCallContext, type FocusedCallLine } from './focusedCallText.js'
import { isPeerSpeechCall } from './peerSurfaces.js'
import type { FocusedLiveState } from './transcriptProjector.js'
import type { TasksSnapshot } from '../../shared/protocol.js'
import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { FocusedDisclosure } from './FocusedDisclosure.js'
import { BoundedChildList } from './BoundedChildList.js'
import { focusedNamedCall, isFocusedDeliverable, latestComputerScreenshot, summarizeFocusedWork, type FocusedSegment, type FocusedSummary, type FocusedTurnItem } from './focusedTranscriptLayout.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { AgentRevealContext, containsAgentTool } from './transcriptAgentReveal.js'
import { TranscriptMotionContext } from './transcriptMotion.js'
import { FocusedNamedCallContext } from './transcriptMode.js'
import { AutoModeReviewMark } from './AutoModeReviewMark.js'
import { summarizeAutoModeReviews } from './autoModeReview.js'
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

export const FocusedTranscript = memo(function FocusedTranscript({ turn, renderRows, renderReasoning, liveState = null, tasks = null, cwd = null, latestLive = true }: {
  turn: FocusedTurnItem
  latestLive?: boolean
  liveState?: FocusedLiveState | null
  tasks?: TasksSnapshot | null
  /** Project folder trimmed from path targets, as Full does. */
  cwd?: string | null
  renderRows: RowRenderer
  renderReasoning: ReasoningRenderer
}) {
  const bodyId = useId()
  const preparing = turn.live && latestLive && !turn.answering ? preparingCalls(liveState, turn.rows[0]?.sessionId ?? '') : []
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
  const preparingId = preparing[0]?.toolUseId
  const segments = useMemo(() => {
    const result = turn.segments.filter(segment => segment.kind !== 'stretch' || segment.toolCalls > 0)
    if (preparingId && result.at(-1)?.kind !== 'stretch') {
      result.push({ kind: 'stretch', id: `focused-preparing:${preparingId}`, rows: [], ...summarizeFocusedWork([]) })
    }
    return result
  }, [turn.segments, preparingId])
  const segmentKeys = useMemo(() => segments.map(segment => segment.id), [segments])
  const revealSegment = reveal ? segments.find(segment => containsAgentTool(segment.rows, reveal.toolUseId)) : null
  const latestStretch = [...segments].reverse().find(segment => segment.kind === 'stretch')
  const pending = turn.rows.some(row => row.kind === 'tool-use' && row.status === 'pending') || preparing.length > 0
  const visibleOutput = segments.length > 0 || pending || turn.answering
  // Preparing calls can disappear on a replacement stream without leaving a stored row.
  const [hadVisibleOutput, setHadVisibleOutput] = useState(visibleOutput)
  if (visibleOutput && !hadVisibleOutput) setHadVisibleOutput(true)
  const firstWait = !visibleOutput && !hadVisibleOutput
  const issuedCalls = new Set(turn.rows.flatMap(row => row.kind === 'tool-use' ? [row.toolUseId] : []))
  const background = turn.live && latestLive ? tasks?.focusedBashJobs?.filter(job => job.toolUseId &&
    (issuedCalls.has(job.toolUseId) || !!liveState?.activities[job.toolUseId]) &&
    (job.status === 'running' || job.endTime !== undefined)) ?? [] : []
  const last = segments.at(-1)
  const callContext: FocusedCallContext = { signalled: liveState !== null, cwd, tasks, turnRows: turn.rows }
  const deliverables = useMemo(() => turn.rows.filter(isFocusedDeliverable), [turn.rows])
  const latestUpdate = turn.live ? [...segments].reverse().find(segment => segment.kind === 'update')?.id : undefined
  const toggle = () => {
    setOpen(!open)
    if (open || prefersReducedMotion()) return
    if (cascadeTimer.current) clearTimeout(cascadeTimer.current)
    setCascading(true)
    cascadeTimer.current = setTimeout(() => setCascading(false), CASCADE_MS)
  }
  return (<>
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
        <BoundedChildList keys={segmentKeys} estimatedChildHeight={82} directChildren
          className="focused-turn-body" cascading={cascading}
          initialAnchorKey={turn.live ? segments.at(-1)?.id : null}
          revealRequest={revealSegment && reveal ? { key: revealSegment.id, sequence: reveal.sequence } : null}
          renderChild={index => {
            const segment = segments[index]
            if (!segment) return null
            return <FocusedSegmentBlock key={segment.id} segment={segment} live={turn.live} following={index > 0}>
            {segment.kind === 'update'
              ? <div data-focused-update data-latest={segment.id === latestUpdate ? '' : undefined}><FocusedStaticRows segment={segment} narration renderRows={renderRows} /></div>
              : segment.kind === 'speech' ? <div className="focused-lifted-speech"><FocusedStaticRows segment={segment} narration={false} renderRows={renderRows} /></div>
              : segment.kind === 'reasoning' ? <FocusedStaticReasoning segment={segment} live={turn.live && !turn.answering && segment === last} renderReasoning={renderReasoning} />
              : <FocusedStep segment={segment} live={turn.live} rolling={latestLive && segment === latestStretch && !turn.answering} preparing={segment === latestStretch ? preparing : []} liveState={liveState} callContext={callContext} renderRows={renderRows} />}
          </FocusedSegmentBlock>
          }}
          footer={<>
          {background.length ? <FocusedBackground jobs={background} /> : null}
          {turn.live && latestLive && !turn.answering && !pending && !liveState?.streaming
            ? <FocusedThinking liveState={liveState} firstWait={firstWait} /> : null}
          </>}
        />
      </FocusedDisclosure>
    </section>
    {deliverables.length ? <div className="focused-deliverables">{renderRows(deliverables, false)}</div> : null}
  </>)
})

// Keep presentation gates outside row rendering: a new latest update need not rerender its predecessor.
const FocusedStaticRows = memo(function FocusedStaticRows({ segment, narration, renderRows }: {
  segment: FocusedSegment; narration: boolean; renderRows: RowRenderer
}) {
  return renderRows(segment.rows, narration)
})

const FocusedStaticReasoning = memo(function FocusedStaticReasoning({ segment, live, renderReasoning }: {
  segment: FocusedSegment; live: boolean; renderReasoning: ReasoningRenderer
}) {
  return renderReasoning(segment.rows, live)
})

/** Only time-dependent presentation consumes this value; the step's rows stay outside clock renders. */
const FocusedClockContext = createContext(0)

function FocusedCallClock({ live, children }: { live: boolean; children: ReactNode }) {
  const now = useLiveClock(live)
  return <FocusedClockContext.Provider value={now}>{children}</FocusedClockContext.Provider>
}

function FocusedThinking({ liveState, firstWait }: { liveState: FocusedLiveState | null; firstWait: boolean }) {
  const now = useLiveClock(liveState !== null)
  const quietMs = liveState ? now - liveState.lastVisibleChangeAt : 0
  if (quietMs < 1000) return null
  const waitPhrase = firstWait ? firstWaitPhrase(quietMs) : null
  return <div className="focused-thinking">
    <span className="focused-reasoning-gutter" aria-hidden><span className="focused-reasoning-node" /></span>
    {waitPhrase !== null
      ? <FocusedTicker tickKey={waitPhrase} className=""><span className="focused-live-verb">{waitPhrase}</span></FocusedTicker>
      : <><span className="focused-live-verb">Thinking</span><span className="focused-meta">{quietMs >= 2000 ? duration(quietMs) : ''}</span></>}
  </div>
}

function FocusedBackground({ jobs }: { jobs: NonNullable<TasksSnapshot['focusedBashJobs']> }) {
  const now = useLiveClock(jobs.some(job => job.status === 'running' || (job.endTime !== undefined && Date.now() - job.endTime < 4000)))
  return <>{jobs.filter(job => job.status === 'running' || (job.endTime !== undefined && now - job.endTime < 4000)).map(job =>
    <div key={job.id} className={`focused-bg${job.status !== 'running' ? ' focused-bg-done' : ''}`}>
      <span className="focused-bg-mark" aria-hidden>&amp;</span><span className="focused-bg-text">{job.label}</span>
      <span className={`focused-meta${job.status === 'failed' ? ' focused-meta-fail' : job.status === 'killed' ? ' focused-meta-warn' : ''}`}>{job.status === 'running' ? duration(now - job.startTime) : job.status === 'completed' ? 'finished' : job.status === 'killed' ? 'stopped' : 'failed'}</span>
    </div>)}</>
}

function FocusedSegmentBlock({ segment, live, following, children }: { segment: FocusedSegment; live: boolean; following: boolean; children: ReactNode }) {
  const id = useId()
  const motion = useContext(TranscriptMotionContext)
  const arriving = live && segment.rows.some(row => motion.rows.active.has(row.id) || motion.freshProse.has(row.id))
  return <FocusedDisclosure open id={id} childKey={segment.id} animateArrival={arriving}
    className={`focused-segment${following ? ' focused-segment-following' : ''}`}>{children}</FocusedDisclosure>
}

function FocusedStep({ segment, live, rolling, preparing, liveState, callContext, renderRows }: {
  segment: FocusedSegment; live: boolean; rolling: boolean; preparing: FocusedCall[]; liveState: FocusedLiveState | null; callContext: FocusedCallContext; renderRows: RowRenderer
}) {
  const bodyId = useId()
  // A settled stretch that failed opens with its rows when the turn is reopened.
  const [open, setOpen] = useToolCardExpanded(segment.id, !live && segment.errorCount > 0)
  const reveal = useContext(AgentRevealContext)
  const revealMatch = reveal !== null && containsAgentTool(segment.rows, reveal.toolUseId)
  useEffect(() => {
    if (revealMatch) setOpen(true)
  }, [reveal?.sequence, revealMatch])
  const calls: FocusedCall[] = [...segment.rows.filter((row): row is Extract<NestedTranscriptRow, { kind: 'tool-use' }> => row.kind === 'tool-use').map(row => ({ ...row, activity: liveState?.activities[row.toolUseId], awaitingApproval: liveState?.awaitingApproval[row.toolUseId] })), ...preparing]
  const messageOrder = new Map([...new Set(calls.map(call => call.messageId))].map((id, index) => [id, index]))
  calls.sort((a, b) => messageOrder.get(a.messageId)! - messageOrder.get(b.messageId)! || a.blockIndex - b.blockIndex)
  const finished = calls.filter(call => call.status !== 'pending')
  const rollingNow = live && rolling && !open
  const activeCall = calls.find(call => call.status === 'pending' && call.awaitingApproval) ?? calls.find(call => call.status === 'pending' && call.activity) ?? calls.find(call => call.status === 'pending')
  const finishedHead = live && rolling && finished.length > 0
  const headCall = finishedHead ? undefined : activeCall
  const liveHead = live ? headCall : undefined
  const headLine = liveHead ? focusedCallLine(liveHead, callContext) : null
  const summary = finishedHead ? summarizeFocusedWork(finished) : segment
  const named = !rollingNow && segment.activeCall === null ? focusedNamedCall(segment.rows, callContext) : rollingNow && finished.length === calls.length ? focusedNamedCall(finished, callContext) : null
  // A turn stopped mid-call names the call it was making, from its row so the path is trimmed like any other.
  const stopped = segment.activeCall && !finishedHead && !live ? segment.activeCall : null
  const stoppedRow = stopped ? segment.rows.find(row => row.kind === 'tool-use' && row.toolUseId === stopped.toolUseId) : undefined
  const stoppedLine = stoppedRow?.kind === 'tool-use' ? focusedCallLine(stoppedRow, callContext) : null
  const [key, text] = liveHead && headLine
    ? [`run:${liveHead.toolUseId}:${headLine.phase}:${headLine.verb}`, <CallWords line={headLine} call={liveHead} kind="head" />]
    : stopped
      ? [`stop:${stopped.toolUseId}`, <>Stopped <span className={(stoppedLine?.targetFace ?? 'mono') === 'mono' ? 'focused-step-target' : 'focused-step-title'}>{stoppedLine?.target ?? stopped.target}</span></>]
      : named
        ? [`named:${named.line.verb}:${named.line.target}`, <CallWords line={named.line} call={null} kind="named" />]
        : [`sum:${summary.summary}`, capitalize(summary.summary)]
  const headNames = !liveHead && !stopped ? named : null
  const mainTool = headCall ?? (live ? segment.rows.find(row => row.kind === 'tool-use' && row.status === 'pending') : null)
    ?? segment.rows.find(row => row.kind === 'tool-use')
  const mainMark = mainTool?.kind === 'tool-use' ? focusedCallMark(mainTool) : null
  const screenshot = latestComputerScreenshot(segment.rows)
  // A running agent's own newest calls show what it is doing; child calls get no activity reports, so none is "queued".
  const agentHead = live && !open && liveHead?.toolFamily === 'agent' && liveHead.status === 'pending' ? liveHead : null
  const childCalls: FocusedCall[] = agentHead ? agentHead.children
    .filter((row): row is Extract<NestedTranscriptRow, { kind: 'tool-use' }> => row.kind === 'tool-use' && !isPeerSpeechCall(row.toolName))
    .slice(-3).map(row => ({ ...row, activity: liveState?.activities[row.toolUseId], awaitingApproval: liveState?.awaitingApproval[row.toolUseId] })) : []
  const rollingList = rollingNow ? rollingCalls(calls.filter(call => call !== headCall && call.toolUseId !== named?.toolUseId)) : []
  const noteOmitted = headNames?.line.phase === 'stopped' ? 'stopped' : headNames?.line.phase === 'blocked' ? 'blocked'
    : headNames?.line.phase === 'done' && headNames.line.background?.state === 'failed' ? 'failed' : null
  return (
    <FocusedCallClock live={live && [...(liveHead ? [liveHead] : []), ...childCalls, ...rollingList].some(call => call.status === 'pending' && !!call.activity && !call.preparing && !call.awaitingApproval)}>
    <div className="focused-step">
      <button type="button" className="focused-step-head" data-open={open ? '' : undefined} data-running={headLine?.verbTone === 'live' && headLine.phase !== 'preparing' ? '' : undefined}
        aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="focused-step-gutter" aria-hidden>
          <span className={`focused-step-mark ${mainMark?.markClass ?? ''}`}>{mainMark?.mark ?? '·'}</span>
          <span className="focused-step-chevron"><FocusedChevron /></span>
        </span>
        <FocusedTicker tickKey={key} className="focused-step-text">{text}</FocusedTicker>
        <AutoModeReviewMark summary={summarizeAutoModeReviews(calls.map(call => call.autoModeReview))} />
        <DiffTotals summary={summary} />
        <FailureMark summary={summary} omit={noteOmitted} />
        {liveHead && headLine ? <CallMeta call={liveHead} line={headLine} /> : headNames && headNames.line.phase !== 'failed' ? <BackgroundMeta background={headNames.line.background} /> : null}
      </button>
      {liveHead ? <LiveOutput call={liveHead} className="focused-head-out" /> : null}
      {agentHead ? <RollingCalls calls={childCalls} callContext={{ ...callContext, signalled: false }} /> : null}
      <RollingCalls calls={rollingList} callContext={callContext} />
      {!open && screenshot ? <button type="button" className="focused-shot" aria-label="Open this step" onClick={() => setOpen(true)}>
        <img alt="Latest screenshot" decoding="async" loading="lazy" src={`data:${screenshot.mediaType};base64,${screenshot.data}`} />
      </button> : null}
      <FocusedDisclosure open={open} id={bodyId}>
        <FocusedNamedCallContext.Provider value={headNames?.toolUseId ?? null}>
          <div className="focused-step-body">{renderRows(segment.rows.filter(row => !isFocusedDeliverable(row)), false)}</div>
        </FocusedNamedCallContext.Provider>
      </FocusedDisclosure>
    </div>
    </FocusedCallClock>
  )
}

/** One call's words from its line; the verb is dressed by tone and never split from the target. */
function CallWords({ line, call, kind }: { line: FocusedCallLine; call: FocusedCall | null; kind: 'head' | 'row' | 'named' }) {
  const plain = kind === 'head' ? 'focused-step-verb' : ''
  const verbClass = line.verbTone === 'live' ? kind === 'head' ? `focused-step-verb${call?.preparing ? ' focused-live-verb' : ''}` : 'focused-live-verb'
    : line.verbTone === 'queued' ? 'focused-queued-verb' : line.verbTone === 'warn' ? 'focused-warn-verb' : plain
  const targetClass = line.targetFace === 'mono' ? 'focused-step-target' : 'focused-step-title'
  return <>
    {line.verb === ''
      ? <span className={verbClass || (kind === 'named' ? 'focused-step-verb' : '')}>{line.target}</span>
      : <><span className={verbClass}>{line.verb}</span>{' '}<span className={targetClass}>{line.target}</span></>}
    {line.detail ? <span className="focused-step-title"> · {line.detail}</span> : null}
    {call?.additions ? <span className="focused-diff-add"> +{call.additions}</span> : null}
    {call?.preparing ? <span className="focused-caret" /> : null}
  </>
}

function CallMeta({ call, line }: { call: FocusedCall; line: FocusedCallLine }) {
  const now = useContext(FocusedClockContext)
  if (line.phase === 'failed') return <span className="focused-meta focused-meta-fail">failed</span>
  if (call.status === 'pending' && call.activity && !call.preparing && !call.awaitingApproval) {
    const elapsed = now - call.activity.startedAt
    if (elapsed >= 2000) {
      const timeout = call.activity.timeoutMs ?? (typeof call.input.timeout === 'number' ? call.input.timeout : null)
      const limit = call.toolFamily === 'bash' && call.activity.phase === 'executing' && !call.input.run_in_background && timeout !== null && elapsed > timeout / 2
      return <span className="focused-meta">{duration(elapsed)}{limit ? <span className="focused-meta-limit"> of {duration(timeout).replace(/ 0s$/, '')}</span> : null}</span>
    }
  }
  return <BackgroundMeta background={line.background} />
}

/** A launch outlives its tool result, so a finished call can still be working. */
function BackgroundMeta({ background }: { background: FocusedCallLine['background'] }) {
  if (background === null) return null
  return background.state === 'running' ? <span className="focused-meta focused-meta-word">in background</span>
    : background.state === 'failed' ? <span className="focused-meta focused-meta-fail">failed</span>
    : <span className="focused-meta focused-meta-warn">stopped</span>
}

function LiveOutput({ call, className = '' }: { call: FocusedCall; className?: string }) {
  const now = useContext(FocusedClockContext)
  const activity = call.activity
  if (call.status !== 'pending' || activity?.phase !== 'executing' || now - activity.startedAt < 1500 || activity.output === undefined) return null
  const line = activity.output.replace(/\r\n/g, '\n').replace(/\n$/, '').split(/[\n\r]/).at(-1) ?? ''
  const n = activity.totalLines ?? 0
  const count = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  return <div className={`focused-live-out ${className}`}><FocusedTicker tickKey={call.toolUseId} className="">{line}</FocusedTicker><span className="focused-live-count">{count} lines</span></div>
}

function RollingCalls({ calls, callContext }: { calls: FocusedCall[]; callContext: FocusedCallContext }) {
  const [retained, setRetained] = useState(calls)
  const ids = calls.map(call => call.toolUseId).join(':')
  useEffect(() => {
    setRetained(previous => [...calls, ...previous.filter(call => !calls.some(next => next.toolUseId === call.toolUseId))])
    const timer = setTimeout(() => setRetained(calls), prefersReducedMotion() ? 0 : 220)
    return () => clearTimeout(timer)
  }, [ids])
  const ordered = [...calls, ...retained.filter(call => !calls.some(next => next.toolUseId === call.toolUseId))]
  return <div className="focused-calls">{ordered.map(call => {
    const present = calls.some(next => next.toolUseId === call.toolUseId)
    const line = focusedCallLine(call, callContext)
    return <div key={call.toolUseId} className={`focused-call ${present ? 'focused-call-enter' : 'focused-call-leave'}`} aria-hidden={!present}>
      <div><div className="focused-call-row">
        <span className={`focused-call-mark ${line.markClass}`} aria-hidden>{line.mark}</span>
        <FocusedTicker tickKey={`${call.toolUseId}:${line.phase}:${line.verb}`} className=""><CallWords line={line} call={call} kind="row" /></FocusedTicker>
        <AutoModeReviewMark review={call.autoModeReview} />
        <CallMeta call={call} line={line} />
      </div><LiveOutput call={call} /><AgentLatest call={call} callContext={callContext} /></div>
    </div>
  })}</div>
}

/** An agent that is not the step's head still says what it is doing, on one line under its row. */
function AgentLatest({ call, callContext }: { call: FocusedCall; callContext: FocusedCallContext }) {
  if (call.toolFamily !== 'agent' || call.status !== 'pending') return null
  const children = call.children.filter((row): row is Extract<NestedTranscriptRow, { kind: 'tool-use' }> => row.kind === 'tool-use' && !isPeerSpeechCall(row.toolName))
  const latest = children.at(-1)
  if (!latest) return null
  const line = focusedCallLine(latest, { ...callContext, signalled: false })
  return <div className="focused-live-out"><FocusedTicker tickKey={`${latest.toolUseId}:${line.phase}`} className="">{line.verb ? `${line.verb} ${line.target}` : line.target}</FocusedTicker>
    <span className="focused-live-count">{children.length} {children.length === 1 ? 'call' : 'calls'}</span></div>
}

function useLiveClock(live: boolean): number {
  const [, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const sync = () => {
      stop()
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
      // Elapsed labels use whole seconds. The 1.5s output gate can wait until
      // the next tick; stream updates still render independently of this clock.
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [live])
  // Prop updates need current time even while hidden or after the clock stops.
  return Date.now()
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

/** Failures, blocks and stops are told apart; `omit` drops the note a step's own verb already says. */
function FailureMark({ summary, omit = null }: { summary: FocusedSummary; omit?: 'failed' | 'stopped' | 'blocked' | null }) {
  const failed = omit === 'failed' ? 0 : summary.errorCount
  const blocked = omit === 'blocked' ? 0 : summary.blockedCount
  const stopped = omit === 'stopped' ? 0 : summary.stoppedCount
  const dot = summary.hasErrors && summary.errorCount === 0 && summary.blockedCount === 0 && summary.stoppedCount === 0
  return <>
    {failed > 0 ? <span className="focused-fail-note">{failed} failed</span> : null}
    {blocked > 0 ? <span className="focused-fail-note">{blocked} blocked</span> : null}
    {stopped > 0 ? <span className="focused-warn-note">{stopped} stopped</span> : null}
    {dot ? <span className="focused-status-dot" data-failed role="img" aria-label="A tool failed" /> : null}
  </>
}

function DiffTotals({ summary }: { summary: FocusedSummary }) {
  return summary.additions + summary.deletions > 0 ? <span className="focused-diff">
    {summary.additions > 0 ? <span className="focused-diff-add">+{summary.additions}</span> : null}
    {summary.deletions > 0 ? <span className="focused-diff-remove">−{summary.deletions}</span> : null}
  </span> : null
}

export function FocusedChevron() {
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
