import { useEffect, useState, type ReactNode } from 'react'
import { getBridge } from './bridge.js'
import { BannerStack, type BannerNotice } from './BannerStack.js'
import { LidClosedContext, useLidClosed, lidReason } from './lidClosedState.js'
import type { LidModeCommand, LidModeView } from '../../shared/lidClosed.js'
import './lidClosed.css'

export function LidClosedProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LidModeView>({ phase: 'unavailable', allowance: 15, remainingSeconds: 0, installed: false, sleepRequested: false })
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
      setView(previous => ({ ...previous, phase: ['active','starting','restoring','unresolved'].includes(previous.phase) ? 'unresolved' : 'unavailable', error: 'The connection to Cat Code was lost.' }))
    })
  }
  return <LidClosedContext.Provider value={{ view, command, inspect: setInspecting }}>
    <div className="lid-shell" data-lid-inspecting={inspecting || undefined}>{children}</div>
  </LidClosedContext.Provider>
}

export function LidClosedNotice() {
  const lid = useLidClosed()
  if (!lid) return null
  const { view: v, command } = lid
  const notice: BannerNotice = { id: 'lid-closed', tone: 'info', title: 'Keep working with lid closed', dismissable: false, live: 'off' }
  const action = (key: string, label: string) => ({ key, label })
  switch (v.phase) {
    // The macOS administrator dialog is the whole first-use surface.
    case 'off': case 'setup': return null
    case 'starting': notice.title = 'Starting lid-closed mode.'; notice.actions = [action('cancel','Cancel')]; break
    case 'active':
      notice.title = `Keeping your Mac awake. ${Math.ceil(v.remainingSeconds / 60)} minutes left.`
      notice.actions = [action('stop','Stop')]; break
    case 'restoring': notice.title = 'Restoring normal sleep.'; notice.tone = 'warn'; break
    case 'unresolved': notice.title = "Couldn't restore normal sleep. Keep your Mac open and on your desk."; notice.detail = v.error; notice.tone = 'danger'; notice.actions = [{ ...action('retry', v.repairRequired ? 'Repair and retry' : 'Retry'), disabled: v.recovering }]; break
    case 'unavailable':
      if (!v.error) return null
      notice.title = v.error; notice.tone = 'warn'; notice.actions = [...(v.repairRequired ? [action('setup','Repair setup')] : []), action('dismiss','Dismiss')]; break
    case 'ended':
      // Stopping is the user's own action; only report endings they did not choose.
      if (v.reason === 'stopped' && !v.error) return null
      notice.title = lidReason(v.reason); notice.detail = v.error ? 'Sleep could not be confirmed. Check your Mac.' : undefined
      notice.tone = ['thermal','battery-reserve','monitoring-unavailable','supervision-lost'].includes(v.reason ?? '') ? 'warn' : 'info'
      notice.actions = [action('dismiss','Dismiss')]; break
  }
  return <div className="lid-notice"><BannerStack banners={[notice]} onAction={(_banner, selected) => {
    command({ action: selected.key } as LidModeCommand)
  }} /></div>
}
