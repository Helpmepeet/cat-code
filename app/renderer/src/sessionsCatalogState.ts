/**
 * Sessions catalog domain (P4-6a; catalog owner decision #4) — the renderer half
 * of the read-only cross-workspace session catalog.
 *
 * The catalog has two halves:
 *  - the host REGISTRY (`SessionDescriptor[]` from `listSessions()` + the
 *    HostEvent stream, already projected into `ShellState`) — the app's own
 *    live∪restorable rows, which alone can be opened/restored (HC1/RESTORE-
 *    HISTORY: only a registry row carries a restorable engine session id); and
 *  - the engine TRANSCRIPT HISTORY — every session ever run, across every
 *    workspace, with its real title/tag/branch/mode/PR/message-count (richer than
 *    the registry, but not directly openable when it has no registry row).
 *
 * The engine-history half is now enumerated by ONE main-supervised worker and
 * delivered as a `sessions-catalog` HOST EVENT (decision #4 shape (b),
 * `docs/migration/decisions/CATALOG-OWNERSHIP.md`), replacing the former
 * per-sidecar `sessions.snapshot` frame. It is a single GLOBAL enumeration, so
 * there is no per-session keying: `latestGood` holds the freshest delivered
 * catalog and `baseline` holds the cold-launch cache (lowest precedence).
 *
 * `selectMergedSessionRows` folds the two halves into one keyed list. It is the
 * SHARED selector D5 blessed for Welcome recents (P4-17) — build once, reuse there.
 *
 * Follows the `create/reduce/select` recipe (`agentConfigState.ts`). Status and
 * every derived field are computed at READ time; the stored snapshot is never
 * mutated.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type {
  SessionCatalogEntry,
  SessionId,
  SessionsCatalogSnapshot,
} from '../../shared/protocol.js'
import { basename } from './pathUtils.js'

export type SessionsCatalogState = {
  /**
   * The freshest global catalog delivered by the main-owned catalog worker via
   * the `sessions-catalog` host event. A failed worker run delivers nothing, so
   * this retains the last good snapshot — a stale catalog is still useful, a
   * blank one is a regression (the same doctrine the worker/cache path holds).
   */
  latestGood: SessionsCatalogSnapshot | null
  /**
   * The cold-launch persisted baseline (host cache, read once at startup). Lowest
   * precedence: any delivered live snapshot supersedes it, and it never
   * overwrites `latestGood`. Present so a launch that has not yet completed its
   * first catalog worker run still shows history.
   */
  baseline: SessionsCatalogSnapshot | null
}

export type SessionsCatalogAction =
  | { type: 'catalog'; snapshot: SessionsCatalogSnapshot }
  | { type: 'baseline'; snapshot: SessionsCatalogSnapshot }

export function createSessionsCatalogState(): SessionsCatalogState {
  return { latestGood: null, baseline: null }
}

export function reduceSessionsCatalogState(
  state: SessionsCatalogState,
  action: SessionsCatalogAction,
): SessionsCatalogState {
  if (action.type === 'baseline') {
    // Fold the startup cache as the lowest-precedence source only — never touch
    // `latestGood`, so a baseline arriving after a live snapshot can never
    // clobber it (select prefers latestGood > baseline).
    if (state.baseline === action.snapshot) return state
    return { ...state, baseline: action.snapshot }
  }

  // A refreshed global catalog from the main-owned worker (decision #4). Retain
  // it as the freshest source; the baseline survives underneath.
  if (state.latestGood === action.snapshot) return state
  return { ...state, latestGood: action.snapshot }
}

export function selectSessionsCatalog(
  state: SessionsCatalogState,
): SessionsCatalogSnapshot | null {
  // The freshest delivered global catalog > the cold-launch baseline. The catalog
  // is a single global point-in-time enumeration (one main-owned worker), so
  // there is no per-session slot to prefer.
  return state.latestGood ?? state.baseline ?? null
}

/**
 * One merged catalog row. `inRegistry` rows carry an `appSessionId` and are
 * opened/restored directly; a `history`-only row has no registry row but is now
 * openable by its ENGINE session id (`sessionId`) via the `openHistorySession`
 * host path (SESSIONS-UNIFICATION, operator ruling 2026-07-20 — the former
 * P4-6b browse-only gap), UNLESS its cwd is empty (MAJOR-1, unreconcilable
 * workspace), in which case it stays browse-only.
 */
export type MergedSessionRow = {
  /** The transcript session id (the merge key). */
  sessionId: string
  /** Present ⇒ a live/restorable registry row exists (openable). */
  appSessionId: SessionId | null
  cwd: string
  /** Resolved winner: registry title > catalog (custom/ai) title > null. */
  title: string | null
  /** The label to render: title > first prompt > cwd basename > fallback. */
  displayLabel: string
  /** A live registry row with a running process. */
  live: boolean
  /** A registry row whose process is gone but can be re-spawned. */
  restorable: boolean
  /** Registry status, or `history` for a transcript with no registry row. */
  status: SessionDescriptor['status'] | 'history'
  inRegistry: boolean
  modifiedAtMs: number
  createdAtMs: number
  /**
   * Wall-clock of the last MESSAGE SENT by this session's registry descriptor, or
   * null (history-only rows, and registry rows that have sent nothing). Carried so
   * the Sidebar can order registry rows warp-free (CC-2: a row floats up ONLY on a
   * real message-send, never on open/restore — `lastMessageSentAt` never bumps on
   * attach). NOT the same as `modifiedAtMs`, which folds in `lastAttachedAt` for a
   * transcript-less row and would reintroduce the warp. The mtime-desc sort of
   * `selectMergedSessionRows` (Sessions page / Welcome recents) is unchanged.
   */
  lastMessageSentAt: number | null
  /**
   * Last activity recorded in the TRANSCRIPT itself, or null when this row has no
   * catalog entry (a session created in the app that has not been enumerated yet).
   * Unlike `modifiedAtMs` this never folds in `lastAttachedAt`, so ordering can
   * fall back to real prior work instead of a spawn/attach time: a terminal
   * session opened in the app is minted with `createdAt = the moment it was
   * clicked`, and using that would float it to the top of the sidebar on open —
   * the exact warp CC-2 removed.
   */
  transcriptActivityAtMs: number | null
  messageCount: number
  gitBranch: string | null
  tag: string | null
  mode: 'agent' | 'coordinator' | 'normal' | null
  agentSetting: string | null
  prNumber: number | null
  prRepository: string | null
}

/**
 * The shared title resolver — a superset of `TabBar.tsx`'s `tabLabel`, extended
 * to consult the catalog title (the P4-6 rider) before falling back to the cwd
 * basename. Kept in lockstep with `tabLabel` so every surface reads one name.
 */
export function resolveSessionLabel(title: string | null, cwd: string): string {
  if (title && title.trim().length > 0) return title.trim()
  const base = basename(cwd)
  return base.length > 0 ? base : 'New session'
}

/**
 * Merge registry descriptors with the engine-history catalog into one keyed
 * list, newest-first by mtime. Registry rows win the key (they carry openable
 * ids + live status); the catalog contributes rich metadata (title/tag/branch/
 * mode/PR/count) and any history-only sessions.
 */
export function selectMergedSessionRows(
  descriptors: readonly SessionDescriptor[],
  catalog: SessionsCatalogSnapshot | null,
): MergedSessionRow[] {
  const byId = new Map<string, SessionCatalogEntry>()
  for (const entry of catalog?.entries ?? []) {
    byId.set(entry.sessionId, entry)
  }

  const rows: MergedSessionRow[] = []
  const claimed = new Set<string>()

  // Registry rows first — they own the merge key and carry openable status.
  for (const descriptor of descriptors) {
    const key = descriptor.engineSessionId ?? descriptor.appSessionId
    const entry = descriptor.engineSessionId
      ? byId.get(descriptor.engineSessionId)
      : undefined
    if (descriptor.engineSessionId) claimed.add(descriptor.engineSessionId)
    const title = pickTitle(descriptor.title, entry?.title ?? null)
    rows.push({
      sessionId: key,
      appSessionId: descriptor.appSessionId,
      cwd: descriptor.cwd,
      title,
      displayLabel: resolveSessionLabel(title, descriptor.cwd),
      live: !descriptor.restorable && descriptor.status !== 'exited',
      restorable: descriptor.restorable,
      status: descriptor.status,
      inRegistry: true,
      modifiedAtMs: entry?.modifiedAtMs ?? descriptor.lastAttachedAt,
      createdAtMs: entry?.createdAtMs ?? descriptor.createdAt,
      lastMessageSentAt: descriptor.lastMessageSentAt,
      transcriptActivityAtMs: entry?.modifiedAtMs ?? null,
      messageCount: entry?.messageCount ?? 0,
      gitBranch: entry?.gitBranch ?? null,
      tag: entry?.tag ?? null,
      mode: entry?.mode ?? null,
      agentSetting: entry?.agentSetting ?? null,
      prNumber: entry?.prNumber ?? null,
      prRepository: entry?.prRepository ?? null,
    })
  }

  // History-only sessions the registry never tracked (e.g. TUI sessions).
  for (const entry of catalog?.entries ?? []) {
    if (claimed.has(entry.sessionId)) continue
    rows.push({
      sessionId: entry.sessionId,
      appSessionId: null,
      cwd: entry.cwd,
      title: entry.title,
      displayLabel: resolveSessionLabel(entry.title, entry.cwd),
      live: false,
      restorable: false,
      status: 'history',
      inRegistry: false,
      modifiedAtMs: entry.modifiedAtMs,
      createdAtMs: entry.createdAtMs,
      lastMessageSentAt: null,
      transcriptActivityAtMs: entry.modifiedAtMs,
      messageCount: entry.messageCount,
      gitBranch: entry.gitBranch,
      tag: entry.tag,
      mode: entry.mode,
      agentSetting: entry.agentSetting,
      prNumber: entry.prNumber,
      prRepository: entry.prRepository,
    })
  }

  rows.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return rows
}

function pickTitle(registryTitle: string | null, catalogTitle: string | null): string | null {
  if (registryTitle && registryTitle.trim().length > 0) return registryTitle
  if (catalogTitle && catalogTitle.trim().length > 0) return catalogTitle
  return null
}

/* ------------------------------------------------------------------------- *
 * Browse selectors (SessionsPage — search / sort / filter / group)
 * ------------------------------------------------------------------------- */

export type SessionSort = 'recent' | 'name'

/**
 * Filter rows by the free-text query (title/branch/tag/PR/cwd), the active tag
 * tab, and the workspace scope. `allWorkspaces=false` keeps only rows whose cwd
 * matches the active session's cwd (the real analog of the prototype's
 * `CURRENT_WORKSPACE`, which is derived from cwd here — no mock workspace name).
 */
export function filterSessionRows(
  rows: readonly MergedSessionRow[],
  options: {
    query?: string
    tag?: string | null
    activeCwd?: string | null
    allWorkspaces?: boolean
  },
): MergedSessionRow[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const tag = options.tag && options.tag !== 'all' ? options.tag : null
  const scopeCwd =
    options.allWorkspaces === false && options.activeCwd ? options.activeCwd : null

  return rows.filter(row => {
    if (scopeCwd && row.cwd !== scopeCwd) return false
    if (tag && row.tag !== tag) return false
    if (query) {
      const haystack = [
        row.displayLabel,
        row.title ?? '',
        row.gitBranch ?? '',
        row.tag ?? '',
        row.cwd,
        row.prNumber != null ? `${row.prRepository ?? ''}#${row.prNumber}` : '',
      ]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

/**
 * Sort a row list. `recent`=mtime desc, `name`=label A–Z. The former `active`
 * (message-count desc) sort was removed (§I.7): the bounded catalog loader never
 * populates `messageCount` (`sessionsCatalogDomain.ts` header — it needs a
 * full-chain read), so "Most active" silently degraded to mtime for every row.
 */
export function sortSessionRows(
  rows: readonly MergedSessionRow[],
  sort: SessionSort,
): MergedSessionRow[] {
  const copy = [...rows]
  switch (sort) {
    case 'name':
      copy.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel))
      break
    case 'recent':
    default:
      copy.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
      break
  }
  return copy
}

/** The distinct tags across rows, for the tag-filter tabs (sorted, no nulls). */
export function collectSessionTags(rows: readonly MergedSessionRow[]): string[] {
  const tags = new Set<string>()
  for (const row of rows) {
    if (row.tag && row.tag.trim().length > 0) tags.add(row.tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}

/** The distinct workspaces (cwds) in a row list. */
export function countWorkspaces(rows: readonly MergedSessionRow[]): number {
  const cwds = new Set<string>()
  for (const row of rows) cwds.add(row.cwd)
  return cwds.size
}

export type WorkspaceGroup = {
  cwd: string
  name: string
  current: boolean
  rows: MergedSessionRow[]
}

/**
 * Group rows by workspace (cwd), ordered alphabetically by basename and FROZEN —
 * the group order does NOT depend on which session is active, so opening a
 * session never floats its workspace to the top (operator, 2026-07-21). The
 * prototype's `groupByWorkspace` (`~/catcode_prototype/cat-app/Sidebar.jsx:26`)
 * is likewise activeCwd-free and purely alphabetical; its "current workspace
 * first" comment was aspirational and never implemented, so an earlier port that
 * sorted active-first was a parity regression. `current` (cwd === activeCwd) is
 * still computed for the Sessions page's active-workspace highlight
 * (`SessionsPage.tsx`); it just no longer drives ORDER. Rows with an empty cwd (a
 * transcript whose workspace couldn't be reconciled — MAJOR-1) collect in a
 * single clearly-labeled "Unknown workspace" bucket rather than under a blank or
 * fragmented header.
 */
export function groupByWorkspace(
  rows: readonly MergedSessionRow[],
  activeCwd: string | null,
): WorkspaceGroup[] {
  const groups = new Map<string, MergedSessionRow[]>()
  for (const row of rows) {
    const list = groups.get(row.cwd)
    if (list) list.push(row)
    else groups.set(row.cwd, [row])
  }
  return [...groups.entries()]
    .map(([cwd, groupRows]) => ({
      cwd,
      name: cwd ? basename(cwd) || cwd : 'Unknown workspace',
      current: activeCwd != null && cwd === activeCwd,
      rows: groupRows,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * One derived "recent project" for the Welcome launcher (P4-17). The launcher's
 * recents are PROJECTS (distinct cwd), not individual sessions — the D5 ruling
 * (`decisions/WELCOME-LAUNCHER.md` W6): registry rows ∪ engine history collapsed
 * by workspace, most-recent-first, trust-badged. This is a projection OVER the
 * already-merged `selectMergedSessionRows` output (the shared P4-6 selector — no
 * second merge is built), the same way `groupByWorkspace` is.
 */
export type RecentWorkspace = {
  cwd: string
  /** basename(cwd) for the label. */
  name: string
  /**
   * The most-recent registry-backed session in this workspace (a row carrying an
   * app id), or null when every row here is history-only. The Welcome launcher
   * opens recents by `appSessionId` (select/restore); a purely-history project
   * has none, so the launcher shows it browse-only. NOTE: the sidebar/Sessions
   * page now open a history row by its ENGINE id via `openHistorySession`
   * (SESSIONS-UNIFICATION 2026-07-20) — the launcher could adopt that same path,
   * a follow-on not wired here (out of the sessions-unification scope).
   */
  appSessionId: string | null
  /** True when the openable row is live (select), false ⇒ restore. */
  live: boolean
  modifiedAtMs: number
  /**
   * Per-path trust from the join of live sessions' `workspace-trust.snapshot`
   * with their descriptors (App wires it): true/false when a reporting session
   * exists for this cwd, null when unknown (no live session ⇒ no trust seam;
   * the launcher grows no new feed — WELCOME-LAUNCHER §6).
   */
  trusted: boolean | null
  sessionCount: number
}

/**
 * Collapse merged session rows into distinct-workspace recents, newest-first,
 * capped to `limit`. Prefers an openable (registry) row's app id + live flag so
 * a project with any openable session can be reopened; a purely-history project
 * yields `appSessionId: null`.
 */
export function selectRecentWorkspaces(
  rows: readonly MergedSessionRow[],
  trustByCwd: ReadonlyMap<string, boolean>,
  limit = 6,
): RecentWorkspace[] {
  const byCwd = new Map<string, RecentWorkspace>()
  for (const row of rows) {
    const existing = byCwd.get(row.cwd)
    if (!existing) {
      byCwd.set(row.cwd, {
        cwd: row.cwd,
        name: basename(row.cwd) || row.cwd,
        appSessionId: row.appSessionId,
        live: row.live,
        modifiedAtMs: row.modifiedAtMs,
        trusted: trustByCwd.has(row.cwd) ? trustByCwd.get(row.cwd)! : null,
        sessionCount: 1,
      })
      continue
    }
    existing.sessionCount += 1
    if (row.modifiedAtMs > existing.modifiedAtMs) {
      existing.modifiedAtMs = row.modifiedAtMs
    }
    // Adopt the first openable id we see (rows arrive newest-first from the
    // merge, so the earliest openable is also the most recent openable).
    if (existing.appSessionId == null && row.appSessionId != null) {
      existing.appSessionId = row.appSessionId
      existing.live = row.live
    }
  }
  return [...byCwd.values()]
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, limit)
}

export type DateBucket = { label: string; rows: MergedSessionRow[] }

/**
 * Bucket rows by real mtime into Today / Yesterday / This week / Older (empty
 * buckets dropped). Replaces the prototype's mock `'Nm ago'` string parser with
 * real timestamps. Rows are assumed already sorted newest-first.
 */
export function bucketByDate(
  rows: readonly MergedSessionRow[],
  nowMs: number,
): DateBucket[] {
  const startOfToday = new Date(nowMs)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000
  const weekMs = todayMs - 6 * 24 * 60 * 60 * 1000

  const buckets: Record<string, MergedSessionRow[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Older: [],
  }
  for (const row of rows) {
    if (row.modifiedAtMs >= todayMs) buckets.Today.push(row)
    else if (row.modifiedAtMs >= yesterdayMs) buckets.Yesterday.push(row)
    else if (row.modifiedAtMs >= weekMs) buckets['This week'].push(row)
    else buckets.Older.push(row)
  }
  return (['Today', 'Yesterday', 'This week', 'Older'] as const)
    .map(label => ({ label, rows: buckets[label]! }))
    .filter(bucket => bucket.rows.length > 0)
}

/** Human-friendly relative time for the "last activity" meta chip. */
export function formatRelativeTime(fromMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.round((nowMs - fromMs) / 1000))
  if (deltaSec < 60) return 'just now'
  const min = Math.round(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.round(hr / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(days / 365)}y ago`
}
