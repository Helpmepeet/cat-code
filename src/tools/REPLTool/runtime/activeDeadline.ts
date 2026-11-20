/** Counts runnable wall time. A suspended owner retains its remaining budget. */
export function activeDeadline(durationMs: number, onExpiry: () => void) {
  let remaining = durationMs
  let began: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  function dispose() {
    ended = true
    began = undefined
    clearTimeout(timer)
    timer = undefined
  }
  function expire() {
    if (ended) return
    dispose()
    onExpiry()
  }
  return {
    pause(): boolean {
      if (began === undefined) return !ended
      remaining -= performance.now() - began
      began = undefined
      clearTimeout(timer)
      timer = undefined
      // The worker acknowledgement can win the event-loop race with an
      // already-due timer. It still cannot extend an exhausted budget.
      if (remaining <= 0) expire()
      return !ended
    },
    resume() {
      if (ended || began !== undefined) return
      began = performance.now()
      timer = setTimeout(() => { if (began !== undefined) expire() }, remaining)
    },
    dispose,
  }
}
