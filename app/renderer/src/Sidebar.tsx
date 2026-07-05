/**
 * Sidebar (P3-5b) — the shell's left rail: the full session roster
 * (live ∪ restorable), ordered by recency, with the restore-offer surface.
 *
 * Presentational only: it renders `SidebarRow[]` and raises intent callbacks
 * (`onSelectLive` reuses App's `selectTab`; `onRestore` calls the host
 * `restoreSession`) — App owns the host plane, no bridge call lives here. Only
 * real `SessionDescriptor` fields (title, cwd, status, recency) are rendered.
 */

import type { SessionId } from '../../shared/protocol.js'
import type { SidebarRow } from './sidebarState.js'
import type { TabTone } from './tabStatus.js'
import { tabLabel } from './TabBar.js'

export function Sidebar({
  rows,
  activeSessionId,
  onSelectLive,
  onRestore,
}: {
  rows: SidebarRow[]
  activeSessionId: SessionId | null
  onSelectLive: (sessionId: SessionId) => void
  onRestore: (sessionId: SessionId) => void
}) {
  return (
    <aside
      className="hidden w-60 shrink-0 flex-col border-r border-shell-seam bg-shell-chrome md:flex"
      aria-label="Sessions"
    >
      {/* Brand header — same chrome + seam grammar as the TabBar's 40px bar,
       * so the two panels' top edges read as one frame. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-shell-seam px-4">
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-accent"
          aria-hidden="true"
        />
        <span className="truncate text-xs font-semibold tracking-tight text-text-primary">
          Cat Code
        </span>
      </div>

      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
          Sessions
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-subtle">No sessions yet.</p>
        ) : (
          rows.map(row => (
            <SidebarRowItem
              key={row.descriptor.appSessionId}
              row={row}
              isActive={row.descriptor.appSessionId === activeSessionId}
              onSelectLive={onSelectLive}
              onRestore={onRestore}
            />
          ))
        )}
      </div>
    </aside>
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
  const subtitle = basename(descriptor.cwd)
  const restorable = visual.kind === 'restorable'

  // Selecting a row: a LIVE row focuses its tab (reuse App's selectTab); a
  // RESTORABLE row goes through restoreSession — it re-spawns the engine and
  // becomes a live tab with its replayed transcript.
  const activate = () => (restorable ? onRestore(id) : onSelectLive(id))

  return (
    <div
      className={
        'group relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 transition-colors ' +
        (isActive ? 'bg-shell-active' : 'hover:bg-shell-hover')
      }
      role="button"
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
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
            'truncate text-xs ' +
            (isActive ? 'text-text-primary' : 'text-text-muted')
          }
        >
          {title}
        </div>
        <div className="truncate font-mono text-[10px] text-text-subtle">
          {subtitle}
        </div>
      </div>

      {restorable ? (
        <button
          className="flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide text-tone-warn opacity-0 transition-all hover:bg-tone-warn/15 group-hover:opacity-100"
          onClick={event => {
            event.stopPropagation()
            onRestore(id)
          }}
          title="Restore this session"
          aria-label={`Restore session ${title}`}
          type="button"
        >
          restore
        </button>
      ) : null}

      <StatusChip tone={visual.tone} label={visual.label} />
    </div>
  )
}

/**
 * The status chip — the SAME mono-uppercase token the TabBar draws, in the
 * row's tone. A live/ready row is quiet (the dot carries it); every non-nominal
 * state shows its label, matching the TabBar's suppress-when-nominal rule.
 */
function StatusChip({ tone, label }: { tone: TabTone; label: string }) {
  if (tone === 'live') return null
  return (
    <span
      className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${toneTextClass(tone)}`}
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

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
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
