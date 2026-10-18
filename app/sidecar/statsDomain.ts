import type { UsageDiagnostic } from '../shared/usageDiagnostic.js'

/** Retained-history analytics collected by the independent usage worker. */
export async function collectUsageDashboard(options: {
  onDiagnostic?: (diagnostic: UsageDiagnostic) => void
  /** Test seam for failure mapping; production always uses the real aggregation. */
  aggregate?: typeof import('../../src/utils/stats.js').aggregateUsageDashboard
} = {}): Promise<import('../shared/usageDashboard.js').UsageCollectionResult> {
  const aggregateUsageDashboard = options.aggregate ?? (await import('../../src/utils/stats.js')).aggregateUsageDashboard
  const { publicCodeForFailure } = await import('../../src/utils/statsFailure.js')
  const { fitUsageDashboardSnapshot } = await import('./usageSummary.js')
  const { parseUsageCollectionResult } = await import('../shared/usageStatsWorker.js')
  const { usageDiagnosticFromError } = await import('../shared/usageDiagnostic.js')
  const startedAt = Date.now()
  const report = (diagnostic: UsageDiagnostic) => {
    // A failing diagnostic sink must never change the result.
    try { options.onDiagnostic?.(diagnostic) } catch { /* diagnostics are best effort */ }
  }
  try {
    const snapshot = await aggregateUsageDashboard(undefined, { finalize: fitUsageDashboardSnapshot })
    const result = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })
    if (result) return result
    report({ reason: 'unexpected', phase: 'finalize', elapsedMs: Date.now() - startedAt })
    return { type: 'error', version: 1, code: 'invalid-output' }
  } catch (error) {
    const diagnostic = usageDiagnosticFromError(error, Date.now() - startedAt)
    report(diagnostic)
    return { type: 'error', version: 1, code: publicCodeForFailure(diagnostic.reason) }
  }
}
