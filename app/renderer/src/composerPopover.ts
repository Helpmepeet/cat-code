import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  handleMenuRovingKeyDown,
  nextMenuRovingIndex,
  usePopoverFocus,
} from './overlayFocus.js'

export { handleMenuRovingKeyDown, nextMenuRovingIndex } from './overlayFocus.js'

const SELECTED_MENU_ITEM_SELECTOR =
  '[aria-checked="true"], [aria-current="true"]'

/**
 * Shared upward-popover state for the composer's control faces (Model, Reasoning
 * effort, Permission mode, account switcher, and the context dialog). Extracted to
 * its own module so `ComposerActionsBar` and `PermissionModeChip` share ONE focus
 * lifecycle without a circular import (ComposerActionsBar imports PermissionModeChip).
 *
 * Owns: the open flag; an outer ref that dismisses on outside click/Escape; and the
 * ACCT-2 focus lifecycle a `role="menu"` panel owes its items — focus moves into the
 * panel's selected menu item on open when one exists, otherwise its first menu
 * item. Escape or a selection (via {@link close})
 * restores focus to the trigger BEFORE the panel unmounts instead of falling back to
 * `<body>`. Plain outside-click leaves focus wherever the user clicked — only
 * Escape/selection force it back.
 */
export function usePopover(onFocusComposer?: () => void) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const closeWithoutRestore = useCallback(() => {
    setOpen(false)
  }, [])
  const { restoreTriggerFocus } = usePopoverFocus({
    open,
    containerRef: ref,
    onEscape: closeWithoutRestore,
    initialFocusPrioritySelector: SELECTED_MENU_ITEM_SELECTOR,
    onShiftTab: onFocusComposer,
  })
  const close = useCallback(() => {
    setOpen(false)
    restoreTriggerFocus()
  }, [restoreTriggerFocus])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return { open, setOpen, close, ref, triggerRef }
}
