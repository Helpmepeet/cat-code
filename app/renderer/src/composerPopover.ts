import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  handleMenuRovingKeyDown,
  MENU_ITEM_SELECTOR,
  nextMenuRovingIndex,
  usePopoverFocus,
} from './overlayFocus.js'

export { handleMenuRovingKeyDown, nextMenuRovingIndex } from './overlayFocus.js'

const POPOVER_ITEM_SELECTOR =
  `${MENU_ITEM_SELECTOR}, [role="dialog"] button:not([disabled])`
const SELECTED_MENU_ITEM_SELECTOR =
  '[aria-checked="true"], [aria-current="true"]'

/**
 * Shared upward-popover state for run controls, permission mode, accounts, and
 * context. Separate from their components so they share one focus lifecycle.
 *
 * Owns: the open flag; trigger/panel refs that dismiss on outside click/Escape; and the
 * ACCT-2 focus lifecycle a `role="menu"` panel owes its items — focus moves into the
 * panel's selected menu item on open when one exists, otherwise its first menu
 * item. Escape or a selection (via {@link close})
 * restores focus to the trigger BEFORE the panel unmounts instead of falling back to
 * `<body>`. Pointer or keyboard focus departure dismisses without restoring the
 * trigger. Modal focus above the popover keeps its existing ownership.
 */
export function usePopover(
  onFocusComposer?: () => void,
  focusOptions?: { selector: string; prioritySelector: string },
) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Other consumers keep their panel inline; both forms share the focus lifecycle.
  const focusRef = useMemo(() => ({
    get current() { return panelRef.current ?? ref.current },
  }), [])

  const closeWithoutRestore = useCallback(() => {
    setOpen(false)
  }, [])
  const { restoreTriggerFocus, dismissWithoutRestore, isKeyboardOwner } = usePopoverFocus({
    open,
    containerRef: focusRef,
    onEscape: closeWithoutRestore,
    initialFocusSelector: focusOptions?.selector ?? POPOVER_ITEM_SELECTOR,
    initialFocusPrioritySelector: focusOptions?.prioritySelector ?? SELECTED_MENU_ITEM_SELECTOR,
    onShiftTab: onFocusComposer,
  })
  const close = useCallback(() => {
    setOpen(false)
    restoreTriggerFocus()
  }, [restoreTriggerFocus])

  useEffect(() => {
    if (!open) return
    const contains = (target: Node) =>
      ref.current?.contains(target) || panelRef.current?.contains(target)
    const onDown = (event: MouseEvent) => {
      if (!contains(event.target as Node)) dismissWithoutRestore()
    }
    const onFocusIn = (event: FocusEvent) => {
      if (isKeyboardOwner() && !contains(event.target as Node)) {
        dismissWithoutRestore()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [dismissWithoutRestore, isKeyboardOwner, open])

  return { open, setOpen, close, ref, triggerRef, panelRef }
}
