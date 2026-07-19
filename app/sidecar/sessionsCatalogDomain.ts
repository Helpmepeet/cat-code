/**
 * Sessions catalog domain (P4-6a) — the sidecar-owned engine-history half of
 * the Sessions catalog read-seam.
 *
 * The host plane is deliberately engine-free (`app/host/registry.ts:19`), so it
 * cannot enumerate transcripts; the sidecar (which runs the real engine) reads
 * them via the SAME loader `/resume` uses:
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
 * head+tail read, never a full transcript read of all 2k+ files) and adds a
 * `refresh()` so a periodic sidecar re-enumeration re-broadcasts a fresh,
 * de-staled catalog (a session created after this sidecar spawned then appears
 * without a new inbound verb — `sidecarServer.ts` owns the timer + broadcast).
 *
 * Construction is NON-BLOCKING (#16 review, MAJOR-2): raising the enrich cap to
 * 600 made the enumeration ~10× costlier (~430ms), and it used to run inside the
 * controller builder that `index.ts` awaits BEFORE `Bun.listen`, so every session
 * open waited the full enumeration before the socket was attachable. The domain
 * now constructs with a null snapshot (the renderer already shows a load state)
 * and the first enumeration runs asynchronously via `refresh()`, kicked by the
 * server right after a connection attaches and re-broadcast once ready — the
 * socket opens without waiting on it.
 *
 * Read-only, display-metadata only — no message bodies, no credentials — so the
 * outbound frame is `secretGuard`-clean by construction (§`sidecarServer.ts`
 * prepareOutboundPayload/send). Mirrors `agentConfigDomain.ts`'s pure-builder +
 * async-wrapper split so the mapping is unit-testable without the filesystem.
 */

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

export type SidecarSessionsCatalogDomain = {
  /**
   * Latest catalog snapshot. null until the first `refresh()` completes (the
   * enumeration is deferred off the construction/listen critical path — MAJOR-2)
   * and still null if that first enumeration failed (a later `refresh()` recovers).
   */
  getSnapshot(): SessionsCatalogSnapshot | null
  /**
   * B4 — re-enumerate transcripts and update the stored snapshot so a session
   * created after this sidecar spawned becomes visible (de-stale). A failed
   * re-enumeration keeps the last good snapshot (degrade, don't blank). Returns
   * the current snapshot after the attempt.
   */
  refresh(): Promise<SessionsCatalogSnapshot | null>
}

async function enumerateSessionsCatalog(): Promise<SessionsCatalogSnapshot | null> {
  try {
    const result = await loadAllProjectsMessageLogsProgressive(
      SESSIONS_CATALOG_STAT_LIMIT,
      SESSIONS_CATALOG_ENRICH_LIMIT,
    )
    return buildSessionsCatalogSnapshot(result)
  } catch {
    // A read failure degrades to "no catalog" — the page shows a load state,
    // never a crash (display = degrade gracefully).
    return null
  }
}

export async function createSidecarSessionsCatalogDomain(
  // `enumerate` is injectable ONLY so tests can drive refresh/de-stale hermetically
  // (the real path reads the filesystem); production always uses the default.
  enumerate: () => Promise<SessionsCatalogSnapshot | null> = enumerateSessionsCatalog,
): Promise<SidecarSessionsCatalogDomain> {
  // MAJOR-2 — do NOT enumerate here: the controller builder that calls this is
  // awaited before `Bun.listen`, so awaiting the ~430ms enumeration would block
  // every session open on it. Start null; the server kicks the first `refresh()`
  // on attach and re-broadcasts once it lands (see `refresh()` / `sidecarServer.ts`).
  let snapshot: SessionsCatalogSnapshot | null = null
  return {
    getSnapshot() {
      return snapshot
    },
    async refresh() {
      const next = await enumerate()
      // Keep the last good snapshot on a transient re-read failure — a stale
      // catalog is still useful; a blank one is a regression.
      if (next) snapshot = next
      return snapshot
    },
  }
}

export function buildSessionsCatalogSnapshot(result: SessionLogResult): SessionsCatalogSnapshot {
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
  const truncated = result.allStatLogs.length > result.logs.length
  const notes = [
    'Message counts and mode require a full transcript read and are not carried on this bounded catalog.',
    truncated
      ? `Only the ${entries.length} most-recent sessions are enriched; older sessions are omitted.`
      : 'All discovered sessions are enriched.',
  ]
  return { entries, truncated, notes }
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
  const cwd = resolveEntryCwd(log, storageDirToCwd)
  return {
    sessionId: log.sessionId,
    cwd,
    title: resolveEntryTitle(log, cwd),
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
