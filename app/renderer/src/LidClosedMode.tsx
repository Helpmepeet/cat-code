import { useEffect, useState, type ReactNode } from 'react'
import { getBridge } from './bridge.js'
import { BannerStack, type BannerNotice } from './BannerStack.js'
import { LidClosedContext, useLidClosed, lidReason } from './lidClosedState.js'
import type { LidModeCommand, LidModeView } from '../../shared/lidClosed.js'
import './lidClosed.css'

export function LidClosedProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LidModeView>({ phase: 'unavailable', allowance: 15, remainingSeconds: 0, included: [], currentRuns: {}, canContinue: false, installed: false, sleepRequested: false })
  const [inspecting, setInspecting] = useState(false)
  useEffect(() => {
    const bridge = getBridge()?.lidClosed
    if (!bridge) return
    let alive = true; let observed = false
    const unsubscribe = bridge.subscribe(value => { observed = true; if (alive) setView(value) })
    void bridge.read().then(value => { if (alive && !observed && value) setView(value) }).catch(() => {})
    return () => { alive = false; unsubscribe() }
  }, [])
  const command = (value: LidModeCommand) => {
    void getBridge()?.lidClosed?.command(value).catch(() => {
      setView(previous => ({ ...previous, phase: ['active','starting','restoring','unresolved'].includes(previous.phase) ? 'unresolved' : 'unavailable', canContinue: false, error: 'The connection to Cat Code was lost.' }))
    })
  }
  return <LidClosedContext.Provider value={{ view, command, inspect: setInspecting }}>
    <div className="lid-shell" data-lid-inspecting={inspecting || undefined}>{children}</div>
  </LidClosedContext.Provider>
}

export function LidClosedNotice({ currentSessionId, onSelect }: { currentSessionId: string | null; onSelect(id: string): void }) {
  const lid = useLidClosed()
  const [expanded, setExpanded] = useState(false)
  if (!lid) return null
  const { view: v, command } = lid
  const notice: BannerNotice = { id: 'lid-closed', tone: 'info', title: 'Keep working with lid closed', dismissable: false, live: 'off' }
  const action = (key: string, label: string) => ({ key, label })
  const time = `${v.allowance} minutes total; ${Math.ceil(v.remainingSeconds / 60)} minutes remaining.`
  switch (v.phase) {
    case 'off': return null
    case 'setup':
      notice.title = 'Keep it on a hard surface. Never in a bag.'
      notice.detail = 'Administrator setup is required. Ordinary macOS Sleep can be blocked while this mode is active; use End mode and sleep. Use no other utility that changes the global sleep override: simultaneous writes cannot be reliably distinguished. Recovery depends on the helper and macOS responding.'
      notice.actions = [action('setup', 'Set up and start'), action('cancel', 'Cancel')]; break
    case 'starting': notice.title = 'Starting lid-closed mode.'; notice.actions = [action('cancel','Cancel')]; break
    case 'active':
      notice.title = `Covers ${v.included.length} ${v.included.length === 1 ? 'run' : 'runs'} selected at activation across chats.`
      notice.detail = 'Ordinary Sleep may be blocked.'
      if (currentSessionId && v.currentRuns[currentSessionId] && !v.included.some(run => run.id === v.currentRuns[currentSessionId])) notice.detail += ' This run is not included.'
      notice.actions = [action('stop','Stop'), action('sleep','End mode and sleep'), action('inspect', expanded ? 'Hide work' : 'Inspect work')]; break
    case 'restoring': notice.title = 'Restoring normal sleep.'; notice.tone = 'warn'; break
    case 'unresolved': notice.title = "Couldn't restore normal sleep. Keep your Mac open and on your desk."; notice.detail = v.error; notice.tone = 'danger'; notice.actions = [{ ...action('retry', v.repairRequired ? 'Repair and retry' : 'Retry'), disabled: v.recovering }]; break
    case 'lid-open':
      notice.title = lidReason('lid-open'); notice.detail = time
      notice.actions = v.canContinue ? [action('continue','Continue with lid closed'), action('dismiss','Dismiss')] : [action('dismiss','Dismiss')]; break
    case 'unavailable':
      if (!v.error) return null
      notice.title = v.error; notice.tone = 'warn'; notice.actions = [...(v.repairRequired ? [action('setup','Repair setup')] : []), action('dismiss','Dismiss')]; break
    case 'ended':
      notice.title = lidReason(v.reason); notice.detail = v.error ? 'Sleep could not be confirmed. Check your Mac.' : undefined
      notice.tone = ['thermal','battery-reserve','monitoring-unavailable','supervision-lost'].includes(v.reason ?? '') ? 'warn' : 'info'
      notice.actions = [action('dismiss','Dismiss')]; break
  }
  notice.content = <>
    {v.phase === 'active' ? <p className="lid-time-detail">{time} Ticks mark 15, 30, 60, and 120 minutes.</p> : null}
    {expanded && ['active','lid-open'].includes(v.phase) ? <ul className="lid-work-list">
      {v.included.map(run => <li key={run.id}>
        <button type="button" onClick={() => onSelect(run.sessionId)}>{run.title}</button>
        <span> {run.status === 'approval' ? 'Waiting for approval' : run.status === 'provider' ? 'Waiting for a connection' : run.status}. {run.status === 'completed' ? 'No longer keeps the mode active.' : 'Included.'}</span>
        {run.children.length ? <ul>{run.children.map(child => <li key={child.id}>{child.label}: {child.status}</li>)}</ul> : null}
      </li>)}
    </ul> : null}
  </>
  return <div className="lid-notice" data-expanded={expanded || undefined}><BannerStack banners={[notice]} onAction={(_banner, selected) => {
    if (selected.key === 'inspect') setExpanded(value => !value)
    else command({ action: selected.key } as LidModeCommand)
  }} /></div>
}
