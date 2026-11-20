import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ComputerWindowCapture } from '../../shared/computerWindowCapture.js'
import type { ComputerStep } from './computerPaneModel.js'

const LIMIT = 40
const empty: ReadonlyMap<string, ComputerWindowCapture> = new Map()
const sessions = new Map<string, ReadonlyMap<string, ComputerWindowCapture>>()
const order = new Map<string, { session: string; step: string }>()
const listeners = new Set<() => void>()
let queue = Promise.resolve()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function publish(session: string, step: string, capture: ComputerWindowCapture) {
  if (capture.status === 'unavailable') return
  const key = JSON.stringify([session, step])
  const next = new Map(sessions.get(session))
  next.set(step, capture)
  sessions.set(session, next)
  order.set(key, { session, step })
  if (order.size > LIMIT) {
    const [oldKey, old] = order.entries().next().value!
    order.delete(oldKey)
    const remaining = new Map(sessions.get(old.session))
    remaining.delete(old.step)
    if (remaining.size) sessions.set(old.session, remaining)
    else sessions.delete(old.session)
  }
  for (const listener of listeners) listener()
}

export function useComputerWindowCaptures(session: string | undefined, steps: readonly ComputerStep[], live: boolean) {
  const tracker = useRef<{ session: string | undefined; live: boolean; known: Set<string> } | null>(null)
  const captures = useSyncExternalStore(subscribe, () => sessions.get(session ?? '') ?? empty, () => empty)
  useEffect(() => {
    const previous = tracker.current
    tracker.current = { session, live, known: new Set(steps.filter(step => step.status !== 'pending').map(step => step.id)) }
    const read = window.catcode?.captureComputerWindow
    if (!session || !read || previous?.session !== session || (!live && !previous.live)) return
    // Only append or settle work seen during a live run, not history prepended by paging.
    const firstKnown = steps.findIndex(step => previous.known.has(step.id))
    for (const step of steps.slice(Math.max(0, firstKnown))) {
      const app = step.app
      if (!app || (step.status !== 'success' && step.status !== 'error') || previous.known.has(step.id)) continue
      queue = queue.then(async () => {
        try { publish(session, step.id, await read({ app })) } catch { /* Screenshot fallback remains available. */ }
      })
    }
  }, [session, steps, live])
  return captures
}
