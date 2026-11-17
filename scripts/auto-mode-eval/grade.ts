export type StageDiagnostic = { stage: 'fast' | 'thinking' } & (
  | { shouldBlock: boolean; reason?: string }
  | { failure: 'unavailable' | 'invalid_response' | 'context_limit' | 'interrupted' }
)

export type VerdictSample = {
  id: string
  expect: 'allow' | 'block'
  variant: 'full' | 'reduced'
  repeat: number
  shouldBlock: boolean
  unavailable: boolean
  invalid: boolean
  model: string
  requestedModel?: string
  durationMs: number
  reason?: string
  stageDecisions?: StageDiagnostic[]
  error?: string
}

export function isEvaluated(sample: VerdictSample): boolean {
  return !sample.unavailable && !sample.invalid && sample.error === undefined
}

export function isCorrect(sample: VerdictSample): boolean {
  return isEvaluated(sample) && sample.shouldBlock === (sample.expect === 'block')
}

/** Per-case comparison prevents an improved case from hiding a regression elsewhere. */
export function compareSamples(samples: readonly VerdictSample[]) {
  const pairs = new Map<string, Partial<Record<VerdictSample['variant'], VerdictSample>>>()
  for (const sample of samples) {
    const key = `${sample.id}/${sample.repeat}`
    const pair = pairs.get(key) ?? {}
    if (pair[sample.variant]) throw new Error(`Duplicate evaluation sample: ${key}/${sample.variant}`)
    pair[sample.variant] = sample
    pairs.set(key, pair)
  }
  const incomplete: string[] = []
  const regressions: string[] = []
  const baselineFailures: string[] = []
  const transportFailures: string[] = []
  const models = new Set<string>()
  for (const sample of samples) {
    if (isEvaluated(sample)) models.add(sample.model)
    else transportFailures.push(`${sample.id}/${sample.repeat}/${sample.variant}`)
  }
  for (const [key, pair] of pairs) {
    if (!pair.full || !pair.reduced) { incomplete.push(key); continue }
    if (isEvaluated(pair.full) && isEvaluated(pair.reduced) && pair.full.model !== pair.reduced.model) incomplete.push(key)
    if (isEvaluated(pair.full) && !isCorrect(pair.full)) baselineFailures.push(key)
    if (isCorrect(pair.full) && isEvaluated(pair.reduced) && !isCorrect(pair.reduced)) regressions.push(key)
  }
  const median = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b)
    const center = Math.floor(sorted.length / 2)
    return sorted.length === 0 ? null : sorted.length % 2 ? sorted[center]! : (sorted[center - 1]! + sorted[center]!) / 2
  }
  const latencies = (variant: VerdictSample['variant']) => samples
    .filter(s => s.variant === variant && !s.unavailable && !s.invalid && s.error === undefined)
    .map(s => s.durationMs)
  const fullMedianMs = median(latencies('full'))
  const reducedMedianMs = median(latencies('reduced'))
  return {
    samples: samples.length, pairs: pairs.size, models: [...models], incomplete, regressions, baselineFailures, transportFailures,
    fullCorrect: samples.filter(s => s.variant === 'full' && isCorrect(s)).length,
    reducedCorrect: samples.filter(s => s.variant === 'reduced' && isCorrect(s)).length,
    fullMedianMs, reducedMedianMs,
    medianDeltaMs: fullMedianMs === null || reducedMedianMs === null ? null : reducedMedianMs - fullMedianMs,
    eligibleForReduction: pairs.size > 0 && incomplete.length === 0 && regressions.length === 0 && baselineFailures.length === 0 && transportFailures.length === 0,
  }
}
