export const WORKER_TIMING_STAGES = ['worker_bootstrap_imports', 'build_metadata', 'build_provenance_git', 'configuration_prepare', 'trust_evaluation', 'relocation_module_load', 'relocation_work'] as const
export type WorkerTimingStage = typeof WORKER_TIMING_STAGES[number]
export type WorkerTiming = { phase: WorkerTimingStage; durationMs: number; outcome: 'completed' | 'failed' }
const PREFIX = 'cat-worker-timing:'

/** Private stderr metadata only. Stdout remains the worker's single result. */
export function parseWorkerTimings(stderr: string): WorkerTiming[] {
  const result: WorkerTiming[] = []
  for (const line of stderr.split('\n')) {
    if (!line.startsWith(PREFIX) || line.length > 256 || result.length >= 12) continue
    try {
      const value = JSON.parse(line.slice(PREFIX.length)) as WorkerTiming
      if (Object.keys(value).sort().join(',') !== 'durationMs,outcome,phase' ||
          !(WORKER_TIMING_STAGES as readonly unknown[]).includes(value.phase) ||
          !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 600_000 ||
          !['completed', 'failed'].includes(value.outcome)) continue
      result.push(value)
    } catch { /* Other stderr is never timing metadata. */ }
  }
  return result
}

function publish(phase: WorkerTimingStage, started: number, outcome: WorkerTiming['outcome']): void {
  if (process.env.CAT_CODE_WORKER_TIMING !== '1') return
  try { process.stderr.write(`${PREFIX}${JSON.stringify({ phase, durationMs: Math.min(600_000, Math.max(0, performance.now() - started)), outcome })}\n`) } catch { /* Observation only. */ }
}
export function workerTimingSync<T>(phase: WorkerTimingStage, work: () => T): T {
  const started = performance.now()
  try { const result = work(); publish(phase, started, 'completed'); return result }
  catch (error) { publish(phase, started, 'failed'); throw error }
}
export async function workerTiming<T>(phase: WorkerTimingStage, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { const result = await work(); publish(phase, started, 'completed'); return result }
  catch (error) { publish(phase, started, 'failed'); throw error }
}
