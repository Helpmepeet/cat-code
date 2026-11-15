import { useCallback, useSyncExternalStore } from 'react'

type Selection = { line: number; token: number }
const selections = new Map<string, Selection>()
const listeners = new Map<string, Set<() => void>>()
/** Retained across pane unmounts, but never shared across forked sessions. */
export function selectCodeModeLine(sessionId: string, cellId: string, line: number): void {
  const key = JSON.stringify([sessionId, cellId])
  if (!Number.isSafeInteger(line) || line < 1 || selections.get(key)?.line === line) return
  selections.set(key, { line, token: (selections.get(key)?.token ?? 0) + 1 })
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
