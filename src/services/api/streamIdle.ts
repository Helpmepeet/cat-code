export class StreamIdleError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Response stream was idle for ${timeoutMs}ms`)
    this.name = 'StreamIdleError'
  }
}

// Invalid settings cannot silently disable the body deadline.
export function streamIdleTimeoutMs(value = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS): number {
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : 90_000
}

/** Only pending network reads are timed, not time spent consuming local work. */
export async function* withStreamIdleDeadline<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  timeoutMs: number,
  cleanup: (error?: unknown) => void,
  cancellation: () => Error,
  lastNetworkProgress: () => number = () => 0,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let failure: unknown
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const readStarted = performance.now()
      try {
        const interrupted = new Promise<never>((_, reject) => {
          onAbort = () => reject(cancellation())
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          const checkIdle = () => {
            const remaining = timeoutMs - (performance.now() - Math.max(readStarted, lastNetworkProgress()))
            if (remaining > 0) timer = setTimeout(checkIdle, remaining)
            else reject(new StreamIdleError(timeoutMs))
          }
          timer = setTimeout(checkIdle, timeoutMs)
        })
        const next = await Promise.race([iterator.next(), interrupted])
        clearTimeout(timer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
        if (next.done) return
        yield next.value
      } finally {
        clearTimeout(timer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    cleanup(failure)
    // An uncooperative reader must not keep settlement waiting for return().
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
  }
}
