import { readSubagentDockObservation, commitSubagentDockObservation, persistSubagentDockObservation } from './subagentDockObservation.js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createSubagentDockState, reconcileSubagentDockState, selectSubagentDock,
  isSubagentDockTerminal, type SubagentDockInput, type SubagentDockState } from './subagentDockState.js'
import { readSubagentDockSessionsFromStorage, writeSubagentDockSessionsToStorage,
  type SubagentDockClearMarker } from './subagentDockPersistence.js'
import { defaultViewPreferenceStorage } from './viewPreference.js'

/** Pane-local observation state; only terminal display evidence crosses reload. */
export function useSubagentDock(sessionId: string | null, durableId: string | null,
  sources: Omit<SubagentDockInput, 'nowMs' | 'clearMarkers' | 'reducedMotion'>) {
  const storage = defaultViewPreferenceStorage()
  const key = durableId ?? sessionId
  const observed = useRef<{ sessionId: string | null; key: string | null; state: SubagentDockState; cleared: SubagentDockClearMarker[] } | null>(null)
  const [, redraw] = useState(0)
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => setReducedMotion(media.matches)
    media.addEventListener?.('change', changed)
    return () => media.removeEventListener?.('change', changed)
  }, [])
  let previous = observed.current
  if (!previous || previous.sessionId !== sessionId) {
    const saved = readSubagentDockSessionsFromStorage(storage) ?? {}
    const history = key ? saved[key] ?? (sessionId ? saved[sessionId] : undefined) : undefined
    previous = { sessionId, key, state: createSubagentDockState(history?.finished), cleared: history?.cleared ?? [] }
  }
  const persistencePreviousKey = previous.key !== null && previous.key !== key ? previous.key : sessionId
  const input: SubagentDockInput = { ...sources, nowMs: Date.now(), clearMarkers: previous.cleared, reducedMotion }
  const baseline = sessionId && key ? readSubagentDockObservation(sessionId, key, storage)
    ?? readSubagentDockObservation(sessionId, sessionId, storage) ?? previous.state : previous.state
  const state = reconcileSubagentDockState(baseline, input)
  const dock = selectSubagentDock(state, input)
  useLayoutEffect(() => {
    const committed = sessionId && key ? commitSubagentDockObservation(sessionId, key, state, storage, previous.key) : state
    observed.current = { sessionId, key, state: committed, cleared: input.clearMarkers ? [...input.clearMarkers] : [] }
  })
  useEffect(() => {
    if (!key) return
    persistSubagentDockObservation(storage, key, observed.current?.state ?? state, persistencePreviousKey)
  }, [key, storage, state, persistencePreviousKey])
  useEffect(() => {
    if (dock.nextUpdateAt === null) return
    const timer = setTimeout(() => redraw(value => value + 1), Math.max(1, dock.nextUpdateAt - Date.now()))
    return () => clearTimeout(timer)
  }, [dock.nextUpdateAt])
  useEffect(() => {
    if (!detailsVisible) return
    const timer = setInterval(() => redraw(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [detailsVisible])
  const clearFinished = useCallback(() => {
    const current = observed.current
    if (!current || !key) return
    const markers = [...current.cleared, ...dock.finished.map(row => ({ agentId: row.agentId, runKey: row.runKey }))]
    current.cleared = markers
    const saved = readSubagentDockSessionsFromStorage(storage) ?? {}
    saved[key] = { cleared: markers, finished: Object.values(current.state.entries).filter(entry => isSubagentDockTerminal(entry.state)) }
    writeSubagentDockSessionsToStorage(storage, saved)
    redraw(value => value + 1)
  }, [dock.finished, key, storage])
  return { dock, clearFinished, setDetailsVisible }
}
