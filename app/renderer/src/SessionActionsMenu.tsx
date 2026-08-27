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
 *
 * P4-30 restored four prototype elements PARITY-LEDGER §17 recorded as dropped
 * with no §0 flag: the `SA_IC` leading-icon slot (`SessionActionIcons.tsx`), the
 * `SectionLabel` header, the `sa-pop` entrance (menu + rename popover), and the
 * Copy row's side flyout.
 *
 * P4-39 moved placement here, the §17 gap this comment used to cede to the call
 * sites. The anchor is now the TRIGGER's rect (or pointer) and this component
 * resolves it against the viewport with the pure `placeSessionActionsMenu`,
 * which is what gives every entry point the bottom-flip at once, including the
 * sidebar and Sessions-page right-click paths that clamped nothing at all.
 * Whether a real menu clipped before this is still unconfirmed in a running app.
 */

import { useEffect, useRef, useState, Fragment, type ReactNode } from 'react'
import {
  FOCUSABLE_ELEMENT_SELECTOR,
  handleMenuRovingKeyDown,
  usePopoverFocus,
} from './overlayFocus.js'
import {
  SESSION_ACTION_SECTIONS,
  SESSION_ACTION_SECTION_LABELS,
  SESSION_RENAME_POPOVER_HEIGHT,
  estimateSessionActionsMenuHeight,
  placeSessionActionsMenu,
  type SessionActionItem,
  type SessionActionKind,
  type SessionActionsAnchor,
} from './sessionActions.js'
import {
  ActionChevronIcon,
  SessionActionIcon,
} from './SessionActionIcons.js'

export type { SessionActionsAnchor }

/**
 * The viewport the placement is clamped into. SSR has no window, so it falls
 * back to the same nominal box `SessionsPage`'s `TagPopover` uses, which keeps
 * the rendered markup deterministic in tests.
 */
function readViewport(): { width: number; height: number } {
  return typeof window === 'undefined'
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight }
}

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
  const menuRef = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: menuRef,
    onEscape: onClose,
  })

  const sections = SESSION_ACTION_SECTIONS.map(section => ({
    section,
    rows: items.filter(item => item.section === section),
  })).filter(group => group.rows.length > 0)
  const placement = placeSessionActionsMenu(
    anchor,
    readViewport(),
    estimateSessionActionsMenuHeight(items),
  )

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
          measured anchor of the row that opened this menu, resolved against the
          viewport by `placeSessionActionsMenu`. The flipped case anchors
          `bottom`, so the panel grows upward from the trigger. */}
      <div
        ref={menuRef}
        role="menu"
        aria-label="Session actions"
        onKeyDown={handleMenuRovingKeyDown}
        className="animate-sa-pop fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
        style={
          placement.placeAbove
            ? { bottom: placement.bottom, left: placement.left }
            : { top: placement.top, left: placement.left }
        }
      >
        {sections.map(({ section, rows }, index) => {
          const label = SESSION_ACTION_SECTION_LABELS[section]
          return (
            <Fragment key={section}>
              {index > 0 ? <div className="my-1 h-px bg-shell-seam" /> : null}
              {label ? <SectionLabel>{label}</SectionLabel> : null}
              {rows.map(item =>
                item.flyout ? (
                  <MenuFlyoutRow
                    key={item.kind}
                    item={item}
                    onAction={kind => {
                      restoreTriggerFocus()
                      onAction(kind)
                      onClose()
                    }}
                  />
                ) : (
                  <MenuRow
                    key={item.kind}
                    item={item}
                    onAction={() => {
                      restoreTriggerFocus()
                      onAction(item.kind)
                      onClose()
                    }}
                  />
                ),
              )}
            </Fragment>
          )
        })}
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
  const popoverRef = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: popoverRef,
    onEscape: onCancel,
    initialFocusSelector: FOCUSABLE_ELEMENT_SELECTOR,
  })
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  // P4-39 — same placement path as the menu, with its own height: it shares the
  // menu's anchor (App reuses the target's anchor when Rename opens it), so it
  // would otherwise be laid out against the trigger's TOP edge.
  const placement = placeSessionActionsMenu(
    anchor,
    readViewport(),
    SESSION_RENAME_POPOVER_HEIGHT,
  )
  return (
    <>
      <div
        className="fixed inset-0 z-[70]"
        aria-hidden="true"
        onClick={onCancel}
      />
      {/* §0 EXCEPTION: data-driven geometry Tailwind can't express — the
          measured anchor of the row being renamed, resolved against the viewport
          by `placeSessionActionsMenu`. */}
      <div
        ref={popoverRef}
        role="dialog"
        aria-label="Rename session"
        className="animate-sa-pop fixed z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
        style={
          placement.placeAbove
            ? { bottom: placement.bottom, left: placement.left }
            : { top: placement.top, left: placement.left }
        }
      >
        <input
          ref={inputRef}
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              restoreTriggerFocus()
              onCommit(value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              restoreTriggerFocus()
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

/**
 * P4-30 — `SectionLabel` (`SessionActions.jsx:144-146`). Only sections that
 * actually carry a name in the prototype render one (see
 * `SESSION_ACTION_SECTION_LABELS`); the rest keep the divider alone.
 */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-[3px] pt-[7px] text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-ghost">
      {children}
    </div>
  )
}

/**
 * P4-30 — the Copy row's side submenu (`SessionActions.jsx:172-182`): the host
 * row is inert chrome that opens on hover and closes when the pointer leaves the
 * pair. Only the children dispatch.
 *
 * KEYBOARD: the host carries `tabIndex={0}` deliberately. Before the flyout, the
 * copy verb was a plain Tab-reachable `<button>`; folding it into a hover-only
 * group would have made it mouse-only, a regression the prototype's own
 * mouse-only flyout does not excuse. Focus opens the group (focusin bubbles, so
 * moving onto a child keeps it open) and focus leaving the whole subtree closes
 * it, which is what `relatedTarget` containment checks. Without the tabIndex the
 * `onFocus` here would be dead code, because nothing inside is focusable until
 * the group is already open.
 */
function MenuFlyoutRow({
  item,
  onAction,
}: {
  item: SessionActionItem
  onAction: (kind: SessionActionKind) => void
}) {
  const [open, setOpen] = useState(false)
  if (!item.enabled) return <MenuRow item={item} onAction={() => {}} />
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <div
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={0}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-primary focus-visible:bg-white/[0.05] focus-visible:text-text-primary focus-visible:outline-none"
      >
        <span className="flex shrink-0 text-text-subtle">
          <SessionActionIcon kind={item.kind} />
        </span>
        <span className="flex-1 truncate">{item.label}</span>
        <span className="flex shrink-0 text-text-ghost">
          <ActionChevronIcon />
        </span>
      </div>
      {open ? (
        <div
          role="menu"
          aria-label={item.label}
          onKeyDown={handleMenuRovingKeyDown}
          className="animate-sa-pop absolute -top-[5px] left-full z-[72] ml-1 w-[190px] rounded-[10px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
        >
          {item.flyout?.map(child => (
            <MenuRow
              key={child.kind}
              item={child}
              onAction={() => onAction(child.kind)}
            />
          ))}
        </div>
      ) : null}
    </div>
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
        aria-label={item.reason ? `${item.label}, ${item.reason}` : item.label}
        className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] text-text-subtle/70"
      >
        <span className="flex shrink-0">
          <SessionActionIcon kind={item.kind} />
        </span>
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
      <span className="flex shrink-0 text-text-subtle">
        <SessionActionIcon kind={item.kind} />
      </span>
      <span className="flex-1 truncate">{item.label}</span>
    </button>
  )
}
