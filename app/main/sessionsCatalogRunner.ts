/**
 * Main-owned sessions-catalog worker runner (catalog owner, decision #4 shape
 * (b) — `docs/migration/decisions/CATALOG-OWNERSHIP.md`). This module contains
 * no Electron imports and is unit-testable. It is the catalog sibling of the
 * PL-B `runTranscriptBackfill` runner: it spawns exactly ONE serialized
 * engine-graph worker, reads bounded NDJSON, validates the single result record
 * fail-closed, re-scans for secret-keyed material, and hands the accepted global
 * catalog snapshot to main (which forwards it to the renderer as a read-only
 * outbound host event).
 *
 * The spawn/framing/teardown mechanism lives in `ndjsonWorker.ts` and the
 * refresh cadence in `singleFlightDriver.ts` (single-flight so a slow corpus can
 * never stack spawns, the CATALOG-OWNERSHIP §4 "run can overrun its interval"
 * con, and anchored on run START so the freshness window §4 states as "one
 * interval + one boot" stays bounded by the interval alone). What stays here is
 * the catalog's own record policy. A failed run keeps the last good catalog: it
 * simply does not call `onCatalog`, so main emits no host event and the
 * renderer's retained snapshot survives.
 */

import type { spawn } from 'node:child_process'

import { scanForSecrets } from '../shared/secretGuard.js'
import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import {
  MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES,
  parseSessionsCatalogWorkerResult,
} from '../shared/sessionsCatalogWorker.js'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'

/**
 * Default cadence. Inherited as 30 s from the per-sidecar refresh this replaced
 * (`sidecarServer.ts` `SESSIONS_CATALOG_REFRESH_INTERVAL_MS`); this is the
 * cadence knob CATALOG-OWNERSHIP §4 names: lengthen it if the per-run boot cost
 * proves heavy — freshness is refresh-tolerant.
 *
 * Lengthened to 120 s on 2026-08-31 because the boot cost did prove heavy, and
 * the extra runs it bought were reproducing an unchanged file. Measured on the
 * operator's machine against a live corpus:
 *
 * - One full worker run costs 0.70 s wall / ~1.0 s CPU (0.69/0.69/0.72 s real
 *   over three `bun run app/sidecar/sessionsCatalogWorker.ts` runs).
 * - 0.49 s of that is module-graph import ALONE (0.48/0.50 s for
 *   `bun -e "await import('./src/utils/sessionStorage.ts')"`, against 0.00 s for
 *   a bare `bun -e "1"`). The in-process enumeration of 251 transcripts, 248 of
 *   them enriched, is only 0.15-0.17 s. So ~70% of every run is the per-spawn
 *   engine-graph import CATALOG-OWNERSHIP §4 calls the repeated boot cost, and
 *   at 30 s it was paid 120 times an hour.
 * - The output is byte-identical run to run when nothing changes: `entries` +
 *   `truncated` hashed equal across three consecutive rewrites, same
 *   113,635-byte file, only `capturedAtMs` differing.
 *
 * That was a continuous ~3.3% of one core plus 320 MB/day of writes and 2,880
 * fsync+rename pairs/day to republish an unchanged catalog; 120 s makes it
 * ~0.8% of a core. The driver ticks for the entire life of the app regardless of
 * window focus or idle (started at `ready-to-show`, `main.ts` — stopped only on
 * the quit path), which is what makes the steady-state cadence, not the run
 * cost, the thing worth cutting. The immediate first run at `start()` is
 * untouched, so cold-launch freshness does not regress; only the steady-state
 * staleness window widens, which §4 explicitly sanctions as this knob's
 * trade-off.
 */
export const SESSIONS_CATALOG_REFRESH_INTERVAL_MS = 120_000
export const SESSIONS_CATALOG_WORKER_TIMEOUT_MS = 5 * 60 * 1000

export type SessionsCatalogRunOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  /** Called at most ONCE, only for an accepted + secret-clean catalog record. */
  onCatalog: (catalog: SessionsCatalogSnapshot) => void
  /** Metadata-only process lifecycle hook; it never receives worker output. */
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (line: string) => void
}

export type SessionsCatalogRunOutcome = 'delivered' | 'failure' | 'empty'

/**
 * Spawn one worker, deliver the single catalog record. Resolves with the
 * outcome; rejects only on a protocol/transport violation (bad NDJSON, oversize
 * record, timeout, abort, non-zero exit, a callback that threw), never on a
 * clean worker-reported `failure` (that resolves `'failure'` so the driver just
 * keeps the last good catalog).
 */
export async function runSessionsCatalogWorker(
  options: SessionsCatalogRunOptions,
): Promise<SessionsCatalogRunOutcome> {
  let outcome: SessionsCatalogRunOutcome = 'empty'
  let recordSeen = false
  let protocolError: string | null = null
  const accepted: { value: SessionsCatalogSnapshot | null } = { value: null }

  const { code, signal, aborted, timedOut, stdinError, trailingBytes } =
    await runNdjsonWorker({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? SESSIONS_CATALOG_WORKER_TIMEOUT_MS,
      spawnWorker: options.spawnWorker,
      maxRecordBytes: MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES,
      // No `input`: the catalog worker is a global enumeration with no manifest,
      // so stdin closes empty and a worker that reads it (defense in depth) sees
      // EOF immediately.
      onWorkerLifecycle: options.onWorkerLifecycle,
      log: options.log,
      onOversizeRecord: () => {
        protocolError = 'catalog worker record exceeds size limit'
      },
      onRecord: line => {
        if (recordSeen) {
          // The worker emits EXACTLY one result record; a second is a protocol
          // violation (fail closed, never silently accept extra output).
          protocolError = 'catalog worker emitted more than one record'
          return 'stop'
        }
        let raw: unknown
        try {
          raw = JSON.parse(line.toString('utf8'))
        } catch {
          protocolError = 'catalog worker record is not valid JSON'
          return 'stop'
        }
        const result = parseSessionsCatalogWorkerResult(raw)
        if (!result || !scanForSecrets(result).ok) {
          protocolError = 'catalog worker record failed validation'
          return 'stop'
        }
        recordSeen = true
        if (result.type === 'failure') {
          outcome = 'failure'
          return 'continue'
        }
        accepted.value = result.catalog
        outcome = 'delivered'
        return 'continue'
      },
    })

  if (aborted) throw new Error('catalog worker aborted')
  if (timedOut) throw new Error('catalog worker timed out')
  if (stdinError !== null) {
    throw new Error('catalog worker stdin failed', { cause: stdinError })
  }
  if (protocolError !== null) throw new Error(protocolError)
  if (code !== 0) {
    throw new Error(
      `catalog worker failed (code=${String(code)} signal=${String(signal)})`,
    )
  }
  if (trailingBytes !== 0 || !recordSeen) {
    throw new Error('catalog worker ended without a valid result record')
  }
  const acceptedCatalog = accepted.value
  if (acceptedCatalog !== null) {
    try {
      options.onCatalog(acceptedCatalog)
    } catch (error) {
      throw new Error('catalog worker result callback failed', { cause: error })
    }
  }
  return outcome
}
