import { useEffect, useRef } from 'react'
import { selectComputerStep, type ComputerStep } from './computerPaneModel.js'
import './computerPane.css'

export function ComputerScreenIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
}

export function ComputerPane({ steps, selectedId, onSelect, onClose, active = true, running = false }: {
  steps: readonly ComputerStep[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  active?: boolean
  running?: boolean
}) {
  const selected = selectComputerStep(steps, selectedId)
  const index = selected ? steps.indexOf(selected) : -1
  const currentRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) currentRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active, selected?.id])
  return <section className="computer-pane" aria-label="Computer screenshots" hidden={!active}>
    <header className="computer-pane-header">
      <button type="button" className="computer-pane-icon" aria-label="Previous computer step" disabled={index <= 0} onClick={() => onSelect(steps[index - 1]!.id)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg></button>
      <button type="button" className="computer-pane-icon" aria-label="Next computer step" disabled={index < 0 || index >= steps.length - 1} onClick={() => onSelect(steps[index + 1]!.id)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg></button>
      <div className="computer-pane-title" title={selected?.title}>{selected?.title ?? 'Computer'}</div>
      <span className="computer-pane-count">{index + 1} of {steps.length}</span>
      {selectedId !== null && <button type="button" className="computer-pane-latest" onClick={() => onSelect(null)}>Latest</button>}
      <button type="button" className="computer-pane-icon" aria-label="Close computer panel" onClick={onClose}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <div className="computer-pane-screen" data-agent={active && running && selectedId === null || undefined}>
      {selected?.image ? <img alt={`Screenshot: ${selected.title}`} decoding="async" src={`data:${selected.image.mediaType};base64,${selected.image.data}`} /> : <p className="computer-pane-empty">{selected?.status === 'pending' ? 'Waiting for a screenshot.' : 'No screenshot captured.'}</p>}
    </div>
    <div className="computer-pane-steps" aria-label="Computer steps">
      {steps.map((step, i) => <button type="button" key={step.id} ref={step.id === selected?.id ? currentRef : undefined} className="computer-pane-step" aria-current={step.id === selected?.id ? 'true' : undefined} onClick={() => onSelect(step.id)}>
        <span className="computer-pane-dot" data-status={step.status} aria-label={step.status} />
        <span className="computer-pane-step-title">{step.title}</span><span className="computer-pane-count">{i + 1}</span>
      </button>)}
    </div>
  </section>
}
