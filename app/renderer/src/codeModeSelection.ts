import { useCallback, useSyncExternalStore } from 'react'

type Selection = { line: number; token: number; revealToken: number }
const selections = new Map<string, Selection>()
const listeners = new Map<string, Set<() => void>>()
/** Retained across pane unmounts, but never shared across forked sessions. */
export function selectCodeModeLine(sessionId: string, cellId: string, line: number): void {
  updateSelection(sessionId, cellId, line, false)
}
/** An explicit transcript action reveals source even for the same selected line. */
export function revealCodeModeLine(sessionId: string, cellId: string, line: number): void {
  updateSelection(sessionId, cellId, line, true)
}
function updateSelection(sessionId: string, cellId: string, line: number, reveal: boolean): void {
  const key = JSON.stringify([sessionId, cellId])
  const previous = selections.get(key)
  if (!Number.isSafeInteger(line) || line < 1 || !reveal && previous?.line === line) return
  selections.set(key, { line, token: (previous?.token ?? 0) + 1, revealToken: (previous?.revealToken ?? 0) + (reveal ? 1 : 0) })
  for (const notify of listeners.get(key) ?? []) notify()
}
export function useCodeModeSelection(sessionId: string, cellId: string): Selection | undefined {
  const key = JSON.stringify([sessionId, cellId])
  const subscribe = useCallback((notify: () => void) => {
    let group = listeners.get(key)
    if (!group) { group = new Set(); listeners.set(key, group) }
    group.add(notify)
    return () => { group.delete(notify); if (!group.size) listeners.delete(key) }
  }, [key])
  return useSyncExternalStore(subscribe, useCallback(() => selections.get(key), [key]), () => undefined)
}
