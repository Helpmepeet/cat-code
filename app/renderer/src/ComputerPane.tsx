import { useEffect, useMemo, useRef } from 'react'
import { SidePaneNavigation } from './SidePaneNavigation.js'
import { computerPicture, groupComputerSteps, type ComputerPicture, type ComputerStep } from './computerPaneModel.js'
import type { ComputerWindowCapture } from '../../shared/computerWindowCapture.js'
import './computerPane.css'

export function ComputerScreenIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
}

export function ComputerPane({ steps, captures, selectedId, onSelect, onClose, onStop, active = true, running = false, stopped = false, currentStepId }: {
  steps: readonly ComputerStep[]
  captures?: ReadonlyMap<string, ComputerWindowCapture>
  selectedId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  onStop?: () => void
  active?: boolean
  running?: boolean
  stopped?: boolean
  currentStepId?: string | null
}) {
  const groups = useMemo(() => groupComputerSteps(steps, captures), [steps, captures])
  const reverse = useMemo(() => [...steps].reverse(), [steps])
  const now = running ? reverse.find(step => step.status === 'pending' && (currentStepId === undefined || step.id === currentStepId)) : undefined
  const selected = steps.find(step => step.id === selectedId)
  const latest = reverse.find(step => step.status !== 'pending')
  const current = selected ?? now ?? latest
  const app = (now ?? latest)?.app
  let screen: ComputerPicture | null = null
  let denied = false
  for (let index = selected ? steps.indexOf(selected) : steps.length - 1; index >= 0; index--) {
    const step = steps[index]!
    const capture = captures?.get(step.id)
    denied ||= capture?.status === 'denied'
    screen = computerPicture(step, capture)
    if (screen) break
  }
  const currentRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) currentRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active, current?.id])
  return <section className="computer-pane" aria-label="Computer activity" hidden={!active}>
    <header className="computer-pane-header">
      <SidePaneNavigation />
      <div className="computer-pane-status">
        {(running || stopped) && <span className="computer-pane-live-dot" data-live={running || undefined} aria-hidden="true" />}
        <span className="computer-pane-status-text">{running ? (app ? `Using ${app}` : 'Using your Mac') : stopped ? 'Stopped' : 'Finished'}</span>
      </div>
      {running && onStop && <button type="button" className="computer-pane-stop" onClick={onStop}><i aria-hidden="true" />Stop</button>}
      <button type="button" className="computer-pane-icon" aria-label="Close computer panel" onClick={onClose}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    {screen ? <div className="computer-pane-screen">
      <img alt={screen.app ? `Screenshot of ${screen.app}` : 'Computer screenshot'} decoding="async" src={screen.src} />
    </div> : !denied && <div className="computer-pane-empty"><ComputerScreenIcon /><strong>{running ? 'Waiting for a screenshot' : 'No screenshot available'}</strong></div>}
    {(screen || selected) && <div className="computer-pane-caption">
      <span>{screen && (screen.app ?? 'Computer screenshot')}</span>
      {selected && <button type="button" className="computer-pane-latest" onClick={() => onSelect(null)}>Back to latest</button>}
    </div>}
    {denied && <div className="computer-pane-empty" role="status">
      {!screen && <ComputerScreenIcon />}
      <strong>Screen Recording is off for Cat Code</strong>
      <button type="button" className="computer-pane-latest" onClick={() => { void window.catcode?.openComputerCaptureSettings?.().catch(() => {}) }}>Open Privacy Settings</button>
    </div>}
    <div className="computer-pane-steps" aria-label="Computer steps">
      {groups.map(group => <div className="computer-pane-group" data-has-picture={group.picture ? true : undefined} key={group.steps[0]!.id}>
        {group.picture && <button type="button" className="computer-pane-thumbnail" aria-current={screen?.stepId === group.picture.stepId ? 'true' : undefined} aria-label={`Show screenshot: ${group.steps.find(step => step.id === group.picture?.stepId)?.title ?? 'Computer'}`}
          onClick={() => onSelect(group.picture!.stepId)}><img src={group.picture.src} alt="" loading="lazy" decoding="async" /></button>}
        <div className="computer-pane-group-rows">
          {group.steps.map(step => <button type="button" key={step.id} ref={step === current ? currentRef : undefined} className="computer-pane-step" aria-current={step === current ? 'true' : undefined} onClick={() => onSelect(step.id)}>
            <span className="computer-pane-dot" data-status={step.status === 'error' ? 'error' : step === now ? 'pending' : undefined} />
            <span className="computer-pane-step-text"><span>{step.title}</span>{step.status === 'error' && <span className="computer-pane-reason">{step.observation.trim().split('\n', 1)[0] || 'Step failed'}</span>}</span>
            {step === now && <span className="computer-pane-now">now</span>}
          </button>)}
        </div>
      </div>)}
    </div>
  </section>
}
