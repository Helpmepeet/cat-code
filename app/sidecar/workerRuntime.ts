/**
 * Shared tail for the three disposable engine workers (`sessionsCatalogWorker`,
 * `accountsPoolWorker`, `transcriptBackfillWorker`). Each is ONE process that
 * reads once, emits ONE bounded NDJSON record on stdout and exits; a fatal
 * writes a single stderr diagnostic and exits 1. Those four pieces were
 * hand-copied into all three files; they live here instead.
 *
 * NOTHING in this module may be a STATIC engine import. Each worker sets
 * `process.env.CLAUDE_CODE_SIMPLE = '1'` at its own module scope, and a static
 * import here would be evaluated before that assignment runs. For the same
 * reason the assignment itself cannot move into this module: it must stay a
 * module-scope statement in each worker, above every engine import.
 */

/** The one error-to-string form all three workers use for their diagnostics. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write a worker's single result as one NDJSON line on stdout, refusing
 * anything over its boundary's byte cap. `what` names the record in the limit
 * error (`'catalog result'` -> `catalog result exceeds record limit`). An
 * oversize record must never reach main's fail-closed parser, so this throws
 * rather than truncating: the failure mode is a lost snapshot, not a torn one.
 */
export function emitWorkerRecord(
  result: unknown,
  maxBytes: number,
  what: string,
): Promise<void> {
  const line = JSON.stringify(result)
  if (Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw new Error(`${what} exceeds record limit`)
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * OBSERVATION-ONLY BOOTSTRAP, shared by all three disposable workers.
 *
 * The full `init()` these used to run fires `void initAccountPool()`
 * (`src/entrypoints/init.ts:86-90`), which starts periodic token refresh, a
 * 1-second quarantine probe, and a usage POST with real OAuth tokens. Main
 * re-spawns these workers on a timer, so that drove real credential machinery
 * from throwaway processes on a loop, and the unconditional `process.exit(0)`
 * each worker ends with could hard-kill a refresh it had just started.
 * Observation needs the MACRO shim plus config reads and nothing else.
 *
 * `enableConfigs` is the engine's own idempotent unlock, and the reason it is
 * not optional: the engine hard-fails any config read taken before that latch
 * (`config.ts:1465` "Config accessed before allowed"). It validates the config
 * file and carries none of `init()`'s live side-effects.
 *
 * Call this only AFTER the worker's own engine imports have resolved: the
 * imports are what the `CLAUDE_CODE_SIMPLE` switch above them guards, and both
 * calls here run once the graph is loaded either way.
 */
export async function bootstrapWorkerEngine(): Promise<void> {
  const [{ ensureEngineMacro }, { enableConfigs }] = await Promise.all([
    import('./initializeRuntime.js'),
    import('../../src/utils/config.js'),
  ])
  ensureEngineMacro()
  enableConfigs()
}

/**
 * Run a disposable worker's `main` and own its fatal tail: one stderr line
 * under the worker's own log prefix, then exit 1. stderr is diagnostics only.
 */
export function runDisposableWorker(
  prefix: string,
  main: () => Promise<void>,
): void {
  void main().catch(error => {
    process.stderr.write(`[${prefix}] fatal: ${errorText(error)}\n`)
    process.exit(1)
  })
}
