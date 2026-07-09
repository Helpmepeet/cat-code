/**
 * Sessions catalog domain (P4-6a) — the sidecar-owned engine-history half of
 * the Sessions catalog read-seam.
 *
 * The host plane is deliberately engine-free (`app/host/registry.ts:19`), so it
 * cannot enumerate transcripts; the sidecar (which runs the real engine) reads
 * them via the SAME loader `/resume` uses:
 * `loadAllProjectsMessageLogsProgressive` (`src/utils/sessionStorage.ts:4405`).
 * That loader stat-lists every project dir then ENRICHES only the most-recent
 * `SESSIONS_CATALOG_ENRICH_LIMIT` sessions (≤2×64KB head+tail reads each —
 * bounded, never a full scan), so the winning title (custom-title > ai-title,
 * inlined at `sessionStorage.ts:5180-5184` onto `LogOption.customTitle`), tag,
 * git branch and PR come from the same source the TUI shows. `messageCount`
 * (needs a full-chain read) and `mode` (undefined on the lite/enriched path)
 * are NOT populated by this loader — the catalog renders truth (0 / null) and
 * the page flags those chips (C3 render-truth precedent).
 *
 * Spawn-frozen (a point-in-time enumeration), read-only, display-metadata only
 * — no message bodies, no credentials — so the outbound frame is `secretGuard`-
 * clean by construction (§`sidecarServer.ts` prepareOutboundPayload/send).
 * Mirrors `agentConfigDomain.ts`'s pure-builder + async-wrapper split so the
 * mapping is unit-testable without the filesystem.
 */

import {
  loadAllProjectsMessageLogsProgressive,
  type SessionLogResult,
} from '../../src/utils/sessionStorage.js'
import type { LogOption } from '../../src/types/logs.js'
import type { SessionCatalogEntry, SessionsCatalogSnapshot } from '../shared/protocol.js'

/** Per-project stat cap (cheap readdir+stat). */
export const SESSIONS_CATALOG_STAT_LIMIT = 200
/** How many most-recent sessions get their metadata enriched (bounded reads). */
export const SESSIONS_CATALOG_ENRICH_LIMIT = 50

export type SidecarSessionsCatalogDomain = {
  /** Spawn-time catalog snapshot. null when the enumeration failed. */
  getSnapshot(): SessionsCatalogSnapshot | null
}

export async function createSidecarSessionsCatalogDomain(): Promise<SidecarSessionsCatalogDomain> {
  let snapshot: SessionsCatalogSnapshot | null = null
  try {
    const result = await loadAllProjectsMessageLogsProgressive(
      SESSIONS_CATALOG_STAT_LIMIT,
      SESSIONS_CATALOG_ENRICH_LIMIT,
    )
    snapshot = buildSessionsCatalogSnapshot(result)
  } catch {
    // A read failure degrades to "no catalog" — the page shows a load state,
    // never a crash (display = degrade gracefully).
    snapshot = null
  }
  return {
    getSnapshot() {
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
  return {
    sessionId: log.sessionId,
    cwd: log.projectPath ?? '',
    title: nonEmpty(log.customTitle),
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
