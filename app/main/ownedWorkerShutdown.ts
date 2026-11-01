import type { WorkerProcessLifecycle } from './ndjsonWorker.js'

/** Tracks process instances, never reusable PIDs, until an exit is confirmed. */
export function createOwnedWorkerShutdownTracker() {
  const live = new Map<string, number>()
  const listeners = new Set<() => void>()
  return {
    observe(instance: string, event: WorkerProcessLifecycle) {
      if (event.phase === 'started' && event.pid > 0) live.set(instance, event.pid)
      if (event.phase === 'exited') live.delete(instance)
      for (const listener of listeners) listener()
    },
    waitForExit(timeoutMs = 4_500): Promise<boolean> {
      return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (confirmed: boolean) => {
          clearTimeout(timer)
          listeners.delete(check)
          resolve(confirmed)
        }
        const check = () => { if (live.size === 0) finish(true) }
        listeners.add(check)
        timer = setTimeout(() => finish(false), timeoutMs)
        check()
      })
    },
    pendingPids(): number[] { return [...live.values()] },
  }
}
