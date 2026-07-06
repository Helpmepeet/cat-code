/**
 * CommandPalette (P3-7) — the ⌘K palette. Presentational shell around the pure
 * `commandPaletteModel` (which owns the real action inventory + fuzzy filter);
 * this file owns only query/cursor state, keyboard nav, and rendering.
 *
 * Keyboard-first: opens focused, ↑/↓ navigate, ↵ runs, Esc / backdrop-click
 * dismiss. Every row is a REAL action or a live/restorable session from the
 * roster — no mocked entries. Session rows carry an identity+state aria-label so
 * an operator can cite an AX-observed label (GUI-VERIFICATION honesty rule 3).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { TabTone } from './tabStatus.js'
import {
  filterPaletteItems,
  type PaletteItem,
} from './commandPaletteModel.js'

export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () => filterPaletteItems(items, query),
    [items, query],
  )
  const activeIndex =
    filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1)

  // Reset query + selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  // A new query always re-homes the cursor to the top match.
  useEffect(() => {
    setCursor(0)
  }, [query])

  // Keep the highlighted row visible during keyboard navigation.
  useEffect(() => {
    if (!open) return
    const active = listRef.current?.querySelector('[data-palette-active="true"]')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  if (!open) return null

  const runAt = (index: number): void => {
    const item = filtered[index]
    if (!item) return
    item.run()
    onClose()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const count = filtered.length
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (count > 0) setCursor(index => (Math.min(index, count - 1) + 1) % count)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (count > 0)
          setCursor(index => (Math.min(index, count - 1) - 1 + count) % count)
        break
      case 'Enter':
        event.preventDefault()
        runAt(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-shell-seam bg-shell-chrome shadow-[0_28px_70px_rgba(0,0,0,0.7)]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-shell-seam px-4 py-3">
          <SearchIcon />
          <input
            ref={inputRef}
            aria-label="Command palette search"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions and actions…"
            value={query}
          />
          <kbd className="rounded bg-shell-hover px-1.5 py-0.5 text-[10px] text-text-subtle">
            ESC
          </kbd>
        </div>

        <div
          ref={listRef}
          className="max-h-[52vh] overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="listbox"
          aria-label="Command palette results"
        >
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-text-subtle">
              No matches for{' '}
              <span className="text-text-muted">“{query}”</span>
            </p>
          ) : (
            filtered.map((item, index) => {
              // Group headers only in the grouped (no-query) view. While
              // searching, results are globally ranked (best match first), so
              // groups interleave — a per-run header would repeat "Actions".
              // Flat-when-searching matches the prototype and avoids that.
              const showHeader =
                query.trim().length === 0 &&
                (index === 0 || filtered[index - 1]?.group !== item.group)
              return (
                <div key={item.id}>
                  {showHeader ? <GroupHeader label={item.group} /> : null}
                  <PaletteRow
                    item={item}
                    isActive={index === activeIndex}
                    onHover={() => setCursor(index)}
                    onRun={() => runAt(index)}
                  />
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-shell-seam px-4 py-1.5">
          {[
            ['↑↓', 'navigate'],
            ['↵', 'run'],
            ['esc', 'dismiss'],
          ].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1.5">
              <kbd className="rounded bg-shell-hover px-1.5 py-0.5 font-mono text-[9.5px] text-text-subtle">
                {key}
              </kbd>
              <span className="text-[10px] text-text-subtle">{label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function PaletteRow({
  item,
  isActive,
  onHover,
  onRun,
}: {
  item: PaletteItem
  isActive: boolean
  onHover: () => void
  onRun: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isActive}
      aria-label={item.ariaLabel}
      data-palette-active={isActive}
      onMouseEnter={onHover}
      // onMouseDown so the click lands before the backdrop's onClose fires.
      onMouseDown={event => {
        event.preventDefault()
        onRun()
      }}
      className={
        'flex w-full items-center gap-2.5 border-l-2 px-4 py-1.5 text-left transition-colors ' +
        (isActive
          ? 'border-accent bg-shell-active'
          : 'border-transparent hover:bg-shell-hover')
      }
    >
      {item.kind === 'session' && item.tone ? (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDotClass(item.tone)}`}
          aria-hidden="true"
        />
      ) : null}

      <span
        className={
          'shrink-0 truncate text-[13px] ' +
          (isActive ? 'text-text-primary' : 'text-text-muted') +
          (item.kind === 'session' ? ' max-w-[45%]' : '')
        }
      >
        {item.label}
      </span>

      {item.kind === 'session' && item.detail ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-subtle">
          {item.detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}

      {item.kind === 'session' && item.state ? (
        <span
          className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${toneTextClass(item.tone)}`}
        >
          {item.state}
        </span>
      ) : item.detail ? (
        <kbd className="shrink-0 rounded bg-shell-hover px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
          {item.detail}
        </kbd>
      ) : null}
    </button>
  )
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-subtle">
      {label}
    </div>
  )
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      className="shrink-0 text-text-subtle"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
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

function toneTextClass(tone: TabTone | undefined): string {
  switch (tone) {
    case 'busy':
      return 'text-accent'
    case 'warn':
      return 'text-tone-warn'
    case 'dead':
      return 'text-tone-danger'
    case 'live':
    default:
      return 'text-tone-good'
  }
}
