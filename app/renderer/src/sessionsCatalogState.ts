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
  /**
   * Whether `cwd` is a currently-existing directory (bug-sweep #1). Registry rows
   * are ALWAYS `true` — a live/restorable session is addressed by `appSessionId`,
   * not its cwd, so it opens regardless. A history-only row carries the catalog's
   * stat result; a dead-cwd history row is HIDDEN from the sidebar rail
   * (`isSidebarVisibleRow`) and non-openable (`deriveMergedRowVisual`), rather than
   * failing `invalid_cwd` only at open time.
   */
  cwdExists: boolean
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
  /** IDLE-PARK: the engine was reclaimed on purpose, not lost. Always false for
   * a history row, which never had a registry row to park. */
  parked: boolean
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
    const title = pickTitle(descriptor, entry ?? null, catalog?.capturedAtMs ?? 0)
    rows.push({
      sessionId: key,
      appSessionId: descriptor.appSessionId,
      cwd: descriptor.cwd,
      // A registry row is addressed by appSessionId, not cwd — always openable/
      // visible regardless of whether its recorded cwd still exists.
      cwdExists: true,
      title,
      displayLabel: resolveSessionLabel(title, descriptor.cwd),
      live: !descriptor.restorable && descriptor.status !== 'exited',
      restorable: descriptor.restorable,
      status: descriptor.status,
      parked: descriptor.parked,
      inRegistry: true,
      modifiedAtMs: entry?.modifiedAtMs ?? descriptor.lastAttachedAt,
      createdAtMs: entry?.createdAtMs ?? descriptor.createdAt,
      lastMessageSentAt: descriptor.lastMessageSentAt,
      transcriptActivityAtMs: entry?.modifiedAtMs ?? null,
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
      cwdExists: entry.cwdExists,
      title: entry.title,
      displayLabel: resolveSessionLabel(entry.title, entry.cwd),
      live: false,
      restorable: false,
      status: 'history',
      parked: false,
      inRegistry: false,
      modifiedAtMs: entry.modifiedAtMs,
      createdAtMs: entry.createdAtMs,
      lastMessageSentAt: null,
      transcriptActivityAtMs: entry.modifiedAtMs,
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

/**
 * Title precedence — NEWEST INTENT WINS, and only a real recorded title counts.
 *
 * Two writers name a session and they do not see each other:
 *  - the app, whose name lives on the host registry row (`descriptor.title`) —
 *    written by the desktop rename verb, by the AI title-rider, and by
 *    open-from-history seeding (`app/main/openHistorySession.ts:117`); and
 *  - the engine transcript, written by the terminal `/rename`
 *    (`src/commands/rename/rename.ts:57` → `saveCustomTitle`) and by
 *    `saveAiGeneratedTitle`, surfaced here as `entry.transcriptTitle`.
 *
 * Preferring the registry unconditionally (the pre-fix rule) made a terminal
 * rename permanently invisible on any row the app had ever opened: opening a row
 * gives it a registry title, and nothing re-reads the transcript's name afterwards
 * (`app/sidecar/sidecarServer.ts:2484` — the title frame is deliberately not part
 * of attach/replay). Preferring the transcript unconditionally is equally wrong in
 * the other direction: the catalog is a periodic global enumeration, so a desktop
 * rename would visibly revert to the old name until the next run.
 *
 * So compare the two timestamps that actually exist: `descriptor.titleUpdatedAt`
 * (when the app last recorded a title) against `catalog.capturedAtMs` (when this
 * enumeration started, hence a lower bound on when it read the transcript). A
 * transcript title wins only when it was read after the app's own write. A desktop
 * rename writes BOTH sides (`sessionActionsDomain.ts:76` + `broadcastSessionTitle`
 * → `host.setTitle`), so once the catalog does catch up it carries the same
 * string — the rule never flickers.
 *
 * `entry.transcriptTitle`, not `entry.title`: the latter is a display cascade that
 * falls through to the summary, the first prompt and the cwd basename, so letting
 * it outrank the registry would replace a real app title with prompt text.
 *
 * A history-only row has no descriptor and never reaches here — it keeps reading
 * the catalog title directly, which is why a terminal rename ALWAYS showed on
 * never-opened rows.
 */
function pickTitle(
  descriptor: Pick<SessionDescriptor, 'title' | 'titleUpdatedAt'>,
  entry: Pick<SessionCatalogEntry, 'title' | 'transcriptTitle'> | null,
  catalogCapturedAtMs: number,
): string | null {
  const registryTitle = descriptor.title
  const transcriptTitle = entry?.transcriptTitle ?? null
  if (
    transcriptTitle &&
    transcriptTitle.trim().length > 0 &&
    // A snapshot of unknown age (0 — a pre-field cache file) never outranks.
    catalogCapturedAtMs > (descriptor.titleUpdatedAt ?? 0)
  ) {
    return transcriptTitle
  }
  if (registryTitle && registryTitle.trim().length > 0) return registryTitle
  const catalogTitle = entry?.title ?? null
  if (catalogTitle && catalogTitle.trim().length > 0) return catalogTitle
  return null
}

/**
 * The same resolution for surfaces that render a lone descriptor rather than a
 * merged row (the TabBar via `tabLabel`). Returns a descriptor whose `title` is
 * the resolved winner, so one precedence rule serves the tab, the sidebar and the
 * Sessions page — the `resolveSessionLabel`/`tabLabel` lockstep note above.
 */
export function withResolvedTitle(
  descriptor: SessionDescriptor,
  catalog: SessionsCatalogSnapshot | null,
): SessionDescriptor {
  if (!descriptor.engineSessionId) return descriptor
  const entry = catalog?.entries.find(
    candidate => candidate.sessionId === descriptor.engineSessionId,
  )
  if (!entry) return descriptor
  const title = pickTitle(descriptor, entry, catalog?.capturedAtMs ?? 0)
  return title === descriptor.title ? descriptor : { ...descriptor, title }
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

/**
 * How a catalog row must be OPENED — the one place that decision lives (P4-29).
 *
 * Every open path had re-derived it inline, and one of them got it wrong: the ⋯
 * menu's `open` verb ran a bare `selectTab` for BOTH live and restorable rows,
 * so a row whose own menu said "Restore" only re-focused a stale, dead pane
 * (`App.tsx`; the menu is reachable for any registry row, live or not). The
 * routes:
 *
 *  - `focus`   — a live registry row: pure UI focus, no frame-stream touch.
 *  - `restore` — a registry row whose process is gone: re-spawn it first.
 *  - `history` — a terminal-history row with a resolvable workspace, opened by
 *    its ENGINE id (the SESSIONS-UNIFICATION ruling, 2026-07-20).
 *  - `none`    — history with no recorded workspace: browse-only.
 */
export type SessionOpenRoute =
  | { kind: 'focus'; appSessionId: SessionId }
  | { kind: 'restore'; appSessionId: SessionId }
  | { kind: 'history'; engineSessionId: string }
  | { kind: 'none' }

export function resolveSessionOpenRoute(
  row: Pick<
    MergedSessionRow,
    'appSessionId' | 'live' | 'cwd' | 'cwdExists' | 'sessionId' | 'inRegistry'
  >,
): SessionOpenRoute {
  if (row.appSessionId != null) {
    return row.live
      ? { kind: 'focus', appSessionId: row.appSessionId }
      : { kind: 'restore', appSessionId: row.appSessionId }
  }
  if (!row.inRegistry && row.cwd.trim().length > 0 && row.cwdExists) {
    return { kind: 'history', engineSessionId: row.sessionId }
  }
  return { kind: 'none' }
}

/**
 * The row's ENGINE session id, or null when nothing has named this session yet.
 *
 * `sessionId` is the merge key `engineSessionId ?? appSessionId`
 * (`selectMergedSessionRows` above), so the key EQUALLING `appSessionId` is
 * exactly the "no engine id yet" case: a registry row the app minted whose
 * sidecar has not relayed one on its ready frame (`app/host/host.ts`). A
 * history row has no `appSessionId` at all, so its key is always the engine id.
 */
export function selectRowEngineSessionId(
  row: Pick<MergedSessionRow, 'sessionId' | 'appSessionId'>,
): string | null {
  return row.sessionId === row.appSessionId ? null : row.sessionId
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
 * The label a workspace shows when `depth` leading path segments are needed to
 * tell it apart: depth 1 is the bare basename (today's label), depth N is the
 * last N segments, and once N reaches the segment count the label is the FULL
 * cwd — which is unique by construction, since the cwd is the group key. That
 * last property is what terminates `disambiguateWorkspaceLabels`.
 */
function workspaceLabelAtDepth(cwd: string, depth: number): string {
  if (depth <= 1) return basename(cwd) || cwd
  const segments = cwd
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(segment => segment.length > 0)
  if (depth >= segments.length) return cwd
  return segments.slice(-depth).join('/')
}

/**
 * cwd → display label, giving each workspace the SHORTEST leading path that
 * distinguishes it from every other workspace on screen (the editor idiom:
 * `cat-code/app` vs `PTClove/app`, while an uncontested `discordbot` stays
 * bare). Operator-reported 2026-07-26: two adjacent groups both labelled `APP`
 * (`/Users/pt/cat-code/app` and `/Users/pt/PTClove/app`) were indistinguishable
 * and the wrong one was nearly deleted.
 *
 * Grow PROGRESSIVELY rather than always adding one parent: three projects at
 * `/a/x/app` and `/b/x/app` all end `x/app`, so a fixed one-segment prefix would
 * leave the exact defect in place. Each collision round widens only the still-
 * colliding labels, so a unique basename never pays for someone else's clash.
 *
 * Read-time only — every cwd is already in hand, so nothing crosses a seam.
 */
function disambiguateWorkspaceLabels(
  cwds: readonly string[],
): Map<string, string> {
  const depths = new Map<string, number>()
  for (const cwd of cwds) depths.set(cwd, 1)

  for (;;) {
    const byLabel = new Map<string, string[]>()
    for (const [cwd, depth] of depths) {
      const label = workspaceLabelAtDepth(cwd, depth)
      const sharing = byLabel.get(label)
      if (sharing) sharing.push(cwd)
      else byLabel.set(label, [cwd])
    }

    let widened = false
    for (const sharing of byLabel.values()) {
      if (sharing.length < 2) continue
      for (const cwd of sharing) {
        const depth = depths.get(cwd) ?? 1
        // Already showing its full path: it cannot widen further, and its label
        // is unique, so leaving it fixed is what bounds this loop.
        if (workspaceLabelAtDepth(cwd, depth) === cwd) continue
        depths.set(cwd, depth + 1)
        widened = true
      }
    }
    if (widened) continue

    const labels = new Map<string, string>()
    for (const [cwd, depth] of depths) {
      labels.set(cwd, workspaceLabelAtDepth(cwd, depth))
    }
    return labels
  }
}

/**
 * Group rows by workspace (cwd), ordered alphabetically by the rendered label and
 * FROZEN — the group order does NOT depend on which session is active, so opening
 * a session never floats its workspace to the top (operator, 2026-07-21). The
 * prototype's `groupByWorkspace` (`~/catcode_prototype/cat-app/Sidebar.jsx:26`)
 * is likewise activeCwd-free and purely alphabetical; its "current workspace
 * first" comment was aspirational and never implemented, so an earlier port that
 * sorted active-first was a parity regression. `current` (cwd === activeCwd) is
 * still computed for the Sessions page's active-workspace highlight
 * (`SessionsPage.tsx`); it just no longer drives ORDER. Rows with an empty cwd (a
 * transcript whose workspace couldn't be reconciled — MAJOR-1) collect in a
 * single clearly-labeled "Unknown workspace" bucket rather than under a blank or
 * fragmented header — and that bucket is held OUT of the label disambiguation,
 * since it has no path to widen.
 *
 * Labels come from `disambiguateWorkspaceLabels`, so two workspaces that share a
 * basename are told apart by leading path. Sorting on the LABEL (not the bare
 * basename) keeps what the operator reads alphabetical; it stays a pure function
 * of the cwd set, so the frozen-order guarantee is untouched. The prototype
 * models `workspace` as a mock string with no path (`Sidebar.jsx:26`), so it has
 * no position on basename collisions — there is nothing here to port or match.
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
  const labels = disambiguateWorkspaceLabels(
    [...groups.keys()].filter(cwd => cwd.length > 0),
  )
  return [...groups.entries()]
    .map(([cwd, groupRows]) => ({
      cwd,
      name: cwd ? labels.get(cwd) ?? cwd : 'Unknown workspace',
      current: activeCwd != null && cwd === activeCwd,
      rows: groupRows,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd))
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
  /**
   * The label to render for this project — the cwd basename when nothing else in
   * the list shares it, otherwise the shortest leading path that tells them apart
   * (`disambiguateWorkspaceLabels`, the same helper the sidebar's group headers
   * use). NOT simply `basename(cwd)`: see `selectRecentWorkspaces`.
   */
  name: string
  /**
   * The most-recent registry-backed session in this workspace (a row carrying an
   * app id), or null when every session in it was created in the terminal. It
   * WINS when both identities exist: an already-known desktop session is focused
   * or restored rather than resumed a second time from its transcript.
   */
  appSessionId: string | null
  /** True when the openable row is live (select), false ⇒ restore. */
  live: boolean
  /**
   * The engine session id this project opens by when it has no registry row —
   * every session in it was created in the terminal (P4-40). Routed through
   * `openHistorySession`, the SAME path the sidebar and the Sessions page take
   * (SESSIONS-UNIFICATION 2026-07-20): main resolves the workspace from the
   * engine-written baseline cache, so HC1 holds and no filesystem path ever
   * crosses from the renderer.
   *
   * Null when no session here is openable that way — see `openableHistoryId`
   * for the one case that leaves a project with neither identity.
   */
  historySessionId: string | null
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
 * The engine session id a terminal-created session opens by, or null when it
 * opens by nothing. Openable requires a recorded workspace that is non-empty AND
 * still on disk — the SAME gate the sidebar row applies (`deriveMergedRowVisual`,
 * `sidebarState.ts:205`, bug-sweep #1). Without the `cwdExists` half the launcher
 * would offer the ~40 stale transcripts whose temp workspaces are long gone, and
 * the click would come back as the host's typed `invalid_cwd` rejection.
 */
function openableHistoryId(row: MergedSessionRow): string | null {
  if (row.inRegistry || row.appSessionId != null) return null
  if (row.cwd.trim().length === 0 || !row.cwdExists) return null
  return row.sessionId
}

/**
 * Collapse merged session rows into distinct-workspace recents, newest-first,
 * capped to `limit`. Carries BOTH openable identities, newest of each kind: a
 * registry row's app id + live flag (focus/restore), and the engine id of a
 * terminal-created session (open-by-engine-id). A project keeps `appSessionId:
 * null` when every session in it was created in the terminal — which no longer
 * means it cannot be opened, only that it opens by the other identity (P4-40).
 *
 * Labels go through `disambiguateWorkspaceLabels`, the SAME helper the sidebar's
 * group headers use (CC-14): keying on cwd is right, but labelling each recent
 * with a bare `basename(cwd)` threw away everything that separated two projects
 * sharing one — and this list is where the operator PICKS a project to open, with
 * a per-path `trusted` badge attached, so two entries reading `app` could offer
 * different trust decisions under one name. Latent rather than active only because
 * the cap keeps the list short.
 *
 * Disambiguate AFTER the cap, over exactly the entries that will render. The
 * helper's contract is "shortest label that separates it from the others ON
 * SCREEN", and `groupByWorkspace` gives it precisely the set it returns; matching
 * that here keeps one invariant for both call sites. A 7th, never-rendered project
 * must not widen a visible label to resolve a collision the operator cannot see —
 * and since the cap is a subset, doing it after can only ever produce labels that
 * are equal or shorter, never more ambiguous.
 */
export function selectRecentWorkspaces(
  rows: readonly MergedSessionRow[],
  trustByCwd: ReadonlyMap<string, boolean>,
  limit = 6,
): RecentWorkspace[] {
  const byCwd = new Map<string, RecentWorkspace>()
  for (const row of rows) {
    // A recent is a PROJECT the operator can open. A row whose workspace could
    // not be reconciled (MAJOR-1, `cwd === ''`) names no project, and it would
    // render as a nameless entry: `basename('') || ''` is the empty string, so
    // both the picker's trigger and its row would come out blank. The sidebar
    // buckets those rows under "Unknown workspace" instead; here there is
    // nothing to open, so they are left out.
    if (row.cwd.trim().length === 0) continue
    const existing = byCwd.get(row.cwd)
    if (!existing) {
      byCwd.set(row.cwd, {
        cwd: row.cwd,
        name: basename(row.cwd) || row.cwd,
        appSessionId: row.appSessionId,
        live: row.live,
        historySessionId: openableHistoryId(row),
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
    // The same adoption for the other identity, so a project made entirely of
    // terminal-created sessions still names one openable session.
    if (existing.historySessionId == null) {
      existing.historySessionId = openableHistoryId(row)
    }
  }
  const visible = [...byCwd.values()]
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, limit)
  const labels = disambiguateWorkspaceLabels(visible.map(recent => recent.cwd))
  return visible.map(recent => ({
    ...recent,
    // Depth 1 IS `basename(cwd) || cwd`, so an uncontested label is byte-identical
    // to the seed above and the `??` fallback is a no-op belt.
    name: labels.get(recent.cwd) ?? recent.name,
  }))
}

/**
 * How a Welcome recent opens (P4-40). Delegates to `resolveSessionOpenRoute` —
 * the ONE open decision (P4-29) — rather than re-deriving it, so the launcher
 * cannot drift from the sidebar and the Sessions page the way it had: it opened
 * by app id only, which left a project whose sessions all came from the terminal
 * rendered as a dead row.
 *
 * `selectRecentWorkspaces` has already reduced the project to at most one
 * identity of each kind, so this only has to hand them over in the shape the row
 * decision reads. Neither identity ⇒ nothing here can be opened.
 */
export function resolveRecentOpenRoute(recent: RecentWorkspace): SessionOpenRoute {
  if (recent.appSessionId == null && recent.historySessionId == null) {
    return { kind: 'none' }
  }
  return resolveSessionOpenRoute({
    appSessionId: recent.appSessionId,
    live: recent.live,
    cwd: recent.cwd,
    // `historySessionId` is produced only by `openableHistoryId`, which already
    // excludes history rows whose workspace no longer exists.
    cwdExists: recent.historySessionId != null,
    sessionId: recent.historySessionId ?? '',
    // A recent carrying an app id was adopted from a registry row, and one
    // carrying only an engine id from a history row (the merge gives registry
    // rows an app id and history rows none, `selectMergedSessionRows`).
    inRegistry: recent.appSessionId != null,
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
