/**
 * P4-1 shared primitive — `MentionPicker` (Surfaces.jsx:1031-1087).
 *
 * The @-mention popover P4-0 (composer) consumes. Deliberately
 * DATA-SOURCE-AGNOSTIC: the caller supplies `items` (real file paths / agents /
 * whatever) and owns what a pick MEANS — this primitive only filters by query
 * and renders. The prototype's hardcoded `MENTION_ITEMS` fixtures (files/IDE/
 * channels) do NOT migrate; P4-0 wires the real mention sources.
 *
 * Optional `tabs` reproduce the prototype's tabbed source switcher; when the
 * caller supplies items for a single source, omit them for a flat list.
 *
 * Security: `label`/`sub` are untrusted (file paths, agent-authored names) and
 * render as text nodes — never HTML.
 */

import type { ReactNode } from 'react'

export type MentionItem = {
  /** The visible primary text; also what the query matches against. */
  label: string
  /** A muted secondary line (e.g. "modified 2m ago"). */
  sub?: string
  /** Opaque payload the caller round-trips through `onPick` (defaults to label). */
  value?: string
  /** Render `label` in monospace (paths) vs the sans default (names/channels). */
  mono?: boolean
}

export type MentionTab = { id: string; label: string }

/**
 * Case-insensitive substring filter on `label` (the prototype's filter,
 * Surfaces.jsx:1040). An empty/whitespace query returns every item unchanged.
 */
export function filterMentionItems(
  items: readonly MentionItem[],
  query: string,
): MentionItem[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...items]
  return items.filter(item => item.label.toLowerCase().includes(q))
}

export function MentionPicker({
  open,
  query,
  items,
  onPick,
  onClose,
  tabs,
  activeTab,
  onTab,
  activeIndex,
  className = 'absolute left-0 bottom-[calc(100%+8px)]',
}: {
  open: boolean
  query: string
  items: readonly MentionItem[]
  onPick: (item: MentionItem) => void
  onClose?: () => void
  /** Optional source tabs (Files / Agents / …). Omit for a flat list. */
  tabs?: readonly MentionTab[]
  activeTab?: string
  onTab?: (id: string) => void
  /** Highlighted row (keyboard nav lives in the consumer, e.g. P4-0). */
  activeIndex?: number
  /** Positioning classes — the consumer anchors the popover. */
  className?: string
}): ReactNode {
  if (!open) return null
  const filtered = filterMentionItems(items, query)
  return (
    <div
      className={`z-[60] w-80 overflow-hidden rounded-xl border border-white/10 bg-surface-raised shadow-[0_14px_40px_rgba(0,0,0,0.6)] ${className}`}
      role="listbox"
      aria-label="Mentions"
    >
      {tabs && tabs.length > 0 ? (
        <div className="flex border-b border-shell-seam">
          {tabs.map(tab => {
            const isActive = tab.id === activeTab
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTab?.(tab.id)}
                className={
                  'flex-1 border-b-[1.5px] px-2 py-[7px] text-[11.5px] font-medium transition-colors ' +
                  (isActive
                    ? 'border-accent bg-accent/[0.06] text-accent'
                    : 'border-transparent text-text-subtle hover:text-text-muted')
                }
              >
                {tab.label}
              </button>
            )
          })}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close mentions"
              className="w-7 text-[13px] text-text-subtle hover:text-text-muted"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="max-h-60 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-[18px] text-center text-[11.5px] text-text-subtle">
            No matches
          </div>
        ) : (
          filtered.map((item, index) => (
            <button
              // Index-suffixed so two items sharing a label (and no distinct
              // value) don't collide on the same React key.
              key={`${index}:${item.value ?? item.label}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onPick(item)}
              className={
                'flex w-full flex-col items-start border-b border-white/[0.03] px-3 py-2 text-left transition-colors ' +
                (index === activeIndex
                  ? 'bg-white/[0.04]'
                  : 'hover:bg-white/[0.04]')
              }
            >
              <span
                className={
                  'max-w-full truncate text-[12.5px] text-text-primary ' +
                  (item.mono ? 'font-mono' : '')
                }
              >
                {item.label}
              </span>
              {item.sub ? (
                <span className="mt-px text-[10.5px] text-text-subtle">
                  {item.sub}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
