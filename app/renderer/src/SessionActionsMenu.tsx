/**
 * P4-6b — `SessionActionsMenu` (`SessionActions.jsx:100-201`).
 *
 * A read-only-safe dropdown anchored to a point (the row ⋯ button rect or a
 * right-click position). It renders exactly what `resolveSessionActions`
 * decided — enabled verbs are clickable buttons, deferred verbs are inert rows
 * showing their honest reason on hover (a `title`) plus a muted "soon" tag, and
 * cut verbs never reach this component. Presentation only: the parent owns every
 * effect via `onAction`. No inline styles — P0-2 tokens + the shell classes, the
 * SessionsPage sort-dropdown idiom (scrim + fixed panel).
 */

import { useEffect, useRef, useState, Fragment, type ReactNode } from 'react'
import {
  SESSION_ACTION_SECTIONS,
  type SessionActionItem,
  type SessionActionKind,
} from './sessionActions.js'

export type SessionActionsAnchor = { top: number; left: number }

export function SessionActionsMenu({
  items,
  anchor,
  onAction,
  onClose,
}: {
  items: SessionActionItem[]
  anchor: SessionActionsAnchor
  onAction: (kind: SessionActionKind) => void
  onClose: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sections = SESSION_ACTION_SECTIONS.map(section =>
    items.filter(item => item.section === section),
  ).filter(rows => rows.length > 0)

  return (
    <>
      <div
        className="fixed inset-0 z-[70]"
        aria-hidden="true"
        onClick={onClose}
        onContextMenu={event => {
          event.preventDefault()
          onClose()
        }}
      />
      {/* §0 EXCEPTION: data-driven geometry Tailwind can't express — the
          measured anchor of the row that opened this menu. */}
      <div
        role="menu"
        aria-label="Session actions"
        className="fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.6)]"
        style={{ top: anchor.top, left: anchor.left }}
      >
        {sections.map((rows, index) => (
          <Fragment key={rows[0]?.kind ?? index}>
            {index > 0 ? <div className="my-1 h-px bg-shell-seam" /> : null}
            {rows.map(item => (
              <MenuRow
                key={item.kind}
                item={item}
                onAction={() => {
                  onAction(item.kind)
                  onClose()
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </>
  )
}

/**
 * P4-6b — the inline title editor the `rename` verb opens. Anchored like the menu
 * (same scrim + fixed-panel idiom, P0-2 tokens, no inline styles): the parent owns
 * the effect — Enter commits the trimmed title (→ `session.rename`), Esc/scrim
 * cancels. Presentation only; the actual write runs engine-side at the sidecar.
 */
export function SessionRenamePopover({
  anchor,
  initial,
  onCommit,
  onCancel,
}: {
  anchor: SessionActionsAnchor
  initial: string
  onCommit: (title: string) => void
  onCancel: () => void
}): ReactNode {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <>
      <div
        className="fixed inset-0 z-[70]"
        aria-hidden="true"
        onClick={onCancel}
      />
      {/* §0 EXCEPTION: data-driven geometry Tailwind can't express — the
          measured anchor of the row being renamed. */}
      <div
        role="dialog"
        aria-label="Rename session"
        className="fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.6)]"
        style={{ top: anchor.top, left: anchor.left }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit(value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
          placeholder="Session name"
          aria-label="Session name"
          className="w-full rounded-md border border-shell-seam bg-transparent px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none focus:border-accent"
        />
      </div>
    </>
  )
}

function MenuRow({
  item,
  onAction,
}: {
  item: SessionActionItem
  onAction: () => void
}) {
  if (!item.enabled) {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        title={item.reason}
        className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] text-text-subtle/70"
      >
        <span className="flex-1 truncate">{item.label}</span>
        <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wide text-text-subtle/50">
          soon
        </span>
      </div>
    )
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onAction}
      className={
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ' +
        (item.danger
          ? 'text-tone-danger hover:bg-tone-danger/10'
          : 'text-text-muted hover:bg-white/[0.05] hover:text-text-primary')
      }
    >
      <span className="flex-1 truncate">{item.label}</span>
    </button>
  )
}
