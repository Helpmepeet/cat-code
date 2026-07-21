/**
 * SessionsPage (P4-6a) — the read-only cross-workspace Sessions catalog manager
 * (`SessionsPage.jsx`), distinct from the Sidebar switcher: browse / search /
 * sort / filter / group over the REAL catalog (`selectMergedSessionRows` —
 * registry ∪ engine transcript history), with real titles (the P4-6 rider).
 *
 * Read-only + navigation only in 6a. The per-row `SessionActionsMenu`, inline
 * rename, tag popover, multi-select bulk bar, and Branch/Rewind/Export dialogs
 * are P4-6b (each maps to a mutating engine verb needing an inbound frame —
 * `SessionActions.jsx`). They are rendered as ABSENT, never faked (honesty over
 * parity per §0). Real fields with no bounded-catalog backing (message count,
 * mode) render truth and are simply omitted when empty (C3).
 *
 * Prototype visual grammar (SessionsPage.jsx) rebuilt on the P0-2 tokens + the
 * trued-up shell classes (AgentsPage/AccountsPage idiom); no inline style.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Chip } from './Chip.js'
import { basename } from './pathUtils.js'
import { sessionStatusVisual, statusChipTone } from './sessionStatusVisual.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  resolveSessionActions,
  type SessionActionKind,
} from './sessionActions.js'
import {
  SessionActionsMenu,
  type SessionActionsAnchor,
} from './SessionActionsMenu.js'
import {
  bucketByDate,
  collectSessionTags,
  countWorkspaces,
  filterSessionRows,
  formatRelativeTime,
  groupByWorkspace,
  sortSessionRows,
  type MergedSessionRow,
  type SessionSort,
} from './sessionsCatalogState.js'

const SORT_LABELS: Record<SessionSort, string> = {
  recent: 'Recent activity',
  name: 'Name (A–Z)',
}

export function SessionsPage({
  rows,
  activeCwd,
  catalogLoaded,
  truncated,
  onOpenRow,
  onNewSession,
}: {
  rows: readonly MergedSessionRow[]
  activeCwd: string | null
  /** False until the active session's catalog snapshot has arrived. */
  catalogLoaded: boolean
  /** The engine-history enumeration hit its enrichment cap (older rows omitted). */
  truncated: boolean
  onOpenRow: (row: MergedSessionRow) => void
  onNewSession: () => void
}) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [sortOpen, setSortOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState('all')
  const [allWorkspaces, setAllWorkspaces] = useState(true)

  const now = Date.now()
  const allTags = useMemo(() => collectSessionTags(rows), [rows])
  const totalWorkspaces = useMemo(() => countWorkspaces(rows), [rows])

  const visible = useMemo(() => {
    const filtered = filterSessionRows(rows, {
      query: search,
      tag: tagFilter,
      activeCwd,
      allWorkspaces,
    })
    return sortSessionRows(filtered, sort)
  }, [rows, search, tagFilter, activeCwd, allWorkspaces, sort])

  const grouped = allWorkspaces && countWorkspaces(visible) > 1
  const byDate = sort === 'recent'

  return (
    <div className="relative flex-1 overflow-y-auto px-7 py-7 pb-24">
      <div className="mx-auto max-w-[820px]">
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-text-primary">
              Sessions
            </h1>
            <div className="mt-0.5 text-[13px] text-text-subtle">
              {rows.length} session{rows.length === 1 ? '' : 's'}
              {totalWorkspaces > 1 ? ` · ${totalWorkspaces} workspaces` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/[0.08] px-3.5 py-[7px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/15"
          >
            <PlusIcon /> New session
          </button>
        </div>

        {/* Toolbar row 1 — search + sort + workspace scope */}
        <div className="mb-2.5 flex items-center gap-2.5">
          <div className="relative min-w-[140px] flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle">
              <SearchIcon />
            </span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search sessions…"
              className="h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.04] pl-8 pr-3 text-[13px] text-text-primary placeholder:text-text-subtle focus:border-accent/50 focus:outline-none"
            />
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setSortOpen(open => !open)}
              className={
                'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors ' +
                (sortOpen
                  ? 'border-white/15 bg-white/[0.05] text-text-primary'
                  : 'border-white/[0.08] bg-white/[0.02] text-text-subtle hover:text-text-primary')
              }
            >
              {SORT_LABELS[sort]}
              <ChevronIcon open={sortOpen} />
            </button>
            {sortOpen ? (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setSortOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute right-0 top-9 z-50 w-[176px] rounded-[10px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
                  {(Object.keys(SORT_LABELS) as SessionSort[]).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        setSort(option)
                        setSortOpen(false)
                      }}
                      className={
                        'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ' +
                        (option === sort
                          ? 'text-accent'
                          : 'text-text-subtle hover:bg-white/[0.04] hover:text-text-primary')
                      }
                    >
                      {SORT_LABELS[option]}
                      {option === sort ? <CheckIcon /> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          {totalWorkspaces > 1 ? (
            <button
              type="button"
              onClick={() => setAllWorkspaces(value => !value)}
              className={
                'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors ' +
                (allWorkspaces
                  ? 'border-tone-info/40 bg-tone-info/10 text-tone-info'
                  : 'border-white/[0.08] bg-white/[0.02] text-text-subtle hover:text-text-primary')
              }
              title={
                allWorkspaces
                  ? 'Showing all workspaces'
                  : 'Showing the current workspace only'
              }
            >
              <HomeIcon /> All workspaces
            </button>
          ) : null}
        </div>

        {/* Toolbar row 2 — tag tabs */}
        {allTags.length > 0 ? (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {['all', ...allTags].map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tag)}
                className={
                  'rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ' +
                  (tagFilter === tag
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-white/[0.06] bg-transparent text-text-subtle hover:text-text-primary')
                }
              >
                {tag === 'all' ? 'All' : `#${tag}`}
              </button>
            ))}
          </div>
        ) : (
          <div className="mb-4" />
        )}

        {/* Completeness honesty (§0 adapted — no prototype counterpart): with no
         * live catalog AND no persisted baseline, the rows below are the desktop
         * registry ONLY, not the full terminal history. Surface that even when
         * registry rows are present, so the list never looks complete when it is
         * not (the silent-completeness defect). Cleared once any snapshot/baseline
         * arrives (`catalogLoaded`). */}
        {!catalogLoaded ? (
          <div className="mb-3 rounded-lg border border-shell-seam bg-white/[0.02] px-3 py-2 text-[11.5px] text-text-subtle">
            Terminal-session history is still loading — only desktop-tracked
            sessions are shown so far.
          </div>
        ) : null}

        {/* List */}
        {visible.length === 0 ? (
          <EmptyState
            catalogLoaded={catalogLoaded}
            searching={search.trim().length > 0}
            tagged={tagFilter !== 'all'}
          />
        ) : grouped ? (
          groupByWorkspace(visible, activeCwd).map(group => (
            <section key={group.cwd} className="mb-6">
              <GroupHeader
                name={group.name}
                current={group.current}
                count={group.rows.length}
              />
              <RowList
                rows={group.rows}
                byDate={byDate}
                now={now}
                activeCwd={activeCwd}
                grouped
                onOpenRow={onOpenRow}
              />
            </section>
          ))
        ) : (
          <RowList
            rows={visible}
            byDate={byDate}
            now={now}
            activeCwd={activeCwd}
            grouped={false}
            onOpenRow={onOpenRow}
          />
        )}

        {truncated ? (
          <div className="mt-6 rounded-lg border border-shell-seam bg-white/[0.02] px-3 py-2 text-[11.5px] text-text-subtle">
            Only the most-recent sessions are enriched with titles; older sessions
            are not shown. Registry eviction (`MAX_REGISTRY_SESSIONS`) can also drop
            restorable rows — an operator product decision (O2).
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RowList({
  rows,
  byDate,
  now,
  activeCwd,
  grouped,
  onOpenRow,
}: {
  rows: MergedSessionRow[]
  byDate: boolean
  now: number
  activeCwd: string | null
  grouped: boolean
  onOpenRow: (row: MergedSessionRow) => void
}) {
  if (!byDate) {
    return (
      <div className="flex flex-col gap-1.5">
        {rows.map(row => (
          <SessionRow
            key={row.sessionId}
            row={row}
            now={now}
            activeCwd={activeCwd}
            grouped={grouped}
            onOpen={onOpenRow}
          />
        ))}
      </div>
    )
  }
  return (
    <>
      {bucketByDate(rows, now).map(bucket => (
        <div key={bucket.label} className="mb-4">
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <span className="text-[11px] font-semibold text-text-subtle">
              {bucket.label}
            </span>
            <div className="h-px min-w-5 flex-1 bg-shell-seam" />
            <span className="font-mono text-[10.5px] text-text-subtle">
              {bucket.rows.length}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {bucket.rows.map(row => (
              <SessionRow
                key={row.sessionId}
                row={row}
                now={now}
                activeCwd={activeCwd}
                grouped={grouped}
                onOpen={onOpenRow}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function SessionRow({
  row,
  now,
  activeCwd,
  grouped,
  onOpen,
}: {
  row: MergedSessionRow
  now: number
  activeCwd: string | null
  grouped: boolean
  onOpen: (row: MergedSessionRow) => void
}) {
  // SESSIONS-UNIFICATION (operator ruling 2026-07-20): a terminal-created history
  // row is now openable too — by its engine id, if its workspace is resolvable.
  // A registry row opens via switch/restore; a history row with a recorded cwd
  // opens via the open-from-history host path; only a history row with NO recorded
  // workspace (MAJOR-1, unreconcilable) stays browse-only.
  const historyOpenable =
    row.appSessionId == null && !row.inRegistry && row.cwd.trim().length > 0
  const openable = row.appSessionId != null || historyOpenable
  const crossProject = !grouped && activeCwd != null && row.cwd !== activeCwd
  const rowClass =
    'flex w-full items-start gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ' +
    (openable
      ? 'border-white/[0.06] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.035]'
      : 'cursor-default border-white/[0.04] bg-white/[0.01]')

  const inner = (
    <>
      <span
        aria-hidden="true"
        className={
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ' +
          (row.mode === 'agent'
            ? 'bg-accent/10 text-accent'
            : 'bg-white/[0.04] text-text-subtle')
        }
      >
        {row.mode === 'agent' ? <RobotIcon /> : <MessageIcon />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-text-primary">
            {row.displayLabel}
          </span>
          <StatusBadge row={row} />
          {row.mode === 'agent' ? (
            <Chip tone="accent" label="orchestrating" />
          ) : null}
          {/* Prototype paints cross-project rows BLUE; the shell palette has no
           * distinct blue (`--tone-info` aliases the pink accent), so this uses a
           * neutral chip to avoid colliding with the pink "orchestrating" badge
           * (§0 adaptation: no blue token). */}
          {crossProject ? <Chip tone="default" label="other workspace" /> : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-subtle">
          {!grouped ? (
            <MetaItem mono>{basename(row.cwd) || row.cwd}</MetaItem>
          ) : null}
          <MetaItem>{formatRelativeTime(row.modifiedAtMs, now)}</MetaItem>
          {row.gitBranch ? <MetaItem mono>{row.gitBranch}</MetaItem> : null}
          {row.agentSetting ? <MetaItem mono>{row.agentSetting}</MetaItem> : null}
          {row.prNumber != null ? (
            <MetaItem mono>
              {row.prRepository ? `${row.prRepository}#` : '#'}
              {row.prNumber}
            </MetaItem>
          ) : null}
          {row.tag ? (
            <span className="font-mono text-[11px] text-accent">#{row.tag}</span>
          ) : null}
        </span>
      </span>
    </>
  )

  if (openable) {
    return (
      <button type="button" className={rowClass} onClick={() => onOpen(row)}>
        {inner}
      </button>
    )
  }
  return (
    <div
      className={rowClass}
      title="This session has no recorded workspace, so it can only be opened from the terminal."
    >
      {inner}
    </div>
  )
}

function StatusBadge({ row }: { row: MergedSessionRow }) {
  // Keyed off the SAME status → {label, tone} truth every other surface uses
  // (audit §I.2). The old body checked `row.live` first (`row.live` is true for
  // both a spawning row AND a live socket-drop, `sessionsCatalogState.ts:209`),
  // so both wrongly badged "live" while the TabBar showed starting/disconnected
  // (§I.2 #8 fix). Routing through the shared mapping corrects both.
  const { tone, label } = sessionStatusVisual(row.status, row.restorable, row.inRegistry)
  return <Chip tone={statusChipTone(tone)} label={label} />
}

function MetaItem({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={mono ? 'font-mono text-text-subtle' : 'text-text-subtle'}>
      {children}
    </span>
  )
}

function GroupHeader({
  name,
  current,
  count,
}: {
  name: string
  current: boolean
  count: number
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span className={current ? 'text-text-subtle' : 'text-tone-info'}>
        <FolderIcon />
      </span>
      <span
        className={
          'truncate font-mono text-[11.5px] ' +
          (current ? 'text-text-muted' : 'text-tone-info')
        }
      >
        {name}
      </span>
      {current ? (
        <span className="rounded border border-white/[0.08] px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-text-subtle">
          current
        </span>
      ) : null}
      <div className="h-px min-w-5 flex-1 bg-shell-seam" />
      <span className="font-mono text-[10.5px] text-text-subtle">{count}</span>
    </div>
  )
}

function EmptyState({
  catalogLoaded,
  searching,
  tagged,
}: {
  catalogLoaded: boolean
  searching: boolean
  tagged: boolean
}) {
  const headline = !catalogLoaded
    ? 'Loading sessions…'
    : searching
      ? 'No sessions match your search'
      : tagged
        ? 'No sessions with this tag'
        : 'No sessions yet'
  const subtext = !catalogLoaded
    ? 'Waiting for the engine to enumerate your transcript history.'
    : searching || tagged
      ? 'Try a different filter.'
      : 'Start a new session to see it here.'
  return (
    <div className="py-14 text-center">
      <div className="mb-1 text-sm font-medium text-text-subtle">{headline}</div>
      <div className="text-xs text-text-subtle/75">{subtext}</div>
    </div>
  )
}

/* --- icons (stroke, currentColor — matching the shell idiom) --- */

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={'transition-transform ' + (open ? 'rotate-180' : '')}
    >
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 11l9-8 9 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v10h14V10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MessageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5h16v11H8l-4 3V5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RobotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4v4M9 13h.01M15 13h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
