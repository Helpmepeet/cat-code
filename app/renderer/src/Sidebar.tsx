/**
 * Sidebar (P4-4 fidelity true-up) — the shell's left rail, trued up to the
 * prototype's `Sidebar.jsx` grammar: a hover-expanding rail (48px → 240px, pin,
 * shadow, easing), a paw logo, session search, workspace grouping (by cwd), and
 * a nav destination rail — replacing P3-5b's static 240px roster.
 *
 * Data is unchanged: it renders the real `SidebarRow[]` (`selectSidebarRows`,
 * live ∪ restorable, stable arrival order — see `sidebarState.ts`) and raises
 * the SAME intent callbacks
 * (`onSelectLive` reuses App's `selectTab`; `onRestore` calls the host
 * `restoreSession`). Only real `SessionDescriptor` fields (title, cwd, status,
 * recency) are rendered — no cost/model/tags fixtures (C3).
 *
 * §0 fidelity flags (divergences from the prototype, by design):
 *  - Nav destination Sessions is rendered DISABLED (visual grammar only); its
 *    page is unbuilt (P4-6). Chat, Goals, Accounts (P4-5), and Settings are wired.
 *    None are mocked (honesty: disabled, flagged, not faked).
 *  - The prototype's per-row actions menu (rename/branch/rewind/export/delete) is
 *    omitted — those verbs are P4-6 (`SessionActions.jsx`); the restore-offer is
 *    the only row action here.
 *  - The prototype's per-workspace "+" (new session in this workspace) is omitted:
 *    HC1 forbids the renderer authoring a cwd, so new sessions go through the
 *    native picker (⌘T / TabBar "+"), never a renderer-chosen workspace path.
 *  - Session-row drag-to-panel is omitted; the built split model is drag-tab-to-
 *    edge (P3-6), which stays intact.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { basename } from './pathUtils.js'
import type { SessionId } from '../../shared/protocol.js'
import type { SidebarRow } from './sidebarState.js'
import type { TabTone } from './tabStatus.js'
import { tabLabel } from './TabBar.js'

// Rail geometry + hover timing, matching the prototype (RAIL_W/FULL_W/delays).
const HOVER_DELAY = 120
const HIDE_DELAY = 200

type NavItem = {
  id: 'chat' | 'orchestrator' | 'sessions' | 'goals' | 'accounts' | 'settings'
  label: string
  /** Wired to a built view. Unbuilt destinations render disabled + flagged. */
  enabled: boolean
  icon: ReactNode
}

// The prototype's destination rail (Chat/Sessions/Goals/Accounts/Settings — its
// own comments already dropped Tasks/Agents from the rail). Chat/Goals/Accounts/
// Settings are built; Sessions is a disabled placeholder (P4-6) — see §0.
const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', enabled: true, icon: <ChatIcon /> },
  { id: 'orchestrator', label: 'Orchestrator', enabled: true, icon: <OrchestratorIcon /> },
  { id: 'sessions', label: 'Sessions', enabled: false, icon: <SessionsIcon /> },
  { id: 'goals', label: 'Goals', enabled: true, icon: <GoalsIcon /> },
  { id: 'accounts', label: 'Accounts', enabled: true, icon: <AccountsIcon /> },
  { id: 'settings', label: 'Settings', enabled: true, icon: <SettingsIcon /> },
]

type SidebarView = 'chat' | 'orchestrator' | 'goals' | 'accounts' | 'settings'

export function Sidebar({
  rows,
  activeSessionId,
  activeView,
  onSelectView,
  onSelectLive,
  onRestore,
}: {
  rows: SidebarRow[]
  activeSessionId: SessionId | null
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
}) {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  )
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const open = pinned || hovering

  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovering(true), HOVER_DELAY)
  }
  const onLeave = () => {
    if (showTimer.current) clearTimeout(showTimer.current)
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY)
  }
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  const query = search.trim().toLowerCase()
  // Grouping (filter → group → sort) recomputes only when the roster, the query,
  // or the active session changes — not on every hover / pin / group-collapse
  // re-render (all of which are frequent and leave the grouping identical).
  const groups = useMemo(() => {
    const filtered = query
      ? rows.filter(
          row =>
            tabLabel(row.descriptor).toLowerCase().includes(query) ||
            row.descriptor.cwd.toLowerCase().includes(query),
        )
      : rows
    return groupByWorkspace(filtered, activeSessionId)
  }, [rows, query, activeSessionId])

  return (
    <>
      {/* Spacer reserves the collapsed rail's 48px footprint in the flex flow;
       * the rail itself floats (fixed) and expands OVER the content on hover. */}
      <div className="w-12 shrink-0" aria-hidden="true" />

      <aside
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        aria-label="Primary"
        className={
          'fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-shell-seam bg-shell-chrome transition-[width,box-shadow] duration-200 ease-out ' +
          (open ? 'w-60 shadow-[4px_0_24px_rgba(0,0,0,0.45)]' : 'w-12')
        }
      >
        {/* Logo + pin */}
        <div
          className={
            'flex h-[50px] shrink-0 items-center ' +
            (open ? 'justify-between pl-4 pr-2.5' : 'justify-center')
          }
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex text-accent">
              <PawLogo />
            </span>
            {open ? (
              <span className="truncate text-[13px] font-semibold tracking-tight text-text-primary">
                Cat Code
              </span>
            ) : null}
          </div>
          {open ? (
            <button
              type="button"
              onClick={() => setPinned(value => !value)}
              title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              aria-pressed={pinned}
              className={
                'flex h-[22px] w-[22px] items-center justify-center rounded ' +
                (pinned
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-subtle hover:text-text-muted')
              }
            >
              <PinIcon />
            </button>
          ) : null}
        </div>

        {open ? (
          <>
            {/* Search */}
            <div className="shrink-0 px-2.5 pb-2.5">
              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 flex -translate-y-1/2 text-text-subtle">
                  <SearchIcon />
                </span>
                <input
                  type="text"
                  aria-label="Search sessions"
                  placeholder="Search sessions…"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-[26px] pr-2 text-xs text-text-muted outline-none placeholder:text-text-subtle focus:border-accent/40"
                />
              </div>
            </div>

            {/* Session groups (by workspace / cwd) */}
            <div
              aria-label="Sessions"
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {groups.length === 0 ? (
                <p className="px-2 py-2 text-xs text-text-subtle">
                  {rows.length === 0 ? 'No sessions yet.' : 'No matches.'}
                </p>
              ) : (
                groups.map(group => (
                  <SessionGroup
                    key={group.cwd}
                    group={group}
                    activeSessionId={activeSessionId}
                    collapsed={collapsedGroups[group.cwd] ?? false}
                    onToggle={() =>
                      setCollapsedGroups(prev => ({
                        ...prev,
                        [group.cwd]: !(prev[group.cwd] ?? false),
                      }))
                    }
                    onSelectLive={onSelectLive}
                    onRestore={onRestore}
                  />
                ))
              )}
            </div>

            {/* Nav destinations (expanded) */}
            <nav
              aria-label="Views"
              className="shrink-0 border-t border-shell-seam px-2 pb-3 pt-2"
            >
              {NAV.map(item => (
                <NavItemExpanded
                  activeView={activeView}
                  item={item}
                  key={item.id}
                  onSelectView={onSelectView}
                />
              ))}
            </nav>
          </>
        ) : (
          /* Collapsed rail: nav icons only, anchored to the bottom. */
          <nav
            aria-label="Views"
            className="mt-auto flex flex-col items-center gap-1 pb-3 pt-2"
          >
            {NAV.map(item => (
              <NavItemRail
                activeView={activeView}
                item={item}
                key={item.id}
                onSelectView={onSelectView}
              />
            ))}
          </nav>
        )}
      </aside>
    </>
  )
}

type WorkspaceGroup = {
  /** The full cwd — the stable group key. */
  cwd: string
  /** Display label: the cwd's basename (its "workspace" name). */
  label: string
  rows: SidebarRow[]
}

/**
 * Group rows by their session's cwd (the derivable "workspace"), preserving the
 * incoming stable arrival order within each group (matches the prototype's
 * `Sidebar.jsx` `groupByWorkspace`, which never re-sorts within a group either).
 * Group order mirrors the prototype's "current workspace first, then
 * alphabetical": the group holding the active session leads, the rest sort
 * alphabetically by label, ties broken by cwd.
 */
function groupByWorkspace(
  rows: SidebarRow[],
  activeSessionId: SessionId | null,
): WorkspaceGroup[] {
  const map = new Map<string, SidebarRow[]>()
  for (const row of rows) {
    const key = row.descriptor.cwd
    const bucket = map.get(key)
    if (bucket) bucket.push(row)
    else map.set(key, [row])
  }

  const activeCwd = activeSessionId
    ? rows.find(row => row.descriptor.appSessionId === activeSessionId)?.descriptor
        .cwd ?? null
    : null

  return [...map.entries()]
    .map(([cwd, groupRows]) => ({ cwd, label: basename(cwd) || cwd, rows: groupRows }))
    .sort((a, b) => {
      if (a.cwd === activeCwd) return -1
      if (b.cwd === activeCwd) return 1
      const byLabel = a.label.localeCompare(b.label)
      return byLabel !== 0 ? byLabel : a.cwd.localeCompare(b.cwd)
    })
}

function SessionGroup({
  group,
  activeSessionId,
  collapsed,
  onToggle,
  onSelectLive,
  onRestore,
}: {
  group: WorkspaceGroup
  activeSessionId: SessionId | null
  collapsed: boolean
  onToggle: () => void
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
}) {
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={group.cwd}
        className="flex w-full items-center gap-1 px-1 pb-1.5 pt-0.5"
      >
        <span
          className={
            'flex shrink-0 text-text-subtle transition-transform ' +
            (collapsed ? '-rotate-90' : '')
          }
        >
          <ChevronIcon />
        </span>
        <span className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle">
          {group.label}
        </span>
      </button>

      {collapsed
        ? null
        : group.rows.map(row => (
            <SidebarRowItem
              key={row.descriptor.appSessionId}
              row={row}
              isActive={row.descriptor.appSessionId === activeSessionId}
              onSelectLive={onSelectLive}
              onRestore={onRestore}
            />
          ))}
    </div>
  )
}

function SidebarRowItem({
  row,
  isActive,
  onSelectLive,
  onRestore,
}: {
  row: SidebarRow
  isActive: boolean
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
}) {
  const { descriptor, visual } = row
  const id = descriptor.appSessionId
  const title = tabLabel(descriptor)
  const recency = formatRecency(descriptor.lastAttachedAt)
  const restorable = visual.kind === 'restorable'

  // A LIVE row focuses its tab (reuse App's selectTab); a RESTORABLE row goes
  // through restoreSession — re-spawns the engine, becomes a live tab with its
  // replayed transcript.
  const activate = () => (restorable ? onRestore(id) : onSelectLive(id))

  return (
    <div
      className={
        'group relative flex cursor-pointer select-none items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ' +
        (isActive
          ? 'border-accent/[0.18] bg-accent/[0.09]'
          : 'border-transparent hover:border-accent/[0.22] hover:bg-accent/[0.07]')
      }
      role="button"
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      aria-label={`session ${title} — ${visual.label}${restorable ? ', restorable' : ''}`}
      title={`${descriptor.cwd}${restorable ? ' · restore' : ''}`}
      onClick={activate}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
    >
      {isActive ? (
        <span
          className="absolute inset-y-1 left-0 w-[2px] rounded-r-sm bg-accent"
          aria-hidden="true"
        />
      ) : null}

      <StatusDot tone={visual.tone} />

      <div className="min-w-0 flex-1">
        <div
          className={
            'truncate text-xs font-medium ' +
            (isActive ? 'text-accent-soft' : 'text-text-muted')
          }
        >
          {title}
        </div>
        {recency ? (
          <div className="truncate text-[10px] text-text-subtle">{recency}</div>
        ) : null}
      </div>

      {restorable ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            onRestore(id)
          }}
          title="Restore this session"
          aria-label={`Restore session ${title}`}
          className="flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide text-tone-warn opacity-0 transition-all hover:bg-tone-warn/15 group-hover:opacity-100"
        >
          restore
        </button>
      ) : null}

      <StatusChip tone={visual.tone} label={visual.label} />
    </div>
  )
}

function NavItemExpanded({
  item,
  activeView,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  if (!item.enabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={`${item.label} — not yet migrated`}
        className="flex w-full cursor-not-allowed items-center gap-1 rounded-md py-1.5 text-text-subtle/55"
      >
        <span className="flex h-5 w-8 shrink-0 items-center justify-center">
          {item.icon}
        </span>
        <span className="text-[13px]">{item.label}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => {
	        if (item.id === 'chat' || item.id === 'orchestrator' || item.id === 'goals' || item.id === 'accounts' || item.id === 'settings') {
	          onSelectView(item.id)
	        }
      }}
      className={
        'flex w-full items-center gap-1 rounded-md py-1.5 ' +
        (active
          ? 'bg-accent/10 text-accent-soft'
          : 'text-text-subtle hover:text-text-muted')
      }
    >
      <span className="flex h-5 w-8 shrink-0 items-center justify-center">
        {item.icon}
      </span>
      <span className={'text-[13px] ' + (active ? 'font-medium' : '')}>
        {item.label}
      </span>
    </button>
  )
}

function NavItemRail({
  item,
  activeView,
  onSelectView,
}: {
  item: NavItem
  activeView: SidebarView
  onSelectView: (view: SidebarView) => void
}) {
  const active = item.enabled && item.id === activeView
  if (!item.enabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        aria-label={item.label}
        title={`${item.label} — not yet migrated`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-text-subtle/55"
      >
        {item.icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      title={item.label}
      onClick={() => {
	        if (item.id === 'chat' || item.id === 'orchestrator' || item.id === 'goals' || item.id === 'accounts' || item.id === 'settings') {
	          onSelectView(item.id)
	        }
      }}
      className={
        'flex h-8 w-8 items-center justify-center rounded-md ' +
        (active
          ? 'bg-accent/15 text-accent-soft'
          : 'text-text-subtle hover:text-text-muted')
      }
    >
      {item.icon}
    </button>
  )
}

/**
 * The status chip — the SAME mono-uppercase token the TabBar draws, in the
 * row's tone. A live/ready row is quiet (the dot carries it); every non-nominal
 * state shows its label, matching the TabBar's suppress-when-nominal rule.
 */
function StatusChip({ tone, label }: { tone: TabTone; label: string }) {
  if (tone === 'live') return null
  // Opacity-dimmed relative to the TabBar's full-strength chip (Sidebar.tsx-local
  // — not shared with TabBar's own StatusChip): the row's headline is the session
  // title, not the runtime state, so the tone still reads at a glance without
  // out-shouting the title text next to it (fidelity fix — row IA rebalance).
  return (
    <span
      className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${toneTextClass(tone)}/75`}
    >
      {label}
    </span>
  )
}

/** A solid tone dot — the quiet health indicator, identical to the TabBar's. */
function StatusDot({ tone }: { tone: TabTone }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDotClass(tone)}`}
      aria-hidden="true"
    />
  )
}

/** Relative recency from `lastAttachedAt` — the real, source-backed subtitle
 * (the prototype's `time`); model/cost are NOT rendered (no real backing, C3). */
function formatRecency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function toneTextClass(tone: TabTone): string {
  switch (tone) {
    case 'live':
      return 'text-tone-good'
    case 'busy':
      return 'text-accent'
    case 'warn':
      return 'text-tone-warn'
    case 'dead':
      return 'text-tone-danger'
  }
}

function toneDotClass(tone: TabTone): string {
  switch (tone) {
    case 'live':
      return 'bg-tone-good'
    case 'busy':
      return 'bg-accent'
    case 'warn':
      return 'bg-tone-warn'
    case 'dead':
      return 'bg-tone-danger'
  }
}

/* ── Icons (ported from the prototype's inline SVGs; attribute-only, no CSS) ── */

function PawLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <ellipse cx="6.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="11.5" cy="4" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="16.5" cy="5.5" rx="1.8" ry="2.5" opacity=".65" />
      <ellipse cx="4" cy="9.5" rx="1.4" ry="2" opacity=".45" />
      <path d="M12 21.5c-4.2 0-7.5-2.3-7.5-6 0-1.9 1.1-3.6 2.8-4.6.75-.45 1.6-.65 2.3-.65h.8c.7 0 1.55.2 2.3.65 1.7.95 2.8 2.7 2.8 4.6 0 3.7-3.3 6-7.5 6z" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function SessionsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function GoalsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

function AccountsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

// Git-branch / delegation glyph (matches the prototype's OrchestratorBadge svg).
function OrchestratorIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1V4H8v2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
      <path
        d="M2 3.5L5 6.5L8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
