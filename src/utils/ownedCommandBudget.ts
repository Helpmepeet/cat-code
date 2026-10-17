/**
 * A single monotonic deadline shared by sequential and concurrent probes.
 * Callers must dispose it, including after successful completion.
 */
export type OwnedCommandBudget = ReturnType<typeof createOwnedCommandBudget>

export function createOwnedCommandBudget(totalMs: number) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) throw new Error('Invalid command budget')
  const controller = new AbortController()
  const deadline = performance.now() + totalMs
  const timer = setTimeout(() => controller.abort(), totalMs)
  return {
    signal: controller.signal,
    throwIfExpired() {
      if (performance.now() >= deadline) controller.abort()
      if (controller.signal.aborted) throw new Error('Installation checks cancelled or timed out')
    },
    commandOptions() {
      const remaining = Math.max(0, deadline - performance.now())
      if (remaining === 0) controller.abort()
      return {
        abortSignal: controller.signal,
        timeout: Math.max(1, Math.ceil(remaining)),
        killProcessGroupOnTimeout: true,
        killProcessGroupOnAbort: true,
      }
    },
    dispose() {
      clearTimeout(timer)
      controller.abort()
    },
  }
}
