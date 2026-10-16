import { useEffect, useState } from 'react'
import type { HostResult, WorkspaceBranchObservation } from '../../shared/hostApi.js'

export type WorkspaceBranchReadout = { name: string; previous: string | null }

/** Git observation never advances the conversation's working-branch baseline. */
export function useWorkspaceBranch(
  enabled: boolean,
  list: () => Promise<HostResult<WorkspaceBranchObservation>>,
  recordedBranch: string | null,
): WorkspaceBranchReadout | null {
  const [observation, setObservation] = useState<WorkspaceBranchObservation | null>(null)
  useEffect(() => {
    setObservation(null)
    if (!enabled) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const result = await list()
        if (active && result.ok) setObservation(result.value)
        else if (active && !result.ok && result.error.message.includes('not a Git repository')) setObservation(null)
      } catch (error) {
        // A temporary read failure must not replace a known branch with a different fact.
        console.warn('Could not refresh Git branch.', error)
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled, list])
  if (!enabled || !observation) return null
  const name = observation.current ?? observation.detached ?? 'Detached'
  const previous = observation.recordedBranch === undefined ? recordedBranch : observation.recordedBranch
  return { name, previous: previous && previous !== name ? previous : null }
}
