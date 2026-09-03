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
  // A toggle row inside a menu is `menuitemcheckbox`, and arrow-key roving must
  // reach it like any other row; without this it is Tab-reachable but skipped by
  // the arrows, which reads as a dead row to anyone driving the menu by keyboard.
  'button[role="menuitemcheckbox"]:not([disabled])',
  '[role="menuitem"][tabindex]:not([tabindex="-1"])',
  '[role="menuitemradio"][tabindex]:not([tabindex="-1"])',
  '[role="menuitemcheckbox"][tabindex]:not([tabindex="-1"])',
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

type ModalFocusOwner = symbol

/**
 * A popover entry shares this stack with modals (Bug 2 fix) purely so a
 * popover can tell whether a modal opened on top of it — it is NOT a second
 * kind of modal. `isTop` stays filtered to `'modal'` entries so modal-vs-modal
 * arbitration (and a modal's own Tab trap while a popover is nested inside
 * it, e.g. PlanPanel's ApproveMenu) is byte-for-byte the pre-existing
 * behavior; `isBlockedByModal` is the one new query, used only by popovers.
 */
type ModalFocusEntryKind = 'modal' | 'popover'

type ModalFocusEntry = {
  owner: ModalFocusOwner
  container: HTMLElement | null
  restoreTarget: HTMLElement | null
  kind: ModalFocusEntryKind
}

export type ModalFocusStack = {
  register(
    owner: ModalFocusOwner,
    container: HTMLElement | null,
    restoreTarget: HTMLElement | null,
    kind?: ModalFocusEntryKind,
  ): void
  unregister(owner: ModalFocusOwner): {
    restoreTarget: HTMLElement | null
    shouldRestore: boolean
  }
  /** True iff `owner` is the topmost `'modal'`-kind entry. A popover above or
   * below never changes this — see the type doc comment above. */
  isTop(owner: ModalFocusOwner): boolean
  /** True iff a `'modal'`-kind entry is registered above `owner`'s own
   * position. A popover uses this to defer Escape to a modal opened on top
   * of it (Bug 2), rather than consuming Escape unconditionally. */
  isBlockedByModal(owner: ModalFocusOwner): boolean
}

export type OverlayFocusRemoval = {
  restoreTarget: HTMLElement | null
  shouldRestore: boolean
}

/** The one restoration decision both modal and popover cleanups honor. */
export function restoreTargetForRemoval(
  removal: OverlayFocusRemoval,
): HTMLElement | null {
  return removal.shouldRestore ? removal.restoreTarget : null
}

function resolveConnectedRestoreTarget(
  entries: readonly ModalFocusEntry[],
  initial: HTMLElement | null,
): HTMLElement | null {
  let target = initial
  const visited = new Set<HTMLElement>()
  while (target && !target.isConnected && !visited.has(target)) {
    visited.add(target)
    const owningEntry = [...entries]
      .reverse()
      .find(entry => entry.container?.contains(target))
    target = owningEntry?.restoreTarget ?? null
  }
  return target?.isConnected ? target : null
}

export function createModalFocusStack(): ModalFocusStack {
  const entries: ModalFocusEntry[] = []

  return {
    register(owner, container, restoreTarget, kind = 'modal') {
      const existing = entries.findIndex(entry => entry.owner === owner)
      if (existing >= 0) {
        entries[existing] = { owner, container, restoreTarget, kind }
        return
      }
      entries.push({ owner, container, restoreTarget, kind })
    },

    unregister(owner) {
      const index = entries.findIndex(entry => entry.owner === owner)
      if (index < 0) {
        return { restoreTarget: null, shouldRestore: false }
      }
      const [removed] = entries.splice(index, 1)
      const wasTop = index === entries.length
      if (!removed) {
        return { restoreTarget: null, shouldRestore: false }
      }

      for (let higher = index; higher < entries.length; higher += 1) {
        const entry = entries[higher]
        if (
          entry?.restoreTarget &&
          removed.container?.contains(entry.restoreTarget)
        ) {
          entry.restoreTarget = removed.restoreTarget
        }
      }

      return {
        restoreTarget: wasTop
          ? resolveConnectedRestoreTarget(entries, removed.restoreTarget)
          : null,
        shouldRestore: wasTop,
      }
    },

    isTop(owner) {
      const modalEntries = entries.filter(entry => entry.kind === 'modal')
      return modalEntries.at(-1)?.owner === owner
    },

    isBlockedByModal(owner) {
      const index = entries.findIndex(entry => entry.owner === owner)
      if (index < 0) return false
      return entries.slice(index + 1).some(entry => entry.kind === 'modal')
    },
  }
}

export function modalKeyAction(
  activeOwner: boolean,
  event: {
    key: string
    defaultPrevented: boolean
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
  },
): 'escape' | 'tab' | null {
  if (!activeOwner || event.defaultPrevented) return null
  if (overlayEscapeAction(event) === 'close') return 'escape'
  // Mirror overlayEscapeAction's modifier rejection: Ctrl/Cmd/Alt+Tab are OS-
  // or app-level chords (window/tab switching), never the plain focus-trap
  // Tab this branch traps. Without this, e.g. Ctrl+Tab got treated as a bare
  // Tab and swallowed by the modal's focus wrap.
  return event.key === 'Tab' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
    ? 'tab'
    : null
}

/**
 * A popover's Escape arbitration (Bug 2). `activeOwner` is
 * `!stack.isBlockedByModal(owner)` — false when a modal opened on top of
 * this popover, so that popover's Escape listener (which may run first
 * purely by registration order) yields instead of unconditionally
 * `preventDefault()`-ing and restoring focus behind the modal.
 */
export function popoverKeyAction(
  activeOwner: boolean,
  event: {
    key: string
    defaultPrevented: boolean
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
  },
): 'escape' | null {
  if (!activeOwner || event.defaultPrevented) return null
  return overlayEscapeAction(event) === 'close' ? 'escape' : null
}

const modalFocusStack = createModalFocusStack()

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
  const ownerRef = useRef<ModalFocusOwner>(Symbol('modal-focus-owner'))
  const initialFocusRef = useRef(initialFocus)
  const restoreOnCloseRef = useRef(restoreOnClose)
  initialFocusRef.current = initialFocus
  restoreOnCloseRef.current = restoreOnClose

  useEffect(() => {
    if (!open) return
    const owner = ownerRef.current
    modalFocusStack.register(
      owner,
      containerRef.current,
      activeHtmlElement(),
      'modal',
    )
    const frame = requestAnimationFrame(() => {
      if (!modalFocusStack.isTop(owner)) return
      const container = containerRef.current
      if (initialFocusRef.current === 'container') container?.focus()
      else focusFirst(container, FOCUSABLE_ELEMENT_SELECTOR, true)
    })
    return () => {
      cancelAnimationFrame(frame)
      const removal = modalFocusStack.unregister(owner)
      if (restoreOnCloseRef.current) {
        restoreFocus(restoreTargetForRemoval(removal))
      }
    }
  }, [containerRef, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = modalKeyAction(
        modalFocusStack.isTop(ownerRef.current),
        event,
      )
      if (escapeEnabled && action === 'escape') {
        event.preventDefault()
        onEscape()
        return
      }
      if (action !== 'tab') return
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
  const ownerRef = useRef<ModalFocusOwner>(Symbol('popover-focus-owner'))
  const triggerFocusRef = useRef<HTMLElement | null>(null)

  const restoreTriggerFocus = useCallback(() => {
    restoreFocus(triggerFocusRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    const owner = ownerRef.current
    triggerFocusRef.current = activeHtmlElement()
    // Join the SAME stack `useModalFocus` registers with (kind: 'popover'),
    // so `isBlockedByModal` below can tell a modal opened on top of this
    // popover apart from the ordinary case (no modal involved at all).
    modalFocusStack.register(
      owner,
      containerRef.current,
      triggerFocusRef.current,
      'popover',
    )
    const frame = requestAnimationFrame(() => {
      focusFirst(containerRef.current, initialFocusSelector, false)
    })
    return () => {
      cancelAnimationFrame(frame)
      restoreFocus(restoreTargetForRemoval(modalFocusStack.unregister(owner)))
    }
  }, [containerRef, initialFocusSelector, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = popoverKeyAction(
        !modalFocusStack.isBlockedByModal(ownerRef.current),
        event,
      )
      if (action !== 'escape') return
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
