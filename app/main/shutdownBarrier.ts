export type ShutdownResult = {
  confirmed: boolean
  unresolvedSessionIds: string[]
  persistenceConfirmed?: boolean
  restorationConfirmed?: boolean
}

export function shutdownFullyClean(result: ShutdownResult): boolean {
  return result.confirmed && result.persistenceConfirmed !== false && result.restorationConfirmed !== false
}

/** Failed cleanup must remain reachable through a fresh recovery UI. */
export function canReopenRuntime(result: ShutdownResult): boolean {
  return result.confirmed
}

export async function settleShutdownTasks(
  runtime: Promise<ShutdownResult>,
  helper: Promise<unknown>,
  workers: Promise<boolean>,
): Promise<ShutdownResult> {
  const [runtimeResult, helperResult, workersResult] = await Promise.allSettled([runtime, helper, workers])
  const result = runtimeResult.status === 'fulfilled' ? runtimeResult.value : { confirmed: false, unresolvedSessionIds: [] }
  const helperOutcome = helperResult.status === 'fulfilled' ? helperResult.value as
    { restorationConfirmed?: boolean; processConfirmed?: boolean } | undefined : undefined
  return {
    ...result,
    confirmed: result.confirmed && helperResult.status === 'fulfilled' && helperOutcome?.processConfirmed !== false &&
      workersResult.status === 'fulfilled' && workersResult.value,
    ...(helperOutcome?.restorationConfirmed === undefined ? {} : { restorationConfirmed: helperOutcome.restorationConfirmed }),
  }
}

/** Keep all normal exit routes on the same bounded runtime teardown. */
export function createShutdownBarrier(begin: () => Promise<ShutdownResult>, timeoutMs = 8_000): () => Promise<ShutdownResult> {
  let pending: Promise<ShutdownResult> | undefined
  return () => {
    if (pending) return pending
    let settle!: (result: ShutdownResult) => void
    pending = new Promise(resolve => { settle = resolve })
    let settled = false
    const finish = (result: ShutdownResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(result)
    }
    const timer = setTimeout(() => {
      finish({ confirmed: false, unresolvedSessionIds: [] })
    }, timeoutMs)
    // Publish the barrier before begin can synchronously re-enter teardown.
    try {
      void begin().then(finish, () => finish({ confirmed: false, unresolvedSessionIds: [] }))
    } catch {
      finish({ confirmed: false, unresolvedSessionIds: [] })
    }
    return pending
  }
}
