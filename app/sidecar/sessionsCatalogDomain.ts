/**
 * Sessions catalog domain (P4-6a; catalog owner decision #4) — the engine-side
 * enumeration + wire mapping half of the Sessions catalog read-seam.
 *
 * The host plane is deliberately engine-free (`app/host/registry.ts:19`), so it
 * cannot enumerate transcripts; an engine-capable process (the disposable
 * catalog worker, `app/sidecar/sessionsCatalogWorker.ts`) reads them via the
 * SAME loader `/resume` uses:
 * `loadAllProjectsMessageLogsProgressive` (`src/utils/sessionStorage.ts:4476`).
 * That loader stat-lists every project dir (up to `SESSIONS_CATALOG_STAT_LIMIT`
 * per dir) then ENRICHES the most-recent `SESSIONS_CATALOG_ENRICH_LIMIT`
 * sessions (≤2×64KB head+tail reads each — bounded, never a full scan), so the
 * winning title, first prompt, tag, git branch, cwd and PR come from the same
 * source the TUI shows. `messageCount` (needs a full-chain read) and `mode`
 * (undefined on the lite/enriched path) are NOT populated by this loader — the
 * catalog renders truth (0 / null) and the page flags those chips (C3
 * render-truth precedent).
 *
 * The enrich limit is the RETURNED count, so the pre-#16 default of 50 hid the
 * operator's real terminal history behind the newest ~day of dev/test sessions.
 * #16 raises it to a still-bounded window (each enriched row is a capped
 * head+tail read, never a full transcript read of all 2k+ files).
 *
 * Catalog owner (decision #4, `docs/migration/decisions/CATALOG-OWNERSHIP.md`):
 * this enumeration no longer runs per-sidecar. A single main-supervised
 * disposable worker (`app/sidecar/sessionsCatalogWorker.ts`) calls
 * `enumerateSessionsCatalog` ONCE per run, off any session process, persists the
 * F2 baseline cache, and hands the snapshot to main, which delivers it to the
 * renderer as a read-only `sessions-catalog` host event. So no attached sidecar
 * pays the enumeration plateau (the RAM-3.1 win); a session created after launch
 * appears on the next timer run (same freshness contract as the old 30 s refresh).
 *
 * Read-only, display-metadata only — no message bodies, no credentials — so the
 * emitted snapshot is `secretGuard`-clean by construction (scanned at the worker
 * and again at main's parse boundary). Exposes a pure builder
 * (`buildSessionsCatalogSnapshot`) + the `enumerateSessionsCatalog` wrapper, both
 * unit-testable without the filesystem.
 */

import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  loadAllProjectsMessageLogsProgressive,
  type SessionLogResult,
} from '../../src/utils/sessionStorage.js'
import type { LogOption } from '../../src/types/logs.js'
import type { SessionCatalogEntry, SessionsCatalogSnapshot } from '../shared/protocol.js'

/**
 * Per-project stat cap (cheap readdir+stat). Raised for #16 so genuine history
 * (weeks-old sessions in a busy project dir) is reachable, not just the newest
 * few hundred; stat rows are metadata-only, so this stays cheap.
 */
export const SESSIONS_CATALOG_STAT_LIMIT = 1000
/**
 * How many most-recent sessions get their metadata enriched (bounded reads).
 * This is the RETURNED entry count — every returned row is labeled + carries a
 * cwd (B2/B3). Raised from 50 → 600 for #16: enriching the full discoverable
 * set measured ≈200–330ms and ≈100KB (well under `MAX_OUTBOUND_FRAME_BYTES`),
 * so an operator's real terminal history shows instead of only the newest ~day.
 */
export const SESSIONS_CATALOG_ENRICH_LIMIT = 600

/**
 * Enumerate the global sessions catalog ONCE (the catalog owner's single-shot
 * read, decision #4). Reads the same loader `/resume` uses, bounded by the stat +
 * enrich limits, and maps it to the wire snapshot. A read failure degrades to
 * `null` — the caller keeps its last good snapshot (display = degrade gracefully).
 */
export async function enumerateSessionsCatalog(): Promise<SessionsCatalogSnapshot | null> {
  // Stamped BEFORE the read, not after (`protocol.ts` `capturedAtMs`): every
  // transcript this run reads is read at or after this instant, so a snapshot that
  // is "newer than the registry's titleUpdatedAt" provably saw the newer title.
  const capturedAtMs = Date.now()
  try {
    const result = await loadAllProjectsMessageLogsProgressive(
      SESSIONS_CATALOG_STAT_LIMIT,
      SESSIONS_CATALOG_ENRICH_LIMIT,
    )
    // The pure builder is fs-free (so it stays unit-testable); the existence
    // stat is the async second pass, done here in the engine-graph worker plane
    // (the host plane could not — `registry.ts:19`).
    return await annotateCwdExistence(
      buildSessionsCatalogSnapshot(result, capturedAtMs),
    )
  } catch (error) {
    // A read failure degrades to "no catalog" — the page shows a load state,
    // never a crash (display = degrade gracefully). Keep the raw failure in
    // the worker's stderr so a stale catalog is diagnosable without widening
    // the renderer-facing failure vocabulary.
    process.stderr.write(
      `[catalog-worker] session catalog enumeration failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}

/**
 * Stamp `cwdExists` on every entry by statting each DISTINCT non-empty cwd ONCE
 * (bug-sweep #1, 2026-07-21). Kept OFF the pure builder so `buildSessionsCatalogSnapshot`
 * stays filesystem-free and unit-testable; this async pass runs in the engine
 * (Bun) worker plane, which is allowed the fs read the host plane is not
 * (`registry.ts:19`). A dead workspace makes its history rows non-openable and
 * HIDDEN from the sidebar rail (operator ruling: HIDE, not delete — the
 * transcript stays on disk and the row self-heals when the dir returns, since
 * this re-derives every run). Empty cwds are never statted (they resolve to
 * `false`); the renderer keeps those "Unknown workspace" rows visible via its own
 * predicate (MAJOR-1). `isExistingDir` is injectable so the pass is testable
 * without touching the real filesystem.
 */
export async function annotateCwdExistence(
  snapshot: SessionsCatalogSnapshot,
  isExistingDir: (cwd: string) => Promise<boolean> = defaultIsExistingDir,
): Promise<SessionsCatalogSnapshot> {
  const distinct = new Set<string>()
  for (const entry of snapshot.entries) {
    if (entry.cwd.length > 0) distinct.add(entry.cwd)
  }
  const existing = new Set<string>()
  await Promise.all(
    [...distinct].map(async cwd => {
      if (await isExistingDir(cwd)) existing.add(cwd)
    }),
  )
  const entries = snapshot.entries.map(entry => ({
    ...entry,
    cwdExists: existing.has(entry.cwd),
  }))
  return { ...snapshot, entries }
}

/**
 * Existence check matching the host's authoritative gate (`app/host/host.ts:62`
 * `statSync().isDirectory()`): a cwd "exists" only when it is a real directory.
 * Any stat error (missing / permission / not-a-dir) reads as gone.
 */
async function defaultIsExistingDir(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory()
  } catch {
    return false
  }
}

export function buildSessionsCatalogSnapshot(
  result: SessionLogResult,
  // Enumeration start (`protocol.ts` `capturedAtMs`). Defaulted so the pure
  // builder stays callable standalone, and injectable so tests pin it.
  capturedAtMs: number = Date.now(),
): SessionsCatalogSnapshot {
  // MAJOR-1 — reconcile workspace grouping before mapping. A storage dir
  // (`…/projects/-Users-me-proj`) is the sanitized form of exactly ONE real cwd,
  // but only ~60% of sessions recorded that cwd (`projectPath`). Learn each
  // dir→cwd mapping from the sessions that DID record it so the sessions in the
  // same dir that DIDN'T can borrow the real cwd — otherwise one workspace splits
  // into two `groupByWorkspace` groups (it keys on the exact cwd string), the
  // second headed by the undecodable sanitized name and never reconciling with
  // the registry rows (which always carry the real cwd).
  const storageDirToCwd = buildStorageDirToCwd(result.logs)
  const entries = result.logs
    .map(log => mapLogOptionToCatalogEntry(log, storageDirToCwd))
    .filter((entry): entry is SessionCatalogEntry => entry !== null)
  // "Truncated" must mean the enrich cap stopped us BEFORE the end of the
  // discovered list — not merely that fewer logs came back than were stat-listed.
  // A count comparison conflates the two: the loader also drops sidechains, team
  // sessions and (since the no-conversation filter) diagnostic-only transcripts,
  // so every dropped row would falsely read as "older sessions are omitted".
  // `nextIndex` is where enrichment actually stopped scanning, which is the honest
  // signal (`sessionStorage.ts` enrichLogs).
  const truncated = result.nextIndex < result.allStatLogs.length
  return { entries, truncated, capturedAtMs }
}

export function mapLogOptionToCatalogEntry(
  log: LogOption,
  // MAJOR-1 — the storage-dir → real-cwd reconciliation map built by
  // `buildSessionsCatalogSnapshot`. Optional: called standalone (a lone log)
  // with no map, a `projectPath`-less entry resolves to an empty cwd.
  storageDirToCwd?: ReadonlyMap<string, string>,
): SessionCatalogEntry | null {
  if (!log.sessionId) return null
  // enrichLogs already drops sidechains, but guard defensively.
  if (log.isSidechain) return null
  // A transcript with no conversation cannot be resumed: opening it fails in the
  // engine ("no conversation found") after the app has already minted a registry
  // row, which then counts against `MAX_REGISTRY_SESSIONS` and evicts a real
  // restorable session. Every row this catalog emits is openable, so these are
  // dropped here rather than rendered as rows that fail on click. The engine
  // computes the flag from the window it already reads (`sessionStorage.ts`
  // readLiteMetadata); `undefined` (unscanned lite row) is NOT treated as empty.
  if (log.hasConversation === false) return null
  const cwd = resolveEntryCwd(log, storageDirToCwd)
  return {
    sessionId: log.sessionId,
    cwd,
    // Default assume-exists; `annotateCwdExistence` (the async worker pass)
    // downgrades a dead cwd to `false`. A direct/pure use of the builder without
    // that pass therefore never hides a row — the pre-fix behavior.
    cwdExists: true,
    title: resolveEntryTitle(log, cwd),
    // The RECORDED title only (`custom-title` > `ai-title` — the loader folds both
    // into `customTitle`, `sessionStorage.ts:5262`), never the display cascade's
    // summary/first-prompt/basename fallbacks. This is the one catalog field
    // allowed to outrank the host registry's title (`protocol.ts` doc).
    transcriptTitle: nonEmpty(log.customTitle),
    modifiedAtMs: toMs(log.modified),
    createdAtMs: toMs(log.created),
    messageCount: log.messageCount ?? 0,
    gitBranch: nonEmpty(log.gitBranch),
    tag: nonEmpty(log.tag),
    mode: log.mode ?? null,
    agentSetting: nonEmpty(log.agentSetting),
    prNumber: log.prNumber ?? null,
    prRepository: nonEmpty(log.prRepository),
  }
}

/**
 * B3 / MAJOR-1 — a usable cwd for grouping, reconciled across a workspace. The
 * loader records `projectPath` (the real cwd) only when the transcript's head
 * window carried a `cwd` field (~60% of sessions here). The rest USED to fall
 * back to the transcript's sanitized storage dir (`dirname(fullPath)`, e.g.
 * `…/projects/-Users-me-proj`) — but that FRAGMENTS the workspace: `groupByWorkspace`
 * keys on the exact cwd string, so a session grouped by the sanitized dir splits
 * off from its siblings (and from the registry rows, which always carry the real
 * cwd) under an ugly, undecodable header (`sessionStoragePortable.ts:311` maps
 * every non-alnum char to `-`, so the sanitized name can't be decoded back).
 * Instead: borrow a sibling's real cwd for this storage dir (`storageDirToCwd`)
 * so the whole workspace groups as one. Only when NO session in this storage dir
 * recorded a cwd is it unresolved — prefer an EMPTY cwd (the renderer's "Unknown
 * workspace" bucket) over the lossy sanitized path.
 */
function resolveEntryCwd(
  log: LogOption,
  storageDirToCwd?: ReadonlyMap<string, string>,
): string {
  const explicit = nonEmpty(log.projectPath)
  if (explicit) return explicit
  if (log.fullPath && storageDirToCwd) {
    const real = storageDirToCwd.get(dirname(log.fullPath))
    if (real) return real
  }
  return ''
}

/**
 * MAJOR-1 — map each transcript storage dir (`dirname(fullPath)`) to the ONE real
 * cwd recorded by any session in it (via `projectPath`). First writer wins (all
 * sessions in a storage dir share one workspace, so the value is consistent);
 * dirs with no cwd-carrying session are simply absent (their sessions stay
 * unresolved → empty cwd).
 */
function buildStorageDirToCwd(logs: readonly LogOption[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const log of logs) {
    const explicit = nonEmpty(log.projectPath)
    if (!explicit || !log.fullPath) continue
    const dir = dirname(log.fullPath)
    if (!map.has(dir)) map.set(dir, explicit)
  }
  return map
}

/**
 * B2 — never emit an unlabeled row. Resolve the display title from real data:
 * user title > summary > first prompt > cwd basename. `firstPrompt` is the
 * user's own first message (what `/resume` shows), always populated by the
 * enrich path; the cwd-basename is the last resort. null only when nothing at
 * all is available — the renderer's `resolveSessionLabel` covers that with its
 * "New session" fallback, so no row is ever blank.
 */
function resolveEntryTitle(log: LogOption, cwd: string): string | null {
  const custom = nonEmpty(log.customTitle)
  if (custom) return custom
  const summary = nonEmpty(log.summary)
  if (summary) return summary
  const firstPrompt = nonEmpty(log.firstPrompt)
  if (firstPrompt) return firstPrompt
  const base = cwd ? nonEmpty(basename(cwd)) : null
  return base
}

function nonEmpty(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toMs(value: Date | number | undefined): number {
  if (value === undefined) return 0
  if (typeof value === 'number') return value
  const ms = value.getTime()
  return Number.isFinite(ms) ? ms : 0
}
