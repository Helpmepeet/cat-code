import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

/**
 * Shared upward-popover state for the composer's control faces (Model, Reasoning
 * effort, Permission mode, account switcher, and the context dialog). Extracted to
 * its own module so `ComposerActionsBar` and `PermissionModeChip` share ONE focus
 * lifecycle without a circular import (ComposerActionsBar imports PermissionModeChip).
 *
 * Owns: the open flag; an outer ref that dismisses on outside click/Escape; and the
 * ACCT-2 focus lifecycle a `role="menu"` panel owes its items — focus moves into the
 * panel's first menu item on open, and Escape or a selection (via {@link close})
 * restores focus to the trigger BEFORE the panel unmounts instead of falling back to
 * `<body>`. Plain outside-click leaves focus wherever the user clicked — only
 * Escape/selection force it back.
 */
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const firstItem = ref.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]',
    )
    firstItem?.focus()
  }, [open])

  return { open, setOpen, close, ref, triggerRef }
}

/**
 * The composer popover menu's focusable items. A natively `disabled` item (the
 * permission chip's bypass row when the trusted flag is off) is EXCLUDED — it can't
 * take focus. An `aria-disabled` item is KEPT: the account switcher's active/capped
 * rows are intentionally aria-disabled-but-focusable (ACCT-6) so roving lands on them
 * to announce their state, unlike Model/Effort where truly disabled items don't exist.
 */
export const MENU_ROVING_ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

/**
 * Feature #13 — pure roving-index math for an in-panel menu. Given the pressed key,
 * the currently focused item index (`-1` when focus is not on an item yet), and the
 * item count, returns the index to move focus to, or `null` when the key is not a
 * roving key. Arrow keys wrap around; Home/End jump to the ends. Pure so it is
 * unit-testable without a DOM (the renderer suite is SSR-only — it cannot fire a
 * keydown, so the DOM wiring in {@link handleMenuRovingKeyDown} owes an operator eyeball).
 */
export function nextMenuRovingIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % count
    case 'ArrowUp':
      return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * Feature #13 — in-panel arrow-key roving for a composer popover `role="menu"`. Wire
 * as the panel's `onKeyDown`: ArrowUp/Down move focus to the prev/next focusable item
 * with wrap-around, Home/End jump to the ends. Enter/Space fall through to the focused
 * native `<button>` (activation already works); Escape falls through to
 * {@link usePopover}'s document handler (close + restore focus to the trigger). Only a
 * `role="menu"` panel wires this — a `role="dialog"` info panel has no navigable items.
 */
export function handleMenuRovingKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
): void {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(MENU_ROVING_ITEM_SELECTOR),
  )
  if (items.length === 0) return
  const active = document.activeElement
  const currentIndex = active instanceof HTMLElement ? items.indexOf(active) : -1
  const target = nextMenuRovingIndex(event.key, currentIndex, items.length)
  if (target === null) return
  event.preventDefault()
  items[target]?.focus()
}
