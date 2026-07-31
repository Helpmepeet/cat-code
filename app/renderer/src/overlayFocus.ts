import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'

export const FOCUSABLE_ELEMENT_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export const MENU_ITEM_SELECTOR = [
  'button[role="menuitem"]:not([disabled])',
  'button[role="menuitemradio"]:not([disabled])',
  '[role="menuitem"][tabindex]:not([tabindex="-1"])',
  '[role="menuitemradio"][tabindex]:not([tabindex="-1"])',
].join(', ')

type FocusableElement = {
  tabIndex: number
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  closest(selector: string): Element | null
}

export function isFocusableElement(element: FocusableElement): boolean {
  if (element.tabIndex < 0) return false
  if (
    element.hasAttribute('disabled') ||
    element.hasAttribute('hidden') ||
    element.hasAttribute('inert') ||
    element.getAttribute('aria-hidden') === 'true'
  ) {
    return false
  }
  return element.closest('[hidden], [inert], [aria-hidden="true"]') === null
}

export function selectFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENT_SELECTOR),
  ).filter(isFocusableElement)
}

export function nextTabStopIndex(
  key: string,
  shiftKey: boolean,
  currentIndex: number,
  count: number,
): number | null {
  if (key !== 'Tab' || count <= 0) return null
  if (currentIndex < 0) return shiftKey ? count - 1 : 0
  if (shiftKey && currentIndex === 0) return count - 1
  if (!shiftKey && currentIndex === count - 1) return 0
  return null
}

export function overlayEscapeAction({
  key,
  defaultPrevented,
  metaKey,
  ctrlKey,
  altKey,
}: {
  key: string
  defaultPrevented: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): 'close' | null {
  return key === 'Escape' &&
    !defaultPrevented &&
    !metaKey &&
    !ctrlKey &&
    !altKey
    ? 'close'
    : null
}

function activeHtmlElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
}

function restoreFocus(element: HTMLElement | null): void {
  if (element?.isConnected) element.focus()
}

function focusFirst(
  container: HTMLElement | null,
  selector: string,
  fallbackToContainer: boolean,
): void {
  if (!container) return
  const target = Array.from(
    container.querySelectorAll<HTMLElement>(selector),
  ).find(isFocusableElement)
  if (target) target.focus()
  else if (fallbackToContainer) container.focus()
}

export function useModalFocus({
  open,
  containerRef,
  onEscape,
  escapeEnabled = true,
  initialFocus = 'first',
  restoreOnClose = true,
}: {
  open: boolean
  containerRef: RefObject<HTMLElement | null>
  onEscape: () => void
  escapeEnabled?: boolean
  initialFocus?: 'first' | 'container'
  restoreOnClose?: boolean
}): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = activeHtmlElement()
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current
      if (initialFocus === 'container') container?.focus()
      else focusFirst(container, FOCUSABLE_ELEMENT_SELECTOR, true)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (restoreOnClose) restoreFocus(previousFocusRef.current)
      previousFocusRef.current = null
    }
  }, [containerRef, initialFocus, open, restoreOnClose])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        escapeEnabled &&
        overlayEscapeAction(event) === 'close'
      ) {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const container = containerRef.current
      if (!container) return
      const focusable = selectFocusableElements(container)
      if (focusable.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const current = activeHtmlElement()
      const target = nextTabStopIndex(
        event.key,
        event.shiftKey,
        current ? focusable.indexOf(current) : -1,
        focusable.length,
      )
      if (target === null) return
      event.preventDefault()
      focusable[target]?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [containerRef, escapeEnabled, onEscape, open])
}

export function usePopoverFocus({
  open,
  containerRef,
  onEscape,
  initialFocusSelector = MENU_ITEM_SELECTOR,
}: {
  open: boolean
  containerRef: RefObject<HTMLElement | null>
  onEscape: () => void
  initialFocusSelector?: string
}): { restoreTriggerFocus: () => void } {
  const triggerFocusRef = useRef<HTMLElement | null>(null)

  const restoreTriggerFocus = useCallback(() => {
    restoreFocus(triggerFocusRef.current)
  }, [])

  useEffect(() => {
    if (!open) {
      triggerFocusRef.current = null
      return
    }
    triggerFocusRef.current = activeHtmlElement()
    const frame = requestAnimationFrame(() => {
      focusFirst(containerRef.current, initialFocusSelector, false)
    })
    return () => cancelAnimationFrame(frame)
  }, [containerRef, initialFocusSelector, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (overlayEscapeAction(event) !== 'close') return
      event.preventDefault()
      restoreTriggerFocus()
      onEscape()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onEscape, open, restoreTriggerFocus])

  return { restoreTriggerFocus }
}

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

export function handleMenuRovingKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  if (event.defaultPrevented) return
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ).filter(item => item.closest('[role="menu"]') === event.currentTarget)
  if (items.length === 0) return
  const active = activeHtmlElement()
  const target = nextMenuRovingIndex(
    event.key,
    active ? items.indexOf(active) : -1,
    items.length,
  )
  if (target === null) return
  event.preventDefault()
  items[target]?.focus()
}
