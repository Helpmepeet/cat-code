import {
  runCleanupFunctionsSettled,
  type CleanupRunResult,
} from '../../src/utils/cleanupRegistry.js'

export const SIDECAR_CLEANUP_DEADLINE_MS = 1_500

type SidecarCleanupDiagnostic = {
  reason: 'cleanup_timeout' | 'cleanup_rejected'
  count?: number
}

export type SidecarCleanup = {
  exit(code: number): Promise<void>
}

export function createSidecarCleanup({
  disposeMcpLifecycle,
  closeSocket,
  releaseTranscriptLease,
  onDiagnostic,
  exit,
  runRegisteredCleanup = runCleanupFunctionsSettled,
  deadlineMs = SIDECAR_CLEANUP_DEADLINE_MS,
}: {
  disposeMcpLifecycle: () => Promise<void>
  closeSocket: () => void
  releaseTranscriptLease: () => Promise<void>
  onDiagnostic: (diagnostic: SidecarCleanupDiagnostic) => void
  exit: (code: number) => void
  runRegisteredCleanup?: () => Promise<CleanupRunResult>
  deadlineMs?: number
}): SidecarCleanup {
  let exitPromise: Promise<void> | undefined

  const runCleanup = async (): Promise<void> => {
    const deadlineAt = Date.now() + deadlineMs
    const settleBeforeDeadline = async <T>(
      cleanup: Promise<T>,
    ): Promise<
      | { timedOut: true }
      | { timedOut: false; status: 'fulfilled'; value: T }
      | { timedOut: false; status: 'rejected' }
    > => {
      const remainingMs = Math.max(0, deadlineAt - Date.now())
      let timeout: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        cleanup.then(
          value => ({ value, timedOut: false as const, status: 'fulfilled' as const }),
          () => ({ timedOut: false as const, status: 'rejected' as const }),
        ),
        new Promise<{ timedOut: true }>(resolve => {
          timeout = setTimeout(() => resolve({ timedOut: true }), remainingMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      return settled
    }

    let rejected = 0
    let lifecycleCleanup: Promise<void>
    try {
      lifecycleCleanup = Promise.resolve(disposeMcpLifecycle())
    } catch (error) {
      lifecycleCleanup = Promise.reject(error)
    }
    try {
      closeSocket()
    } catch {
      rejected++
    }
    let registeredCleanup: Promise<CleanupRunResult>
    try {
      registeredCleanup = Promise.resolve(runRegisteredCleanup())
    } catch (error) {
      registeredCleanup = Promise.reject(error)
    }
    const cleanupWork = Promise.allSettled([
      lifecycleCleanup,
      registeredCleanup,
    ])
    const settled = await settleBeforeDeadline(cleanupWork)

    if (settled.timedOut) {
      onDiagnostic({ reason: 'cleanup_timeout' })
    } else if (settled.status === 'rejected') {
      rejected++
    } else {
      const [lifecycleResult, registryResult] = settled.value
      if (lifecycleResult?.status === 'rejected') {
        rejected++
      }
      if (registryResult?.status === 'rejected') {
        rejected++
      } else if (registryResult?.status === 'fulfilled') {
        rejected += registryResult.value.rejected
      }
    }

    let leaseRelease: Promise<void>
    try {
      leaseRelease = Promise.resolve(releaseTranscriptLease())
    } catch (error) {
      leaseRelease = Promise.reject(error)
    }
    const leaseResult = await settleBeforeDeadline(leaseRelease)
    if (leaseResult.timedOut) {
      if (!settled.timedOut) {
        onDiagnostic({ reason: 'cleanup_timeout' })
      }
    } else if (leaseResult.status === 'rejected') {
      rejected++
    }
    if (rejected > 0) {
      onDiagnostic({ reason: 'cleanup_rejected', count: rejected })
    }
  }

  return {
    exit(code) {
      if (!exitPromise) {
        exitPromise = runCleanup().then(() => {
          exit(code)
        })
      }
      return exitPromise
    },
  }
}
