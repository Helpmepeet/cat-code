/**
 * Sessions-catalog worker (catalog owner, decision #4 shape (b)). ONE disposable
 * engine-graph process: it enumerates the global sessions catalog ONCE, emits a
 * single bounded NDJSON result over stdout, and exits. It is the analogue of the
 * PL-B `transcriptBackfillWorker` — separate from the live N-process sidecars so
 * the enumeration never rides a session process, and it disappears when it exits
 * so it holds NO resident memory between the main-driven runs (the RAM win the
 * per-sidecar catalog cost booked against N attached sidecars, RAM-3.1).
 *
 * Main re-spawns it on a timer and remains engine-free. This worker reuses the
 * EXISTING enumeration (`enumerateSessionsCatalog` → the same
 * `loadAllProjectsMessageLogsProgressive` + `buildSessionsCatalogSnapshot` the
 * sidecar domain used, CLAUDE.md §8 rule 10) and the EXISTING F2 cache writer
 * (`writeSessionsCatalogCache`) — it runs in the engine (Bun) plane, so it is
 * allowed to derive the config home the way the host plane cannot.
 *
 * The catalog is display metadata only (titles/tags/branches/cwds — no message
 * bodies, no credentials), so the emitted record is `secretGuard`-clean by
 * construction; it is re-scanned here AND again at main's parse boundary.
 * stderr is diagnostics only.
 */

import {
  MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES,
  SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
  type SessionsCatalogWorkerResult,
} from '../shared/sessionsCatalogWorker.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  bootstrapWorkerEngine,
  emitWorkerRecord,
  errorText,
  runDisposableWorker,
} from './workerRuntime.js'

// Set the one-switch minimal mode before ANY engine module is dynamically
// imported (mirrors `transcriptBackfillWorker.ts:50`): enumeration must not drag
// in SessionStart hooks or the live-session machinery. `workerRuntime.js` above
// is engine-free by contract, so importing it does not pre-empt this.
process.env.CLAUDE_CODE_SIMPLE = '1'

async function main(): Promise<void> {
  // Engine imports happen only after SIMPLE is fixed for the process. All three
  // are engine-graph modules; the top-level static imports above are engine-free
  // (shared boundary + secretGuard), so the ~189 MB engine import is paid only
  // here, per run, exactly as CATALOG-OWNERSHIP §4 "repeated boot cost" accepts.
  const [{ enumerateSessionsCatalog }, { writeSessionsCatalogCache }] =
    await Promise.all([
      import('./sessionsCatalogDomain.js'),
      import('./sessionsCatalogCache.js'),
    ])
  await bootstrapWorkerEngine()

  const catalog = await enumerateSessionsCatalog()
  if (!catalog) {
    // A read failure degrades to "no catalog" — main keeps its last good
    // snapshot (the renderer never blanks). Report it explicitly so the runner
    // distinguishes a clean empty-corpus run from a failed enumeration.
    await emit({
      type: 'failure',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    process.exit(0)
  }

  // F2 — persist the cold-launch baseline cache from the enumerating engine
  // process, exactly as the sidecar domain's `persist` callback did. Best-effort:
  // a failed cache write must never fail the run (the live host-event path still
  // delivers, and the last good cache survives).
  try {
    writeSessionsCatalogCache(catalog)
  } catch (error) {
    process.stderr.write(
      `[catalog-worker] baseline cache write skipped: ${errorText(error)}\n`,
    )
  }

  const result: SessionsCatalogWorkerResult = {
    type: 'catalog',
    version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
    catalog,
  }
  const secret = scanForSecrets(result)
  if (!secret.ok) {
    process.stderr.write('[catalog-worker] blocked secret-keyed catalog result\n')
    await emit({
      type: 'failure',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
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

function emit(result: SessionsCatalogWorkerResult): Promise<void> {
  return emitWorkerRecord(
    result,
    MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES,
    'catalog result',
  )
}

runDisposableWorker('catalog-worker', main)
