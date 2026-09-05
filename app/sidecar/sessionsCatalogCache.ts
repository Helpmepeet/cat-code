/**
 * Engine-side write-half of the cold-launch sessions-catalog baseline (F2).
 *
 * After each successful enumeration the catalog owner (decision #4) — the
 * disposable `sessionsCatalogWorker` — drops the global `SessionsCatalogSnapshot`
 * to a single cache file so a launch that has not yet completed its first catalog
 * worker run still has the catalog available to the renderer at startup (and so
 * `openHistorySession` can resolve a terminal-created transcript's cwd).
 *
 * Only one catalog worker runs at a time (main's single-flight driver), but even
 * a concurrent write is correct: each writes a COMPLETE fresh global enumeration,
 * so last-writer-wins holds — no lock, no merge, no read-modify-write (that would
 * be the DR-2 trap in reverse). Writes are atomic
 * (temp + fsync + rename, 0700 dir / 0600 file — the `registry.ts` /
 * `transcriptCache.ts` idiom) so a reader never sees a torn file; the engine's own
 * `writeFileAtomicDurableSync` is that idiom, so this uses it rather than a copy.
 *
 * Display metadata only (titles/tags/branches/cwds) — the same content already on
 * the `sessions.snapshot` frame, `secretGuard`-clean by construction; the accepted
 * residual is a first-prompt title (`sidecarServer.ts:2209`). This runs in the
 * engine (Bun) plane, so it derives the config home from the engine's own
 * `getClaudeConfigHomeDir()` — the SAME source `app/host/registry.ts:173`
 * re-implements host-side, guaranteeing main's read path resolves the same file.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomicDurableSync } from '../../src/utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import {
  SESSIONS_CATALOG_CACHE_FILENAME,
  SESSIONS_CATALOG_CACHE_SUBDIR,
} from '../shared/sessionsCatalogCache.js'

/** `<config-home>/desktop` — the durable desktop state dir (beside `registry.json`). */
export function sessionsCatalogCacheDir(): string {
  return join(getClaudeConfigHomeDir(), SESSIONS_CATALOG_CACHE_SUBDIR)
}

/**
 * Write the global sessions-catalog snapshot atomically. `dir` is injected only
 * so tests write to a tmpdir; production uses `sessionsCatalogCacheDir()`. Throws
 * on an IO failure — the caller (the catalog worker) swallows it, since a failed
 * cache write must never fail the run (best-effort baseline).
 */
export function writeSessionsCatalogCache(
  snapshot: SessionsCatalogSnapshot,
  dir: string = sessionsCatalogCacheDir(),
): void {
  // The 0700 dir mode is deliberate and the engine helper does not set it, so the
  // directory is created here first; the helper's own mkdir then no-ops.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileAtomicDurableSync(
    join(dir, SESSIONS_CATALOG_CACHE_FILENAME),
    JSON.stringify(snapshot),
    { encoding: 'utf8', mode: 0o600 },
  )
}
