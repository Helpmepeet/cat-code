import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { getBridge } from './bridge.js'
import { BannerStack, type BannerNotice } from './BannerStack.js'
import { isNormalLidEnding, LID_SELECTION_DELAY_MS, lidPreview, LidClosedContext, useLidClosed } from './lidClosedState.js'
import type { LidModeCommand, LidModeView, LidTarget } from '../../shared/lidClosed.js'
import './lidClosed.css'

export function LidClosedProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LidModeView>({ phase: 'unavailable', mode: null, allowance: 0, remainingSeconds: 0, workAvailable: false, activeSessions: 0, activeSubagents: 0, waitingForApproval: false, installed: false, sleepRequested: false })
  const [choice, setChoice] = useState<{ target: LidTarget; version: number } | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const alive = useRef(true)
  const revision = useRef(0)
  const requests = useRef(0)
  const version = useRef(0)
  const selection = useRef<typeof choice>(null)
  const unsent = useRef<typeof choice>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reading = useRef<Promise<LidModeView> | null>(null)
  const cancelSelection = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    unsent.current = null
    selection.current = null
    if (alive.current) setChoice(null)
  }, [])
  const send = useCallback((value: LidModeCommand, selected?: NonNullable<typeof choice>) => {
    const requestId = ++requests.current
    const at = ++revision.current
    const bridge = getBridge()?.lidClosed
    const request = bridge ? bridge.command(value) : Promise.reject(new Error('Unavailable'))
    void request.then(reply => {
      if (!alive.current) return
      if (reply && at === revision.current) setView(reply)
      if (selected && selection.current?.version === selected.version) {
        selection.current = null
        setChoice(null)
      }
    }).catch(() => {
      if (!alive.current || requestId !== requests.current) return
      cancelSelection()
      setView(previous => ({ ...previous, phase: (value.action === 'set' && value.target !== 'off') ||
        ['active','starting','restoring','unresolved'].includes(previous.phase) ? 'unresolved' : 'unavailable',
        error: 'The connection to Cat Code was lost.' }))
    })
  }, [cancelSelection])
  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    const selected = unsent.current
    unsent.current = null
    if (selected) send({ action: 'set', target: selected.target }, selected)
  }, [send])
  const refresh = useCallback(() => {
    const bridge = getBridge()?.lidClosed
    if (!bridge) return
    const request = reading.current ?? bridge.read()
    reading.current = request
    const at = revision.current
    void request.then(value => { if (alive.current && at === revision.current && value) setView(value) })
      .catch(() => {}).finally(() => { if (reading.current === request) reading.current = null })
  }, [])
  useEffect(() => {
    alive.current = true
    const bridge = getBridge()?.lidClosed
    const unsubscribe = bridge?.subscribe(value => {
      revision.current++
      if (!alive.current) return
      if (value.phase === 'unresolved' || value.phase === 'ended' && !isNormalLidEnding(value.reason)) cancelSelection()
      setView(value)
    })
    refresh()
    return () => { alive.current = false; revision.current++; flush(); unsubscribe?.() }
  }, [cancelSelection, flush, refresh])
  const command = (value: LidModeCommand) => {
    cancelSelection()
    send(value)
  }
  const select = (target: LidTarget) => {
    const selected = { target, version: ++version.current }
    selection.current = selected
    unsent.current = selected
    setChoice(selected)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(flush, LID_SELECTION_DELAY_MS)
  }
  const inspect = (value: boolean) => { setInspecting(value); if (value) refresh() }
  return <LidClosedContext.Provider value={{ view: choice ? lidPreview(view, choice.target) : view, command, select, flush, inspect }}>
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
