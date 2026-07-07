/**
 * TabBar — one tab per LIVE session. Presentational: it renders the roster +
 * per-tab visual state and raises intent callbacks; all host calls live in App.
 *
 * ARIA tab widget with roving tabindex: only the active tab is tabbable, arrows
 * move focus+selection between tabs, Enter/Space activate. This is an unmodified-
 * key handler scoped to a focused tab, so it never collides with the global
 * ⌘1..9 chords (App) or with typing in the prompt input.
 */

import { useRef, type KeyboardEvent } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import { basename } from './pathUtils.js'
import type { TabTone, TabVisualState } from './tabStatus.js'
import { MAX_WORKSPACE_PANELS } from './workspaceLayout.js'

export type TabModel = {
  descriptor: SessionDescriptor
  visual: TabVisualState
}

export function TabBar({
  tabs,
  activeSessionId,
  onSelect,
  onClose,
  onRestart,
  onNewTab,
  panelCount = 1,
  canAddPanel = false,
  onAddPanel,
  onRemovePanel,
}: {
  tabs: TabModel[]
  activeSessionId: SessionId | null
  onSelect: (sessionId: SessionId) => void
  onClose: (sessionId: SessionId) => void
  onRestart: (sessionId: SessionId) => void
  onNewTab: () => void
  /**
   * Split-view controls (P4-4 fidelity — the prototype's TabBar.jsx owns the
   * Split/Unsplit cluster). Optional + additive: the cluster renders only when
   * `onAddPanel` is wired, so headless TabBar tests (which omit these) are
   * untouched. They call App's EXISTING split/close-panel layout reducers — no
   * new host wiring, and the drag-tab-to-edge split path (P3-6) is unchanged.
   * §0: the prototype's "Split" duplicates the active session into a new panel;
   * ours opens the next un-panelled live session instead, because the layout
   * model forbids the same session in two panels (a real-behavior adaptation).
   */
  panelCount?: number
  canAddPanel?: boolean
  onAddPanel?: () => void
  onRemovePanel?: () => void
}) {
  // Roving-tabindex focus targets — one entry per tab, so arrow keys can move
  // DOM focus to the neighbouring tab.
  const tabRefs = useRef<Array<HTMLDivElement | null>>([])

  // Exactly one tab is tabbable (roving tabindex): the active one, or the first
  // tab when nothing is active yet, so the tablist is always keyboard-reachable.
  const activeIndex = tabs.findIndex(
    tab => tab.descriptor.appSessionId === activeSessionId,
  )
  const tabbableIndex = activeIndex >= 0 ? activeIndex : 0

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const id = tabs[index]?.descriptor.appSessionId
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
      case 'Home':
      case 'End': {
        if (tabs.length === 0) return
        event.preventDefault()
        const target =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : (index - 1 + tabs.length) % tabs.length
        const next = tabs[target]?.descriptor.appSessionId
        if (next) onSelect(next) // roving tabindex → selection follows focus
        tabRefs.current[target]?.focus()
        return
      }
      case 'Enter':
      case ' ': {
        if (!id) return
        event.preventDefault()
        onSelect(id)
        return
      }
      default:
        return
    }
  }

  return (
    <div
      className="flex h-10 shrink-0 items-stretch overflow-hidden border-b border-shell-seam bg-shell-chrome"
      role="tablist"
      aria-label="Sessions"
    >
      <div className="flex flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab, index) => (
          <Tab
            key={tab.descriptor.appSessionId}
            ref={element => {
              tabRefs.current[index] = element
            }}
            tab={tab}
            index={index}
            isActive={tab.descriptor.appSessionId === activeSessionId}
            isTabbable={index === tabbableIndex}
            onSelect={onSelect}
            onClose={onClose}
            onRestart={onRestart}
            onKeyDown={event => onTabKeyDown(event, index)}
          />
        ))}

        <button
          className="flex w-10 shrink-0 items-center justify-center text-xl leading-none text-text-subtle transition-colors hover:text-accent"
          onClick={onNewTab}
          title="New session  ⌘T"
          aria-label="New session"
          type="button"
        >
          +
        </button>
      </div>

      {onAddPanel ? (
        <div className="flex shrink-0 items-center gap-1 border-l border-shell-seam px-2.5">
          {panelCount < MAX_WORKSPACE_PANELS ? (
            <button
              type="button"
              onClick={onAddPanel}
              disabled={!canAddPanel}
              title={canAddPanel ? 'Split view' : 'No other session to split'}
              aria-label="Split view"
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-[3px] text-[11px] text-text-subtle transition-colors hover:border-accent/35 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-text-subtle"
            >
              <SplitIcon panelCount={panelCount} />
              <span>Split</span>
            </button>
          ) : null}
          {panelCount > 1 ? (
            <button
              type="button"
              onClick={onRemovePanel}
              title="Close last panel"
              aria-label="Unsplit"
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-[3px] text-[11px] text-text-subtle transition-colors hover:border-white/20 hover:text-text-primary"
            >
              <UnsplitIcon />
              <span>Unsplit</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Split-view icon — one darker column being added (prototype TabBar.jsx). */
function SplitIcon({ panelCount }: { panelCount: number }) {
  return (
    <svg width="15" height="11" viewBox="0 0 15 11" fill="none" aria-hidden="true">
      {panelCount === 1 ? (
        <>
          <rect x="0" y="0" width="6.5" height="11" rx="1.5" fill="currentColor" opacity="0.45" />
          <rect x="8.5" y="0" width="6.5" height="11" rx="1.5" fill="currentColor" opacity="1" />
        </>
      ) : null}
      {panelCount === 2 ? (
        <>
          <rect x="0" y="0" width="3.8" height="11" rx="1.2" fill="currentColor" opacity="0.3" />
          <rect x="5.6" y="0" width="3.8" height="11" rx="1.2" fill="currentColor" opacity="0.65" />
          <rect x="11.2" y="0" width="3.8" height="11" rx="1.2" fill="currentColor" opacity="1" />
        </>
      ) : null}
    </svg>
  )
}

/** Unsplit icon — a single merged panel (prototype TabBar.jsx). */
function UnsplitIcon() {
  return (
    <svg width="15" height="11" viewBox="0 0 15 11" fill="none" aria-hidden="true">
      <rect x="0" y="0" width="15" height="11" rx="1.5" fill="currentColor" opacity="0.6" />
      <line x1="7.5" y1="1.5" x2="7.5" y2="9.5" stroke="#09090b" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function Tab({
  ref,
  tab,
  index,
  isActive,
  isTabbable,
  onSelect,
  onClose,
  onRestart,
  onKeyDown,
}: {
  ref: (element: HTMLDivElement | null) => void
  tab: TabModel
  index: number
  isActive: boolean
  isTabbable: boolean
  onSelect: (sessionId: SessionId) => void
  onClose: (sessionId: SessionId) => void
  onRestart: (sessionId: SessionId) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  const { descriptor, visual } = tab
  const id = descriptor.appSessionId
  const title = tabLabel(descriptor)
  // First-nine jump-key hint. App's chord handler accepts ⌘ OR Ctrl; the label
  // is ⌘ (mac-first desktop app) — no clean renderer-side platform signal to
  // vary it (S3), so the primary accelerator is shown.
  const shortcut = index < 9 ? `  ⌘${index + 1}` : ''

  return (
    <div
      ref={ref}
      className={
        'group relative flex min-w-[90px] max-w-[176px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-shell-seam pl-3 pr-1.5 transition-colors ' +
        (isActive ? 'bg-shell-active' : 'hover:bg-shell-hover')
      }
      role="tab"
      aria-selected={isActive}
      // Roving tabindex: exactly one tab is in the tab order (the active one, or
      // the first tab when nothing is active — never a focus dead-end); arrows
      // move focus among the rest (handled in TabBar).
      tabIndex={isTabbable ? 0 : -1}
      title={`${descriptor.cwd}${shortcut}`}
      aria-label={`Session ${title} (${id}) — ${visual.label}${visual.needsAttention ? ', permission request waiting' : ''}`}
      draggable
      onClick={() => onSelect(id)}
      onDragStart={event => {
        event.dataTransfer.setData('text/sessionId', id)
        event.dataTransfer.effectAllowed = 'copyMove'
      }}
      onKeyDown={onKeyDown}
    >
      {isActive ? (
        <span
          className="absolute inset-x-0 bottom-0 h-[1.5px] rounded-t-sm bg-accent"
          aria-hidden="true"
        />
      ) : null}

      {visual.needsAttention ? (
        <AttentionBadge />
      ) : (
        <StatusDot tone={visual.tone} />
      )}

      <span
        className={
          'min-w-0 flex-1 truncate text-xs transition-colors ' +
          (isActive ? 'text-text-primary' : 'text-text-subtle')
        }
      >
        {title}
      </span>

      <StatusChip visual={visual} />

      {visual.restartable ? (
        <button
          className="flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide text-tone-warn transition-colors hover:bg-tone-warn/15"
          onClick={event => {
            event.stopPropagation()
            onRestart(id)
          }}
          title="Restart this session"
          aria-label={`Restart session ${title}`}
          type="button"
        >
          restart
        </button>
      ) : null}

      <button
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-sm leading-none text-text-subtle/60 opacity-0 transition-all hover:bg-white/10 hover:text-text-primary group-hover:opacity-100"
        onClick={event => {
          event.stopPropagation()
          onClose(id)
        }}
        title="Close session"
        aria-label={`Close session ${title}`}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

/**
 * The status chip — a small text token in the tab's tone. Suppressed for a
 * plain healthy `ready` tab (a live tab needs no chip; the dot carries it) so
 * the bar stays quiet; shown for every non-nominal state.
 */
function StatusChip({ visual }: { visual: TabVisualState }) {
  if (visual.tone === 'live' && visual.label === 'ready') return null
  return (
    <span
      className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${toneTextClass(visual.tone)}`}
    >
      {visual.label}
    </span>
  )
}

/** A solid tone dot — the quiet health indicator on a nominal tab. */
function StatusDot({ tone }: { tone: TabTone }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDotClass(tone)}`}
      aria-hidden="true"
    />
  )
}

/**
 * Background-attention badge — a pulsing accent dot signalling a permission
 * request waiting in a BACKGROUND session (never silently queued). It replaces
 * the status dot so the pulse is the tab's leading signal.
 */
function AttentionBadge() {
  return (
    <span
      className="relative flex h-2 w-2 shrink-0 items-center justify-center"
      aria-label="Permission request waiting"
      title="Permission request waiting"
    >
      <span className="absolute h-2 w-2 animate-ping rounded-full bg-accent opacity-75" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  )
}

/** A row's tab title: its title, else the cwd basename, else a fallback. */
export function tabLabel(descriptor: SessionDescriptor): string {
  if (descriptor.title && descriptor.title.trim().length > 0) {
    return descriptor.title
  }
  const base = basename(descriptor.cwd)
  return base.length > 0 ? base : 'New session'
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
