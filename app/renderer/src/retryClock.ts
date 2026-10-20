// Wall time is presentation state, not part of deterministic transcript replay.
const deadlines = new WeakMap<object, number>()

export function observeRetryWait(retry: { delayMs: number; replay: boolean }, now = Date.now()): void {
  if (!retry.replay && retry.delayMs > 0 && !deadlines.has(retry)) {
    deadlines.set(retry, now + retry.delayMs)
  }
}

export function retryWaitSeconds(retry: object, now = Date.now()): number | null {
  const deadline = deadlines.get(retry)
  return deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000))
}
