import type {
  UsageDurationSummary,
  UsageExecutionOutcome,
  UsageTimingOutcomes,
  UsageTimingSummary,
} from '../../app/shared/usageDashboard.js'

export type MeasuredModelAttempt = {
  callId: string
  mode: 'streaming' | 'non_streaming'
  outcome: UsageExecutionOutcome
  durationMs: number | null
  firstTextMs: number | null
}

export type MeasuredToolExecution = {
  outcome: UsageExecutionOutcome
  durationMs: number | null
}

const emptyOutcomes = (): UsageTimingOutcomes => ({
  started: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  incomplete: 0,
})

const durationSummary = (values: readonly number[]): UsageDurationSummary => {
  if (values.length === 0) return { samples: 0, p50Ms: null, p95Ms: null }
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (value: number) =>
    sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  }
}

const outcomes = (
  values: readonly { outcome: UsageExecutionOutcome }[],
): UsageTimingOutcomes => {
  const result = emptyOutcomes()
  result.started = values.length
  for (const value of values) result[value.outcome]++
  return result
}

export function summarizeUsageTiming(
  models: readonly MeasuredModelAttempt[],
  tools: readonly MeasuredToolExecution[],
): UsageTimingSummary {
  const callAttempts = new Map<string, number>()
  for (const attempt of models) {
    callAttempts.set(attempt.callId, (callAttempts.get(attempt.callId) ?? 0) + 1)
  }
  return {
    models: {
      state: models.length > 0 ? 'available' : 'unavailable',
      logicalCalls: callAttempts.size,
      retriedCalls: [...callAttempts.values()].filter(count => count > 1).length,
      streamingAttempts: models.filter(attempt => attempt.mode === 'streaming')
        .length,
      outcomes: outcomes(models),
      responseDuration: durationSummary(
        models.flatMap(attempt =>
          attempt.outcome === 'succeeded' && attempt.durationMs !== null
            ? [attempt.durationMs]
            : [],
        ),
      ),
      firstText: durationSummary(
        models.flatMap(attempt =>
          attempt.mode !== 'streaming' || attempt.firstTextMs === null
            ? []
            : [attempt.firstTextMs],
        ),
      ),
    },
    tools: {
      state: tools.length > 0 ? 'available' : 'unavailable',
      outcomes: outcomes(tools),
      duration: durationSummary(
        tools.flatMap(execution =>
          execution.outcome === 'succeeded' && execution.durationMs !== null
            ? [execution.durationMs]
            : [],
        ),
      ),
    },
  }
}

export const unavailableUsageTiming = (): UsageTimingSummary =>
  summarizeUsageTiming([], [])
