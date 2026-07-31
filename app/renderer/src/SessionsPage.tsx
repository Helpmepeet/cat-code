/**
 * SessionsPage — the cross-workspace Sessions catalog MANAGER
 * (`SessionsPage.jsx`), distinct from the Sidebar switcher: browse / search /
 * sort / filter / group over the REAL catalog (`selectMergedSessionRows` —
 * registry ∪ engine transcript history), with real titles (the P4-6 rider).
 *
 * P4-6a built the read-only browse half. P4-29 built the ACTION half the ledger
 * (§16) had left orphaned: multi-select + the floating bulk bar, the row overflow
 * ⋯ and right-click context menu, inline rename, and the tag popover. Four
 * identifiers that P4-6b imported here and never used are now genuinely consumed;
 * the menu itself is the App-owned `SessionActionsMenu` the TabBar and Sidebar
 * already open (one menu, three entry points), reached through `onOpenRowActions`.
 *
 * What is real, and what that costs:
 *  - Rename and Tag are engine writes (`session.rename` → `saveCustomTitle`,
 *    `session.tag` → `saveTag`) dispatched to the row's OWN sidecar, so they are
 *    offered only for a LIVE row; a closed row shows the affordance disabled with
 *    the action that would enable it. There is no renderer-side title or tag store.
 *  - Archive and Delete stay CUT (no engine verb exists — `sessionActions.ts`).
 *  - Bulk Export and the Branch/Export dialogs are not here yet: they are the
 *    dialog surface P4-30 owns, and a second dialog layer is exactly the
 *    duplication this program forbids.
 *
 * Real fields with no bounded-catalog backing (message count, mode) render truth
 * and are simply omitted when empty (C3). Prototype visual grammar rebuilt on the
 * P0-2 tokens + the trued-up shell classes; no inline style except the two
 * measured-anchor cases, which Tailwind cannot express.
 */

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { Chip } from './Chip.js'
import {
  FOCUSABLE_ELEMENT_SELECTOR,
  handleMenuRovingKeyDown,
  usePopoverFocus,
} from './overlayFocus.js'
import { basename } from './pathUtils.js'
import { sessionStatusVisual, statusChipTone } from './sessionStatusVisual.js'
import type { SessionActionsAnchor } from './SessionActionsMenu.js'
import { SESSION_ACTIONS_MENU_WIDTH } from './sessionActions.js'
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
import {
  createSessionsPageState,
  placeTagPopover,
  reduceSessionsPageState,
  resolveTagCommit,
  selectAllVisibleSelected,
  selectCanCreateTag,
  selectIsSelected,
  selectKnownTags,
  selectMatchingTags,
  selectRowTag,
  type SessionsPageState,
  type TagPopoverState,
} from './sessionsPageState.js'

const SORT_LABELS: Record<SessionSort, string> = {
  recent: 'Recent activity',
  name: 'Name (A–Z)',
}

/** The one thing a closed session's owner can DO to make a write possible. */
const NOT_LIVE_REASON = 'Open or restore this session first.'

export function SessionsPage({
  rows,
  activeCwd,
  catalogLoaded,
  truncated,
  onOpenRow,
  onNewSession,
  onOpenRowActions,
  onRenameRow,
  onTagRows,
  renameRequest,
  tagEcho,
}: {
  rows: readonly MergedSessionRow[]
  activeCwd: string | null
  /** False until the active session's catalog snapshot has arrived. */
  catalogLoaded: boolean
  /** The engine-history enumeration hit its enrichment cap (older rows omitted). */
  truncated: boolean
  onOpenRow: (row: MergedSessionRow) => void
  onNewSession: () => void
  /** Open the App-owned `SessionActionsMenu` for a row, anchored at a point. */
  onOpenRowActions?: (row: MergedSessionRow, anchor: SessionActionsAnchor) => void
  /** Commit an inline rename (→ the real `session.rename` verb, App-dispatched). */
  onRenameRow?: (row: MergedSessionRow, title: string) => void
  /** Set (or, with null, clear) the tag on rows (→ the real `session.tag` verb). */
  onTagRows?: (rows: readonly MergedSessionRow[], tag: string | null) => void
  /** The App-owned menu asking this page to start its inline rename on a row. */
  renameRequest?: { sessionId: string } | null
  /**
   * Tag writes the sidecar CONFIRMED, echoed until the catalog re-enumerates.
   * A list, because one bulk tag settles several results in a single pass and
   * each carries its own rows.
   */
  tagEcho?: {
    entries: readonly { sessionIds: readonly string[]; tag: string | null }[]
  } | null
}) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [sortOpen, setSortOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus: restoreSortTriggerFocus } = usePopoverFocus({
    open: sortOpen,
    containerRef: sortMenuRef,
    onEscape: () => setSortOpen(false),
  })
  const [tagFilter, setTagFilter] = useState('all')
  const [allWorkspaces, setAllWorkspaces] = useState(true)
  const [page, dispatchPage] = useReducer(
    reduceSessionsPageState,
    undefined,
    createSessionsPageState,
  )

  const now = Date.now()
  const allTags = useMemo(() => collectSessionTags(rows), [rows])
  const totalWorkspaces = useMemo(() => countWorkspaces(rows), [rows])

  // Reconcile against the rows on every catalog delivery: drop tag echoes the
  // catalog has caught up with, and forget selections whose row disappeared.
  useEffect(() => {
    dispatchPage({ type: 'catalog-settled', rows })
  }, [rows])

  // A confirmed tag write (never an optimistic guess — App only forwards an
  // `ok` result frame). Applied by identity so one confirmation lands once.
  const appliedEchoRef = useRef<typeof tagEcho>(null)
  useEffect(() => {
    if (!tagEcho || appliedEchoRef.current === tagEcho) return
    appliedEchoRef.current = tagEcho
    for (const entry of tagEcho.entries) {
      dispatchPage({
        type: 'tag-confirmed',
        sessionIds: entry.sessionIds,
        tag: entry.tag,
      })
    }
  }, [tagEcho])

  // The ⋯ menu's Rename verb starts the INLINE editor on this page (the
  // prototype's affordance), rather than the tab/sidebar rename popover.
  const startedRenameRef = useRef<{ sessionId: string } | null>(null)
  useEffect(() => {
    if (!renameRequest || startedRenameRef.current === renameRequest) return
    startedRenameRef.current = renameRequest
    const target = rows.find(row => row.sessionId === renameRequest.sessionId)
    if (!target) return
    dispatchPage({
      type: 'start-rename',
      sessionId: target.sessionId,
      initial: target.title ?? target.displayLabel,
    })
  }, [renameRequest, rows])

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
  const visibleIds = useMemo(() => visible.map(row => row.sessionId), [visible])
  const knownTags = useMemo(() => selectKnownTags(page, rows), [page, rows])
  const selectedRows = useMemo(
    () => rows.filter(row => selectIsSelected(page, row.sessionId)),
    [page, rows],
  )

  const rowActions: RowActions = {
    onOpen: onOpenRow,
    onToggleSelected: sessionId =>
      dispatchPage({ type: 'toggle-selected', sessionId }),
    onOpenActions: (row, anchor) => onOpenRowActions?.(row, anchor),
    onOpenTag: (row, rect) =>
      dispatchPage({
        type: 'open-tag-popover',
        target: { kind: 'row', sessionId: row.sessionId },
        rect,
      }),
    onRenameChange: value => dispatchPage({ type: 'edit-rename', value }),
    onRenameCommit: row => {
      const title = page.renaming?.value.trim() ?? ''
      if (title.length > 0 && title !== (row.title ?? row.displayLabel)) {
        onRenameRow?.(row, title)
      }
      dispatchPage({ type: 'end-rename' })
    },
    onRenameCancel: () => dispatchPage({ type: 'end-rename' }),
    canAct: onOpenRowActions != null,
  }

  function applyTag(tag: string | null): void {
    const target = page.tagPopover?.target
    if (!target) return
    const targets =
      target.kind === 'bulk'
        ? selectedRows
        : rows.filter(row => row.sessionId === target.sessionId)
    const writable = targets.filter(row => row.live && row.appSessionId != null)
    if (writable.length > 0) onTagRows?.(writable, tag)
    if (target.kind === 'bulk') dispatchPage({ type: 'clear-selection' })
    dispatchPage({ type: 'close-tag-popover' })
  }

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
              aria-haspopup="menu"
              aria-expanded={sortOpen}
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
                <div
                  ref={sortMenuRef}
                  role="menu"
                  aria-label="Sort sessions"
                  onKeyDown={handleMenuRovingKeyDown}
                  className="absolute right-0 top-9 z-50 w-[176px] rounded-[10px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
                >
                  {(Object.keys(SORT_LABELS) as SessionSort[]).map(option => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={option === sort}
                      onClick={() => {
                        restoreSortTriggerFocus()
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
            Terminal-session history is still loading, so only desktop-tracked
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
                page={page}
                actions={rowActions}
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
            page={page}
            actions={rowActions}
          />
        )}

        {truncated ? (
          <div className="mt-6 rounded-lg border border-shell-seam bg-white/[0.02] px-3 py-2 text-[11.5px] text-text-subtle">
            Only the most-recent sessions are enriched with titles; older sessions
            are not shown, and the oldest can drop off this list entirely.
          </div>
        ) : null}
      </div>

      {page.selected.length > 0 ? (
        <BulkBar
          selectedCount={page.selected.length}
          visibleCount={visibleIds.length}
          allSelected={selectAllVisibleSelected(page, visibleIds)}
          writableCount={
            selectedRows.filter(row => row.live && row.appSessionId != null).length
          }
          onSelectAll={() =>
            dispatchPage({ type: 'select-all', sessionIds: visibleIds })
          }
          onTag={rect =>
            dispatchPage({
              type: 'open-tag-popover',
              target: { kind: 'bulk' },
              rect,
            })
          }
          onClear={() => dispatchPage({ type: 'clear-selection' })}
        />
      ) : null}

      {page.tagPopover ? (
        <TagPopover
          state={page.tagPopover}
          knownTags={knownTags}
          bulkCount={page.selected.length}
          currentTag={popoverRowTag(page, rows)}
          onApply={applyTag}
          onClose={() => dispatchPage({ type: 'close-tag-popover' })}
        />
      ) : null}
    </div>
  )
}

/**
 * The tag currently on the row the popover targets, for the active-check and the
 * "Remove tag" row. Null for the bulk form, which has no single current tag.
 */
function popoverRowTag(
  page: SessionsPageState,
  rows: readonly MergedSessionRow[],
): string | null {
  const target = page.tagPopover?.target
  if (target?.kind !== 'row') return null
  const row = rows.find(candidate => candidate.sessionId === target.sessionId)
  return row ? selectRowTag(page, row) : null
}

/** Everything a row can ask the page to do, passed as one bundle. */
type RowActions = {
  onOpen: (row: MergedSessionRow) => void
  onToggleSelected: (sessionId: string) => void
  onOpenActions: (row: MergedSessionRow, anchor: SessionActionsAnchor) => void
  onOpenTag: (row: MergedSessionRow, rect: TagPopoverState['rect']) => void
  onRenameChange: (value: string) => void
  onRenameCommit: (row: MergedSessionRow) => void
  onRenameCancel: () => void
  /** False when the host did not wire the actions menu (the read-only mount). */
  canAct: boolean
}

function RowList({
  rows,
  byDate,
  now,
  activeCwd,
  grouped,
  page,
  actions,
}: {
  rows: MergedSessionRow[]
  byDate: boolean
  now: number
  activeCwd: string | null
  grouped: boolean
  page: SessionsPageState
  actions: RowActions
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
            page={page}
            actions={actions}
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
                page={page}
                actions={actions}
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
  page,
  actions,
}: {
  row: MergedSessionRow
  now: number
  activeCwd: string | null
  grouped: boolean
  page: SessionsPageState
  actions: RowActions
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
  const selected = selectIsSelected(page, row.sessionId)
  const renaming = page.renaming?.sessionId === row.sessionId
  const tag = selectRowTag(page, row)
  // Rename and Tag are writes into this row's OWN live engine (sessionActions.ts):
  // a closed session has no sidecar to receive the verb.
  const writable = row.live && row.appSessionId != null
  // §0 adaptation: the ⋯ / right-click menu is offered for REGISTRY rows only. A
  // terminal-history row has no `appSessionId` for the menu to act on, and its one
  // reachable verb (Open) is the row click itself, so a menu there would be six
  // disabled rows and nothing else.
  const hasMenu = actions.canAct && row.appSessionId != null
  // Four border/bg states, as the prototype (`SessionsPage.jsx:241-247`): selected
  // wins, then cross-project, then the plain hover pair, then non-openable.
  const rowClass =
    'group relative flex w-full items-start gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ' +
    (selected
      ? 'border-accent/40 bg-accent/[0.06]'
      : crossProject
        ? 'border-tone-info/20 bg-tone-info/[0.03] hover:border-tone-info/40 hover:bg-tone-info/[0.07]'
        : openable
          ? 'border-white/[0.06] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.035]'
          : 'cursor-default border-white/[0.04] bg-white/[0.01]')

  const inner = (
    <>
      {/* Leading icon that doubles as the selection checkbox — a check when
       * selected, the mode icon otherwise (the prototype's blank-on-hover fourth
       * state is dropped: a control that vanishes under the pointer about to
       * click it is worse than one that stays legible). */}
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          actions.onToggleSelected(row.sessionId)
        }}
        aria-pressed={selected}
        aria-label={selected ? 'Deselect session' : 'Select session'}
        title={selected ? 'Deselect' : 'Select'}
        className={
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ' +
          (selected
            ? 'border-accent bg-accent text-shell-base'
            : row.mode === 'agent'
              ? 'border-accent/20 bg-accent/10 text-accent hover:border-white/30'
              : 'border-white/[0.07] bg-white/[0.04] text-text-subtle hover:border-white/30')
        }
      >
        {selected ? (
          <CheckIcon />
        ) : row.mode === 'agent' ? (
          <RobotIcon />
        ) : (
          <MessageIcon />
        )}
      </button>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {renaming ? (
            <input
              autoFocus
              value={page.renaming?.value ?? ''}
              onChange={event => actions.onRenameChange(event.target.value)}
              onClick={event => event.stopPropagation()}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  actions.onRenameCommit(row)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  actions.onRenameCancel()
                }
              }}
              onBlur={() => actions.onRenameCommit(row)}
              aria-label="Session name"
              className="min-w-0 max-w-[340px] flex-[0_1_auto] rounded-md border border-accent/45 bg-white/[0.06] px-[7px] py-0.5 text-[13px] font-medium text-text-primary outline-none"
            />
          ) : (
            <span className="truncate text-[13px] font-medium text-text-primary">
              {row.displayLabel}
            </span>
          )}
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
          <TagControl
            tag={tag}
            writable={writable}
            onOpen={rect => actions.onOpenTag(row, rect)}
          />
        </span>
      </span>
      {/* Row overflow ⋯ — hover-revealed, opens the shared actions menu anchored
       * below-right of the button, exactly as the tab and sidebar entry points do. */}
      {hasMenu ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            // P4-39 — the trigger's rect, right-aligned to the button at the
            // menu's REAL width (this said 220, the prototype's, for a 232px
            // panel); the menu owns the gap, the clamp and the bottom-flip.
            actions.onOpenActions(row, {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.right - SESSION_ACTIONS_MENU_WIDTH,
            })
          }}
          aria-label="Session actions"
          title="Session actions"
          className="flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-lg text-text-subtle opacity-0 transition-opacity hover:bg-accent/15 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
        >
          <MoreIcon />
        </button>
      ) : null}
    </>
  )

  const openRow = () => {
    if (renaming || !openable) return
    actions.onOpen(row)
  }
  const onContextMenu = hasMenu
    ? (event: ReactMouseEvent) => {
        event.preventDefault()
        // P4-39 — a pointer is a zero-height trigger; the menu clamps and flips it.
        actions.onOpenActions(row, {
          top: event.clientY,
          bottom: event.clientY,
          left: event.clientX,
        })
      }
    : undefined

  // A div, not a button: the row now nests its own controls (checkbox, tag, ⋯),
  // and a button may not contain buttons. Keyboard activation is restored
  // explicitly so the row stays reachable without a pointer.
  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      className={rowClass}
      onClick={openRow}
      onKeyDown={event => {
        if (!openable || renaming) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.onOpen(row)
        }
      }}
      onContextMenu={onContextMenu}
      title={
        openable
          ? undefined
          : 'This session has no recorded workspace, so it can only be opened from the terminal.'
      }
    >
      {inner}
    </div>
  )
}

/**
 * The row's tag affordance: the `#tag` pill when tagged, a dashed hover-revealed
 * `+ tag` when not. Both open the popover. Disabled (with the action that would
 * enable it) for a closed session, whose engine cannot receive the write.
 */
function TagControl({
  tag,
  writable,
  onOpen,
}: {
  tag: string | null
  writable: boolean
  onOpen: (rect: TagPopoverState['rect']) => void
}) {
  const open = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    onOpen({ top: rect.bottom, bottom: rect.top, left: rect.left })
  }
  if (tag) {
    return (
      <button
        type="button"
        onClick={open}
        disabled={!writable}
        title={writable ? 'Edit tag' : NOT_LIVE_REASON}
        className="inline-flex items-center rounded-[5px] border border-accent/20 bg-accent/[0.08] px-1.5 py-px font-mono text-[10.5px] leading-normal text-accent transition-colors enabled:hover:border-accent/45 disabled:cursor-default"
      >
        #{tag}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      disabled={!writable}
      title={writable ? 'Add tag' : NOT_LIVE_REASON}
      className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-white/[0.18] px-1.5 py-px font-mono text-[10.5px] leading-normal text-text-subtle opacity-0 transition-colors focus-visible:opacity-100 group-hover:opacity-100 enabled:hover:border-accent/40 enabled:hover:text-accent disabled:cursor-default"
    >
      + tag
    </button>
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
  // The loading case gets no subtext: "Loading sessions…" already says it, and
  // the line it replaced described our plumbing rather than anything actionable.
  const subtext = !catalogLoaded
    ? null
    : searching || tagged
      ? 'Try a different filter.'
      : 'Start a new session to see it here.'
  return (
    <div className="py-14 text-center">
      <div className="mb-1 text-sm font-medium text-text-subtle">{headline}</div>
      {subtext ? <div className="text-xs text-text-subtle/75">{subtext}</div> : null}
    </div>
  )
}

/**
 * The floating bulk-action bar. Offset `left-12` (48px) so it centres over the
 * content column and clears the sidebar rail, as the prototype does
 * (`SessionsPage.jsx:618`).
 *
 * Archive and Delete are absent because no engine verb exists for them
 * (`sessionActions.ts` records that CUT). Export is absent because the format
 * dialog is P4-30's surface and a second one here would be a duplicate.
 */
function BulkBar({
  selectedCount,
  visibleCount,
  allSelected,
  writableCount,
  onSelectAll,
  onTag,
  onClear,
}: {
  selectedCount: number
  visibleCount: number
  allSelected: boolean
  /** How many of the selected rows are live, i.e. can receive a write verb. */
  writableCount: number
  onSelectAll: () => void
  onTag: (rect: TagPopoverState['rect']) => void
  onClear: () => void
}) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-12 right-0 z-[60] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-shell-chrome py-2 pl-3.5 pr-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)]">
        <span className="whitespace-nowrap text-[12.5px] font-semibold text-text-primary">
          {selectedCount} selected
        </span>
        <button
          type="button"
          onClick={onSelectAll}
          className="whitespace-nowrap px-1 text-[12px] text-tone-info transition-colors hover:text-text-primary"
        >
          {allSelected ? 'Deselect all' : `Select all ${visibleCount}`}
        </button>
        <div className="h-5 w-px bg-white/10" />
        <button
          type="button"
          disabled={writableCount === 0}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            onTag({ top: rect.bottom, bottom: rect.top, left: rect.left })
          }}
          title={
            writableCount === 0
              ? 'Open or restore at least one of these sessions first.'
              : writableCount < selectedCount
                ? `Tags ${writableCount} of ${selectedCount}: the rest are closed.`
                : undefined
          }
          className="flex items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-white/[0.09] px-2.5 py-1.5 text-[12.5px] font-medium text-text-muted transition-colors enabled:hover:border-white/20 enabled:hover:bg-white/[0.06] enabled:hover:text-text-primary disabled:cursor-default disabled:text-text-subtle/60"
        >
          <TagIcon /> Tag
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection"
          className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-subtle transition-colors hover:bg-white/[0.06] hover:text-text-muted"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}

/**
 * The tag popover: filter-or-create input, the matching-tag list with a check on
 * the active one, "Create #tag" when the query is novel, and "Remove tag" for a
 * tagged single row. Placement (above vs below, left-clamped) is the pure
 * `placeTagPopover` — the one piece of this surface with real geometry in it.
 */
function TagPopover({
  state,
  knownTags,
  bulkCount,
  currentTag,
  onApply,
  onClose,
}: {
  state: TagPopoverState
  knownTags: readonly string[]
  bulkCount: number
  currentTag: string | null
  onApply: (tag: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: popoverRef,
    onEscape: onClose,
    initialFocusSelector: FOCUSABLE_ELEMENT_SELECTOR,
  })
  const apply = (tag: string | null) => {
    restoreTriggerFocus()
    onApply(tag)
  }
  const bulk = state.target.kind === 'bulk'
  const matches = selectMatchingTags(query, knownTags)
  const canCreate = selectCanCreateTag(query, knownTags)
  const viewport =
    typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }
  const placement = placeTagPopover(state.rect, viewport)

  return (
    <>
      <div className="fixed inset-0 z-[70]" aria-hidden="true" onClick={onClose} />
      {/* §0 EXCEPTION: data-driven geometry Tailwind cannot express — the measured
          anchor of the trigger that opened this popover. */}
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={bulk ? 'Tag selected sessions' : 'Set session tag'}
        className="fixed z-[71] w-[216px] rounded-[10px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
        style={
          placement.placeAbove
            ? { bottom: placement.bottom, left: placement.left }
            : { top: placement.top, left: placement.left }
        }
      >
        <div className="px-1.5 pb-1.5 pt-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-text-subtle">
          {bulk
            ? `Tag ${bulkCount} session${bulkCount === 1 ? '' : 's'}`
            : 'Set tag'}
        </div>
        <input
          autoFocus
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              const resolved = resolveTagCommit(query, knownTags)
              if (resolved) apply(resolved)
              else if (matches[0]) apply(matches[0])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              restoreTriggerFocus()
              onClose()
            }
          }}
          placeholder="Filter or create…"
          aria-label="Filter or create a tag"
          className="mb-1 w-full rounded-[7px] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-text-muted outline-none placeholder:text-text-subtle focus:border-accent/35"
        />
        <div className="no-scrollbar max-h-[180px] overflow-y-auto">
          {matches.map(candidate => {
            const active = candidate === currentTag
            return (
              <button
                key={candidate}
                type="button"
                  onClick={() => apply(candidate)}
                className={
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 font-mono text-[12.5px] transition-colors ' +
                  (active
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-white/[0.05]')
                }
              >
                <span>#{candidate}</span>
                {active ? <CheckIcon /> : null}
              </button>
            )
          })}
          {canCreate ? (
            <button
              type="button"
              onClick={() => apply(query.trim().toLowerCase())}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-accent transition-colors hover:bg-accent/[0.08]"
            >
              <PlusIcon />
              Create <span className="font-mono">#{query.trim().toLowerCase()}</span>
            </button>
          ) : null}
          {matches.length === 0 && !canCreate ? (
            <div className="px-2 py-2.5 text-center text-[11.5px] text-text-subtle">
              Type to create a tag
            </div>
          ) : null}
        </div>
        {!bulk && currentTag ? (
          <>
            <div className="my-1 h-px bg-shell-seam" />
            <button
              type="button"
              onClick={() => apply(null)}
              className="flex w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-white/[0.05]"
            >
              <CloseIcon />
              Remove tag
            </button>
          </>
        ) : null}
      </div>
    </>
  )
}

/* --- icons (stroke, currentColor — matching the shell idiom) --- */

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M7 7h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

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
