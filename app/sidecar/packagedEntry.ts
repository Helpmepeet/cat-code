/**
 * Packaged-build sidecar entry — one binary, five modes (P5-1).
 *
 * A compiled Bun binary embeds its own runtime, so one executable per entry
 * would ship that runtime five times. This entry selects the real module from
 * `process.argv[2]` instead; the mode tokens are the keys of
 * `SIDECAR_MODE_ENTRIES` in `app/main/mainDecisions.ts`, which is also what
 * main spawns with, so the two sides cannot drift.
 *
 * The imports are DYNAMIC on purpose. Three of the five workers set a
 * process-global switch (`CLAUDE_CODE_SIMPLE`) at their own module scope before
 * reaching the engine graph; a static import here would evaluate every module,
 * dragging the live-session machinery in before that switch is set and undoing
 * the isolation those workers exist for. Each module self-invokes its `main()`
 * on evaluation, so importing it IS running it.
 *
 * Development never loads this file: `bun run` executes the entry modules
 * directly.
 */

const MODES = {
  session: () => import('./index.js'),
  'transcript-backfill': () => import('./transcriptBackfillWorker.js'),
  'catalog': () => import('./sessionsCatalogWorker.js'),
  'accounts-pool': () => import('./accountsPoolWorker.js'),
  'debug-cleanup': () => import('./debugCleanupWorker.js'),
} as const

type Mode = keyof typeof MODES

function isMode(value: string | undefined): value is Mode {
  return value !== undefined && Object.prototype.hasOwnProperty.call(MODES, value)
}

const requested = process.argv[2]
if (!isMode(requested)) {
  // Fail closed and name the closed set: an unknown mode means main and this
  // binary were built from different sources, which is not something to guess
  // a default for.
  process.stderr.write(
    `[sidecar] fatal: unknown mode ${JSON.stringify(requested ?? null)}; expected one of ${Object.keys(MODES).join(', ')}\n`,
  )
  process.exit(1)
}

// Normalize argv to the shape the entry modules already see under `bun run`.
// A compiled binary starts at ["bun", "/$bunfs/root/<binary>", ...args], so the
// mode token sits at index 2 where development has the worker's first real
// argument. Engine argv readers are position-independent today
// (`src/utils/envUtils.ts:74` tests `includes('--bare')`), but leaving a
// synthetic positional in argv is a trap for the next one that is not.
process.argv.splice(2, 1)

await MODES[requested]()
