/**
 * Sidecar write-half of the cold-launch sessions-catalog baseline (F2).
 *
 * After each successful transcript enumeration the sidecar drops the global
 * `SessionsCatalogSnapshot` to a single cache file so a launch with ZERO live
 * sidecars (every registry row restorable, nobody emitting a `sessions.snapshot`
 * frame) still has the catalog available to the renderer at startup.
 *
 * Multiple sidecars may write concurrently — but each writes a COMPLETE fresh
 * global enumeration, so last-writer-wins is correct: no lock, no merge, no
 * read-modify-write (that would be the DR-2 trap in reverse). Writes are atomic
 * (temp + fsync + rename, 0700 dir / 0600 file — the `registry.ts` /
 * `transcriptCache.ts` idiom) so a reader never sees a torn file.
 *
 * Display metadata only (titles/tags/branches/cwds) — the same content already on
 * the `sessions.snapshot` frame, `secretGuard`-clean by construction; the accepted
 * residual is a first-prompt title (`sidecarServer.ts:2209`). This runs in the
 * engine (Bun) plane, so it derives the config home from the engine's own
 * `getClaudeConfigHomeDir()` — the SAME source `app/host/registry.ts:173`
 * re-implements host-side, guaranteeing main's read path resolves the same file.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

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
 * on an IO failure — the caller (the domain's `refresh()`) swallows it, since a
 * failed cache write must never fail a session (best-effort baseline).
 */
export function writeSessionsCatalogCache(
  snapshot: SessionsCatalogSnapshot,
  dir: string = sessionsCatalogCacheDir(),
): void {
  const filePath = join(dir, SESSIONS_CATALOG_CACHE_FILENAME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = join(
    dir,
    `.${SESSIONS_CATALOG_CACHE_FILENAME}.${process.pid}.${Date.now()}.tmp`,
  )
  const json = JSON.stringify(snapshot)
  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'w', 0o600)
    writeFileSync(fd, json, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw error
  }
}
