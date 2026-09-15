/**
 * Main read-half of the cold-launch sessions-catalog baseline (F2).
 *
 * The sidecar writes a global `SessionsCatalogSnapshot` to
 * `<registryDir>/sessions-catalog.json` after each enumeration
 * (`app/sidecar/sessionsCatalogCache.ts`); at launch — before any sidecar
 * exists — the renderer asks main for it through the read-only
 * `readSessionsCatalog` control-plane method so the Sessions page has the
 * catalog with zero live sessions. Read-only: no new inbound frame kind, no
 * renderer-authored write of engine state.
 *
 * FAIL-CLOSED to `null` on a missing / oversize / corrupt / schema-drifted file —
 * the untrusted disk JSON is size-bounded BEFORE parse and every field is
 * runtime-narrowed at this boundary (main stays engine-free; no `as` cast on the
 * parsed shape). Display metadata only — the same accepted first-prompt-title
 * residual as the `sessions.snapshot` frame (`app/sidecar/sidecarServer.ts:2209`).
 * Never throws.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
  SessionCatalogEntry,
  SessionsCatalogSnapshot,
} from '../shared/protocol.js'
import { isRecord } from '../shared/narrow.js'
import { SESSIONS_CATALOG_CACHE_FILENAME } from '../shared/sessionsCatalogCache.js'
import { parseSessionCatalogEntry } from '../shared/sessionsCatalogWorker.js'

/**
 * Reject any cache file larger than this BEFORE parsing (parse-DoS defense). The
 * enriched 600-session catalog measured ~100KB (`sessionsCatalogDomain.ts:59`);
 * this is a generous multiple, still bounded.
 */
export const MAX_SESSIONS_CATALOG_CACHE_BYTES = 4 * 1024 * 1024

/** `<registryDir>/sessions-catalog.json` — main passes its real registry dir. */
export function sessionsCatalogCacheFile(registryDir: string): string {
  return join(registryDir, SESSIONS_CATALOG_CACHE_FILENAME)
}

/**
 * Read + validate the baseline cache. Returns the snapshot only when every gate
 * passes; on a missing / oversize / unparseable / schema-invalid file it returns
 * null (degrade, never throw). A single malformed entry fails the whole read
 * (fail-closed): the file is written atomically by a single writer, so a partial
 * shape means tamper or drift, not a normal partial state.
 */
export function readSessionsCatalogCache(
  registryDir: string,
): SessionsCatalogSnapshot | null {
  const filePath = sessionsCatalogCacheFile(registryDir)
  try {
    if (!existsSync(filePath)) return null
    if (statSync(filePath).size > MAX_SESSIONS_CATALOG_CACHE_BYTES) return null
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parseSnapshot(parsed)
  } catch {
    // Unreadable / non-JSON / stat race — fail closed.
    return null
  }
}

/**
 * The rows go through the SAME `parseSessionCatalogEntry` the worker boundary
 * uses; only this wrapper is local, and deliberately so. The worker's snapshot
 * wrapper carries a closed-vocabulary gate, which a DISK read must not: a cache
 * written by a build that still carried a since-removed top-level key has to
 * keep reading, or dropping a field blanks the operator's history on the first
 * launch after upgrade. The two key policies differ; the per-entry narrowing
 * never did.
 */
function parseSnapshot(value: unknown): SessionsCatalogSnapshot | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.entries)) return null
  if (typeof value.truncated !== 'boolean') return null
  // Additive (terminal-rename title precedence): a cache file written before the
  // field existed lacks it → 0, an unknown capture age that can never outrank a
  // registry title. A PRESENT non-number is tamper/drift → fail closed.
  if (value.capturedAtMs !== undefined && typeof value.capturedAtMs !== 'number') {
    return null
  }
  const capturedAtMs = value.capturedAtMs === undefined ? 0 : value.capturedAtMs
  const entries: SessionCatalogEntry[] = []
  for (const candidate of value.entries) {
    const entry = parseSessionCatalogEntry(candidate)
    if (!entry) return null
    entries.push(entry)
  }
  return { entries, truncated: value.truncated, capturedAtMs }
}
