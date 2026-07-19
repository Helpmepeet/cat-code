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
  /** Latest catalog snapshot (spawn-time, then updated by `refresh`). null when the enumeration failed. */
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
  let snapshot: SessionsCatalogSnapshot | null = await enumerate()
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
  const entries = result.logs
    .map(mapLogOptionToCatalogEntry)
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

export function mapLogOptionToCatalogEntry(log: LogOption): SessionCatalogEntry | null {
  if (!log.sessionId) return null
  // enrichLogs already drops sidechains, but guard defensively.
  if (log.isSidechain) return null
  const cwd = resolveEntryCwd(log)
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
 * B3 — a usable cwd for grouping. The loader records `projectPath` only when
 * the transcript's head window carried a `cwd` field (~60% of sessions here);
 * the rest fall back to the transcript's own project directory
 * (`dirname(fullPath)`, e.g. `…/projects/-Users-me-proj`) so the row still
 * groups by workspace and never carries an empty cwd. (The sanitized dir name
 * is lossy — `sessionStoragePortable.ts:311` maps every non-alnum char to `-`,
 * so it can't be decoded back to the literal path — but it is stable + non-empty,
 * which is all grouping needs.)
 */
function resolveEntryCwd(log: LogOption): string {
  const explicit = nonEmpty(log.projectPath)
  if (explicit) return explicit
  if (log.fullPath) return dirname(log.fullPath)
  return ''
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
