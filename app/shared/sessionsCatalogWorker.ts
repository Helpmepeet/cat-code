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
import {
  isBoolean,
  isNumber,
  isNumberOrNull,
  isRecord,
  isString,
  isStringOrNull,
  isUnknownArray,
  narrowExact,
  narrowOpen,
  oneOf,
  optional,
} from './narrow.js'

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
    const failure = narrowExact(value, {
      type: oneOf(['failure'] as const),
      version: oneOf([SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION] as const),
      reason: oneOf(['internal'] as const),
    })
    return failure
  }
  if (value.type !== 'catalog') return null
  const record = narrowExact(value, {
    type: oneOf(['catalog'] as const),
    version: oneOf([SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION] as const),
    catalog: isRecord,
  })
  if (!record) return null
  const catalog = parseSessionsCatalogSnapshot(record.catalog)
  if (!catalog) return null
  return { ...record, catalog }
}

/**
 * Fail-closed `SessionsCatalogSnapshot` validator (display metadata only).
 * Exported so the boundary is the ONE place the untrusted snapshot shape is
 * narrowed; a single malformed entry fails the whole snapshot.
 */
export function parseSessionsCatalogSnapshot(
  value: unknown,
): SessionsCatalogSnapshot | null {
  const snapshot = narrowExact(value, {
    entries: isUnknownArray,
    truncated: isBoolean,
    // `capturedAtMs` is additive (the terminal-rename title-precedence fix):
    // accept the record with OR without it, but no OTHER key — the
    // closed-vocabulary gate stands. Absent ⇒ 0 (unknown age ⇒ never outranks a
    // registry title).
    capturedAtMs: optional(isNumber),
  })
  if (!snapshot) return null
  const entries: SessionCatalogEntry[] = []
  for (const candidate of snapshot.entries) {
    const entry = parseSessionCatalogEntry(candidate)
    if (!entry) return null
    entries.push(entry)
  }
  return {
    entries,
    truncated: snapshot.truncated,
    capturedAtMs: snapshot.capturedAtMs ?? 0,
  }
}

/**
 * Fail-closed `SessionCatalogEntry` validator. Deliberately `narrowOpen`: an
 * entry has never carried a closed-vocabulary gate, so a row from a worker build
 * that has since gained a field still reads.
 */
export function parseSessionCatalogEntry(
  value: unknown,
): SessionCatalogEntry | null {
  const entry = narrowOpen(value, {
    sessionId: isString,
    cwd: isString,
    title: isStringOrNull,
    modifiedAtMs: isNumber,
    createdAtMs: isNumber,
    messageCount: isNumber,
    gitBranch: isStringOrNull,
    tag: isStringOrNull,
    mode: oneOf(['agent', 'coordinator', 'normal', null] as const),
    agentSetting: isStringOrNull,
    prNumber: isNumberOrNull,
    prRepository: isStringOrNull,
    // The four additive fields below: absent ⇒ the documented pre-field default,
    // but a PRESENT wrong-typed value is malformed child output → fail the whole
    // record like every other field.
    forked: optional(isBoolean),
    isInteractive: optional(isBoolean),
    // Additive (bug-sweep #1): default `true` = assume-exists, never wrongly hide.
    cwdExists: optional(isBoolean),
    // Additive (terminal-rename title precedence): absent ⇒ null, i.e. this entry
    // can never outrank the registry title — the pre-fix behavior.
    transcriptTitle: optional(isStringOrNull),
  })
  if (!entry) return null
  return {
    ...entry,
    forked: entry.forked === true,
    isInteractive: entry.isInteractive,
    cwdExists: entry.cwdExists ?? true,
    transcriptTitle: entry.transcriptTitle ?? null,
  }
}
