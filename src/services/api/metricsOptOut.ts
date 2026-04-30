/**
 * Metrics opt-out check is intentionally disabled.
 *
 * This file preserves the exported function signature so that any transitive
 * imports don't break. Always returns metrics disabled.
 */

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  return { enabled: false, hasError: false }
}

export const _clearMetricsEnabledCacheForTesting = (): void => {}
