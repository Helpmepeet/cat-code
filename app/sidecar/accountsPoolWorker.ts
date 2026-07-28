/**
 * Accounts-pool worker (accounts owner — `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`).
 * ONE disposable engine-graph process: it reads the global account pool ONCE,
 * emits a single bounded NDJSON result over stdout, and exits. It is the
 * accounts analogue of `sessionsCatalogWorker` — separate from the live
 * N-process sidecars so the pool read never rides a session process, and it
 * disappears when it exits so it holds NO resident memory between runs.
 *
 * Main re-spawns it on a timer and remains engine-free. This worker reuses the
 * EXISTING redaction (`buildAccountsSnapshot`, the same pure projection the
 * sidecar accounts domain emits) rather than re-deriving the shape
 * (CLAUDE.md §8 rule 10).
 *
 * OBSERVATION-ONLY BOOTSTRAP — the one deliberate difference from its two
 * sibling workers, which both call `initializeSidecarRuntime()`. Full `init()`
 * fires `void initAccountPool()` (`src/entrypoints/init.ts:90`), which starts
 * periodic token refresh, quarantine probes, and a startup `touchAll()`. On a
 * 60 s timer that would drive real cross-process credential rotation against the
 * vault forever. So this worker takes the engine's OWN observation-only entry
 * point instead — `loadPoolForObservation()`, extracted upstream for exactly
 * this class of caller ("observation-only callers (e.g. the `codex status`
 * subcommand) can load the pool without triggering token refresh, quarantine
 * probes, or usage polls", `codexAccountPool.ts:171-181`) — plus the MACRO shim
 * alone from `initializeRuntime.ts`.
 *
 * The ONE outbound network call is `fetchPoolUsage`, the same read-only
 * (GET, engine-side 1-min-cached, existing tokens, no refresh, no completion
 * burn) call the sidecar accounts domain already makes. It is what keeps the
 * headroom numbers live; a failure degrades to "pool without fresh usage" and
 * never fails the run.
 *
 * The emitted record is the ALREADY-redacted `AccountsSnapshot` (no token, no
 * vault path by construction), and it is `secretGuard`-scanned here AND again at
 * main's parse boundary. stderr is diagnostics only.
 */

import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
  type AccountsPoolWorkerResult,
} from '../shared/accountsPoolWorker.js'
import { scanForSecrets } from '../shared/secretGuard.js'

// Set the one-switch minimal mode before ANY engine module is dynamically
// imported (mirrors `sessionsCatalogWorker.ts:33`): a pool read must not drag in
// SessionStart hooks or the live-session machinery.
process.env.CLAUDE_CODE_SIMPLE = '1'

async function main(): Promise<void> {
  // Engine imports happen only after SIMPLE is fixed for the process. The static
  // imports above are engine-free (shared boundary + secretGuard), so the
  // ~189 MB engine import is paid only here, per run.
  const [
    { getPoolStatus, loadPoolForObservation },
    { initClaudeAccountPool },
    { buildAccountsSnapshot },
    { ensureEngineMacro },
    { enableConfigs },
  ] = await Promise.all([
    import('../../src/services/api/codexAccountPool.js'),
    import('../../src/services/api/claudeAccountPool.js'),
    import('./accountsDomain.js'),
    import('./initializeRuntime.js'),
    import('../../src/utils/config.js'),
  ])
  ensureEngineMacro()
  // The engine hard-fails any config read taken before this latch
  // (`config.ts:1465` "Config accessed before allowed"), and both pool loads
  // read the global config. `enableConfigs` is the engine's own idempotent
  // unlock and validates the config file; it is the ONLY piece of `init()` this
  // worker needs, and it carries none of init's live side-effects.
  enableConfigs()

  // Both pool loads are disk-only (vault + config). Neither refreshes a token.
  await loadPoolForObservation()
  initClaudeAccountPool()

  // Live usage headroom — the reason this page polls at all. Best-effort: an
  // offline or stale-token run still emits the pool with whatever usage the
  // accounts already carry.
  try {
    const { fetchPoolUsage } = await import('../../src/services/api/codexUsage.js')
    await fetchPoolUsage({ updateRoutingHints: true })
  } catch (error) {
    process.stderr.write(
      `[accounts-worker] usage refresh skipped: ${errorText(error)}\n`,
    )
  }

  let pool
  try {
    pool = buildAccountsSnapshot(getPoolStatus())
  } catch (error) {
    // A read failure degrades to "no pool" — main keeps its last good snapshot
    // (the renderer never blanks). Report it explicitly so the runner
    // distinguishes a clean empty pool from a failed read.
    process.stderr.write(`[accounts-worker] pool read failed: ${errorText(error)}\n`)
    await emit({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    process.exit(0)
  }

  const result: AccountsPoolWorkerResult = {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool,
  }
  const secret = scanForSecrets(result)
  if (!secret.ok) {
    process.stderr.write('[accounts-worker] blocked secret-keyed pool result\n')
    await emit({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    process.exit(0)
  }
  await emit(result)
  // The engine registers long-lived handles (config watchers). This is a
  // disposable single-shot process, so terminate explicitly instead of waiting
  // for those unrelated handles to drain (mirrors the sibling workers).
  process.exit(0)
}

function emit(result: AccountsPoolWorkerResult): Promise<void> {
  const line = JSON.stringify(result)
  if (Buffer.byteLength(line, 'utf8') > MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES) {
    throw new Error('accounts pool result exceeds record limit')
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main().catch(error => {
  process.stderr.write(`[accounts-worker] fatal: ${errorText(error)}\n`)
  process.exit(1)
})
