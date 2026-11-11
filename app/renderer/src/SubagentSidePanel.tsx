import { useLayoutEffect, useRef } from 'react'
import { AgentFace } from './AgentChrome.js'
import { SidePaneNavigation } from './SidePaneNavigation.js'
import { useAgentFaceRegistry } from './agentFace.js'
import { observePaneBottomLock, observePaneScroll } from './markdownScrollCoordinator.js'
import { selectPaneFollowIntent } from './paneAnchorModel.js'
import { formatModelDisplayName } from './statsState.js'
import { isSubagentDockTerminal, type SubagentDockRow } from './subagentDockState.js'
import { agentModelOf } from './transcriptAgent.js'
import { deriveTarget } from './transcriptToolTarget.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'
import './subagentSidePanel.css'

export function SubagentSidePanel({ worker, agent, steps, incomplete, cwd, onClose }: {
  worker: SubagentDockRow
  workers: SubagentDockRow[]
  agent: NestedToolUseRow | null
  steps: NestedTranscriptRow[]
  incomplete: boolean
  cwd: string | null
  onSwitch: (worker: SubagentDockRow) => void
  onClose: () => void
}) {
  const faces = useAgentFaceRegistry()
  const face = faces.faceFor(worker.agentId, worker.name)
  const terminal = isSubagentDockTerminal(worker.state)
  const model = (agent && agentModelOf(agent)) || worker.model
  const task = agent ? deriveTarget(agent) : worker.task
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previousTop = useRef(0)
  const close = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    close.current?.focus({ preventScroll: true })
    const element = scroll.current
    if (!element) return
    const pin = () => {
      if (!following.current) return
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      previousTop.current = element.scrollTop
    }
    pin()
    const releaseLock = observePaneBottomLock(element, () => following.current, top => { previousTop.current = top })
    const releaseScroll = observePaneScroll(element, pin)
    return () => { releaseLock(); releaseScroll() }
  }, [])

  useLayoutEffect(() => {
    const element = scroll.current
    if (element && following.current) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      previousTop.current = element.scrollTop
    }
  }, [steps, incomplete])

  return <aside className="subagent-side-panel" aria-label={`${worker.name || worker.task}, ${worker.state}`}>
    <header className="subagent-side-header">
      <SidePaneNavigation />
      <AgentFace axes={face.axes} fill={face.fill} size={19} />
      <div className="subagent-side-identity" title={task}>
        <div className="subagent-side-line">
          <span className="subagent-side-name">{worker.name ?? 'AGENT'}</span>
          {model ? <span className="subagent-side-model">{formatModelDisplayName(model)}</span> : null}
        </div>
      </div>
      <button ref={close} type="button" className="subagent-side-close" aria-label="Close subagent panel" onClick={onClose}>×</button>
    </header>
    <div ref={scroll} className="subagent-side-body" role="region" tabIndex={0} aria-label="Subagent steps"
      onScroll={event => {
        const element = event.currentTarget
        following.current = selectPaneFollowIntent({
          following: following.current, previousScrollTop: previousTop.current, scrollTop: element.scrollTop,
          gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        })
        previousTop.current = element.scrollTop
      }}>
      {incomplete ? <p className="subagent-side-availability">This agent's steps aren't fully loaded.</p> : null}
      {steps.length ? <TranscriptRowsView rows={steps} cwd={cwd} turnLive={!terminal} /> : null}
    </div>
  </aside>
}
