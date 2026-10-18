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

/**
 * Streaming form of `summarizeUsageTiming`. Model attempts must arrive grouped
 * by `callId` (any consistent order), which lets logical and retried calls be
 * counted without a per-call map. Duration samples stay numbers only.
 */
export function createUsageTimingAccumulator() {
  const modelOutcomes = emptyOutcomes()
  const toolOutcomes = emptyOutcomes()
  const responseDurations: number[] = []
  const firstTextDurations: number[] = []
  const toolDurations: number[] = []
  let started = 0
  let streamingAttempts = 0
  let logicalCalls = 0
  let retriedCalls = 0
  let toolsStarted = 0
  let currentCall: string | null = null
  let currentAttempts = 0
  return {
    addModel(attempt: MeasuredModelAttempt): void {
      if (attempt.callId !== currentCall) {
        currentCall = attempt.callId
        currentAttempts = 0
        logicalCalls++
      }
      if (++currentAttempts === 2) retriedCalls++
      started++
      modelOutcomes[attempt.outcome]++
      if (attempt.mode === 'streaming') {
        streamingAttempts++
        if (attempt.firstTextMs !== null) firstTextDurations.push(attempt.firstTextMs)
      }
      if (attempt.outcome === 'succeeded' && attempt.durationMs !== null) {
        responseDurations.push(attempt.durationMs)
      }
    },
    addTool(execution: MeasuredToolExecution): void {
      toolsStarted++
      toolOutcomes[execution.outcome]++
      if (execution.outcome === 'succeeded' && execution.durationMs !== null) {
        toolDurations.push(execution.durationMs)
      }
    },
    finish(): UsageTimingSummary {
      modelOutcomes.started = started
      toolOutcomes.started = toolsStarted
      return {
        models: {
          state: started > 0 ? 'available' : 'unavailable',
          logicalCalls,
          retriedCalls,
          streamingAttempts,
          outcomes: modelOutcomes,
          responseDuration: durationSummary(responseDurations),
          firstText: durationSummary(firstTextDurations),
        },
        tools: {
          state: toolsStarted > 0 ? 'available' : 'unavailable',
          outcomes: toolOutcomes,
          duration: durationSummary(toolDurations),
        },
      }
    },
  }
}

export function summarizeUsageTiming(
  models: readonly MeasuredModelAttempt[],
  tools: readonly MeasuredToolExecution[],
): UsageTimingSummary {
  const accumulator = createUsageTimingAccumulator()
  const grouped = [...models].sort((a, b) => (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0))
  for (const attempt of grouped) accumulator.addModel(attempt)
  for (const execution of tools) accumulator.addTool(execution)
  return accumulator.finish()
}

export const unavailableUsageTiming = (): UsageTimingSummary =>
  summarizeUsageTiming([], [])
