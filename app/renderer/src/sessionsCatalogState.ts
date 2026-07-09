/**
 * Sessions catalog domain (P4-6a) — the renderer half of the read-only
 * cross-workspace session catalog.
 *
 * The catalog has two halves:
 *  - the host REGISTRY (`SessionDescriptor[]` from `listSessions()` + the
 *    HostEvent stream, already projected into `ShellState`) — the app's own
 *    live∪restorable rows, which alone can be opened/restored (HC1/RESTORE-
 *    HISTORY: only a registry row carries a restorable engine session id); and
 *  - the engine TRANSCRIPT HISTORY (`sessions.snapshot` frame) — every session
 *    ever run, across every workspace, with its real title/tag/branch/mode/PR/
 *    message-count (richer than the registry, but not directly openable when it
 *    has no registry row).
 *
 * `selectMergedSessionRows` folds the two into one keyed list. It is the SHARED
 * selector D5 blessed for Welcome recents (P4-17) — build once, reuse there.
 *
 * Follows the `create/reduce/select` recipe (`agentConfigState.ts`). Status and
 * every derived field are computed at READ time; the stored snapshot is never
 * mutated.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type {
  ServerFrame,
  SessionCatalogEntry,
  SessionId,
  SessionsCatalogSnapshot,
} from '../../shared/protocol.js'
import { basename } from './pathUtils.js'

export type SessionsCatalogState = {
  /**
   * Keyed by the emitting session (recipe conformance). The catalog is a global
   * point-in-time enumeration, so any session's snapshot is a valid source; the
   * page reads the ACTIVE session's (freshest for that sidecar).
   */
  sessions: Record<SessionId, SessionsCatalogSnapshot | null>
}

export type SessionsCatalogAction = { type: 'frame'; frame: ServerFrame }

export function createSessionsCatalogState(): SessionsCatalogState {
  return { sessions: {} }
}

export function reduceSessionsCatalogState(
  state: SessionsCatalogState,
  action: SessionsCatalogAction,
): SessionsCatalogState {
  const { frame } = action

  if (frame.kind === 'sessions.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.catalog },
    }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

export function selectSessionsCatalog(
  state: SessionsCatalogState,
  sessionId: SessionId | null,
): SessionsCatalogSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * One merged catalog row. `inRegistry` rows carry an `appSessionId` and can be
 * opened/restored; `history`-only rows are browse/inspect-only (no registry row
 * → no host restore path today — flagged as a P4-6b host-API gap).
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

export type SessionSort = 'recent' | 'active' | 'name'

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

/** Sort a row list. `recent`=mtime desc, `active`=message count desc, `name`=label A–Z. */
export function sortSessionRows(
  rows: readonly MergedSessionRow[],
  sort: SessionSort,
): MergedSessionRow[] {
  const copy = [...rows]
  switch (sort) {
    case 'active':
      copy.sort((a, b) => b.messageCount - a.messageCount || b.modifiedAtMs - a.modifiedAtMs)
      break
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
 * Group rows by workspace (cwd), the active session's workspace first, then the
 * rest alphabetically by basename — the real analog of the prototype's
 * `groupByWorkspace` (which keyed on a mock workspace name).
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
      name: basename(cwd) || cwd,
      current: activeCwd != null && cwd === activeCwd,
      rows: groupRows,
    }))
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      return a.name.localeCompare(b.name)
    })
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
