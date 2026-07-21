/**
 * Private main↔sessions-catalog-worker boundary (catalog owner, decision #4 —
 * `docs/migration/decisions/CATALOG-OWNERSHIP.md` shape (b)). This is NOT a
 * renderer or sidecar socket protocol: Electron main re-spawns one short-lived,
 * serialized engine-graph worker on a timer; the worker enumerates the global
 * sessions catalog ONCE and exits. The catalog then reaches the renderer as a
 * read-only OUTBOUND host event (C3 precedent) — never an inbound verb.
 *
 * Both ends runtime-validate this boundary the way `transcriptBackfill.ts` does:
 * the worker emits exactly ONE bounded NDJSON result record (a `catalog`
 * snapshot or a `failure`), and main parses it fail-closed so a corrupt or
 * compromised child can neither grow main's buffers without bound nor smuggle a
 * malformed snapshot past the display metadata contract. The payload reuses the
 * existing `SessionsCatalogSnapshot` protocol type (display metadata only — no
 * message bodies, no credentials).
 */

import type {
  SessionCatalogEntry,
  SessionsCatalogSnapshot,
} from './protocol.js'

export const SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION = 1

/**
 * Reject any NDJSON result record larger than this BEFORE parse (parse-DoS
 * defense). The enriched 600-session catalog measured ~100KB
 * (`sessionsCatalogDomain.ts`); this is the SAME generous-but-bounded multiple
 * the cold-launch cache read uses (`sessionsCatalogBaseline.ts`
 * `MAX_SESSIONS_CATALOG_CACHE_BYTES`).
 */
export const MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES = 4 * 1024 * 1024

export type SessionsCatalogWorkerCatalogResult = {
  type: 'catalog'
  version: typeof SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION
  catalog: SessionsCatalogSnapshot
}

export type SessionsCatalogWorkerFailureResult = {
  type: 'failure'
  version: typeof SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION
  reason: 'internal'
}

export type SessionsCatalogWorkerResult =
  | SessionsCatalogWorkerCatalogResult
  | SessionsCatalogWorkerFailureResult

/**
 * Parse + validate one worker result record fail-closed. Returns the typed
 * result only when every gate passes; a wrong version, unknown discriminant,
 * extra keys, or a single malformed catalog entry fails the WHOLE record
 * (null). The snapshot shape is narrowed field-by-field so the return carries no
 * `as` cast on the untrusted child output — the same posture main's cold-launch
 * cache read (`sessionsCatalogBaseline.ts`) holds on the untrusted disk file.
 */
export function parseSessionsCatalogWorkerResult(
  value: unknown,
): SessionsCatalogWorkerResult | null {
  if (!isRecord(value)) return null
  if (value.version !== SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION) return null
  if (value.type === 'failure') {
    if (!hasExactKeys(value, ['type', 'version', 'reason'])) return null
    if (value.reason !== 'internal') return null
    return {
      type: 'failure',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    }
  }
  if (value.type !== 'catalog') return null
  if (!hasExactKeys(value, ['type', 'version', 'catalog'])) return null
  const catalog = parseSessionsCatalogSnapshot(value.catalog)
  if (!catalog) return null
  return {
    type: 'catalog',
    version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
    catalog,
  }
}

/**
 * Fail-closed `SessionsCatalogSnapshot` validator (display metadata only).
 * Exported so the boundary is the ONE place the untrusted snapshot shape is
 * narrowed; a single malformed entry fails the whole snapshot.
 */
export function parseSessionsCatalogSnapshot(
  value: unknown,
): SessionsCatalogSnapshot | null {
  if (!isRecord(value)) return null
  if (!hasExactKeys(value, ['entries', 'truncated', 'notes'])) return null
  if (!Array.isArray(value.entries)) return null
  if (typeof value.truncated !== 'boolean') return null
  if (
    !Array.isArray(value.notes) ||
    !value.notes.every(note => typeof note === 'string')
  ) {
    return null
  }
  const entries: SessionCatalogEntry[] = []
  for (const candidate of value.entries) {
    const entry = parseEntry(candidate)
    if (!entry) return null
    entries.push(entry)
  }
  return { entries, truncated: value.truncated, notes: value.notes }
}

function parseEntry(value: unknown): SessionCatalogEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId !== 'string') return null
  if (typeof value.cwd !== 'string') return null
  if (!isStringOrNull(value.title)) return null
  if (typeof value.modifiedAtMs !== 'number') return null
  if (typeof value.createdAtMs !== 'number') return null
  if (typeof value.messageCount !== 'number') return null
  if (!isStringOrNull(value.gitBranch)) return null
  if (!isStringOrNull(value.tag)) return null
  const mode = value.mode
  if (
    !(mode === 'agent' || mode === 'coordinator' || mode === 'normal' || mode === null)
  ) {
    return null
  }
  if (!isStringOrNull(value.agentSetting)) return null
  if (!(typeof value.prNumber === 'number' || value.prNumber === null)) return null
  if (!isStringOrNull(value.prRepository)) return null
  // Field-by-field so the return is a real `SessionCatalogEntry`, no `as` on the
  // untrusted worker output (each read above narrowed its field).
  return {
    sessionId: value.sessionId,
    cwd: value.cwd,
    title: value.title,
    modifiedAtMs: value.modifiedAtMs,
    createdAtMs: value.createdAtMs,
    messageCount: value.messageCount,
    gitBranch: value.gitBranch,
    tag: value.tag,
    mode,
    agentSetting: value.agentSetting,
    prNumber: value.prNumber,
    prRepository: value.prRepository,
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i])
}
