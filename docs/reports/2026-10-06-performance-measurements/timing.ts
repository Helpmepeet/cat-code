/** Shared sample handling. Every case keeps its raw samples next to the summary. */

export type CaseResult = {
  name: string
  params: Record<string, unknown>
  /** One entry per scored repetition, in milliseconds. */
  samplesMs: number[]
  medianMs: number
  minMs: number
  maxMs: number
  /** Probe-specific counts or per-repetition detail. */
  detail?: Record<string, unknown>
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function summarize(
  name: string,
  params: Record<string, unknown>,
  samplesMs: number[],
  detail?: Record<string, unknown>,
): CaseResult {
  return {
    name,
    params,
    samplesMs: samplesMs.map(v => round(v)),
    medianMs: round(median(samplesMs)),
    minMs: round(Math.min(...samplesMs)),
    maxMs: round(Math.max(...samplesMs)),
    ...(detail ? { detail } : {}),
  }
}

export type ProbeConfig = { reps: number; warmups: number; smoke: boolean }

export function probeConfig(): ProbeConfig {
  const raw = process.env.PERF_PROBE_CONFIG
  const parsed = raw ? JSON.parse(raw) as Partial<ProbeConfig> : {}
  return { reps: parsed.reps ?? 5, warmups: parsed.warmups ?? 1, smoke: parsed.smoke ?? false }
}

/** Runs `warmups` discarded repetitions, then `reps` scored ones; `run` returns its own timed interval. */
export function repeat(config: ProbeConfig, run: (rep: number) => number): number[] {
  for (let i = 0; i < config.warmups; i++) run(-1 - i)
  return Array.from({ length: config.reps }, (_, rep) => run(rep))
}

export function emit(probe: string, cases: CaseResult[], notes: string[] = []): void {
  process.stdout.write(`${JSON.stringify({ probe, runtime: `node ${process.version}`, cases, notes })}\n`)
}
