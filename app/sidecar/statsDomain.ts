/** Retained-history analytics collected by the independent usage worker. */
export async function collectUsageDashboard(): Promise<import('../shared/usageDashboard.js').UsageCollectionResult> {
  const { aggregateUsageDashboard } = await import('../../src/utils/stats.js')
  const { UsageResourceError } = await import('../../src/utils/statsUsage.js')
  const { fitUsageDashboardSnapshot } = await import('./usageSummary.js')
  const { parseUsageCollectionResult } = await import('../shared/usageStatsWorker.js')
  try {
    const snapshot = await aggregateUsageDashboard(undefined, { finalize: fitUsageDashboardSnapshot })
    return parseUsageCollectionResult({ type: 'usage', version: 1, snapshot }) ?? { type: 'error', version: 1, code: 'invalid-output' }
  } catch (error) {
    return { type: 'error', version: 1, code: error instanceof UsageResourceError || (error instanceof Error && /resource limit/.test(error.message)) ? 'resource-limit' : error instanceof Error && /timeout/i.test(error.message) ? 'timeout' : 'collection' }
  }
}
