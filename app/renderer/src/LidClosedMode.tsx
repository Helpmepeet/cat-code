import { useEffect, useState, type ReactNode } from 'react'
import { getBridge } from './bridge.js'
import { BannerStack, type BannerNotice } from './BannerStack.js'
import { LidClosedContext, useLidClosed } from './lidClosedState.js'
import type { LidModeCommand, LidModeView } from '../../shared/lidClosed.js'
import './lidClosed.css'

export function LidClosedProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LidModeView>({ phase: 'unavailable', activeSessions: 0, activeSubagents: 0, waitingForApproval: false, installed: false, sleepRequested: false })
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
  // The composer cup carries every other state. Only a real restore failure
  // needs a banner, because it asks the user to act.
  if (!lid || lid.view.phase !== 'unresolved') return null
  const { view: v, command } = lid
  const notice: BannerNotice = { id: 'lid-closed', tone: 'danger', title: "Couldn't restore normal sleep. Keep your Mac open and on your desk.",
    detail: v.error, dismissable: false, live: 'off',
    actions: [{ key: 'retry', label: v.repairRequired ? 'Repair and retry' : 'Retry', disabled: v.recovering }] }
  return <div className="lid-notice"><BannerStack banners={[notice]} onAction={(_banner, selected) => {
    command({ action: selected.key } as LidModeCommand)
  }} /></div>
}
