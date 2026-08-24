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
import { SESSIONS_CATALOG_CACHE_FILENAME } from '../shared/sessionsCatalogCache.js'

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
    const entry = parseEntry(candidate)
    if (!entry) return null
    entries.push(entry)
  }
  return { entries, truncated: value.truncated, capturedAtMs }
}

function parseEntry(value: unknown): SessionCatalogEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId !== 'string') return null
  if (value.forked !== undefined && typeof value.forked !== 'boolean') return null
  const forked = value.forked === true
  if (typeof value.cwd !== 'string') return null
  // Additive field (bug-sweep #1): a cache file written before it existed lacks
  // it → default `true` (assume-exists, never wrongly hide an old row). A PRESENT
  // non-boolean is tamper/drift → fail closed like every other field here.
  if (value.cwdExists !== undefined && typeof value.cwdExists !== 'boolean') return null
  const cwdExists = value.cwdExists === undefined ? true : value.cwdExists
  if (!isStringOrNull(value.title)) return null
  // Additive (terminal-rename title precedence): an old cache entry lacks it →
  // null, so it can never outrank the registry title (the pre-fix behavior).
  if (value.transcriptTitle !== undefined && !isStringOrNull(value.transcriptTitle)) {
    return null
  }
  const transcriptTitle =
    value.transcriptTitle === undefined ? null : value.transcriptTitle
  if (typeof value.modifiedAtMs !== 'number') return null
  if (typeof value.createdAtMs !== 'number') return null
  if (typeof value.messageCount !== 'number') return null
  if (!isStringOrNull(value.gitBranch)) return null
  if (!isStringOrNull(value.tag)) return null
  const mode = value.mode
  if (!(mode === 'agent' || mode === 'coordinator' || mode === 'normal' || mode === null)) {
    return null
  }
  if (!isStringOrNull(value.agentSetting)) return null
  if (!(typeof value.prNumber === 'number' || value.prNumber === null)) return null
  if (!isStringOrNull(value.prRepository)) return null
  // Constructed field-by-field so the return is a real `SessionCatalogEntry` with
  // no `as` cast on the untrusted shape (each read above narrowed its field).
  return {
    sessionId: value.sessionId,
    forked,
    cwd: value.cwd,
    cwdExists,
    title: value.title,
    transcriptTitle,
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
