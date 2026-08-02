import { expect, test } from 'bun:test'
import {
  FOCUSABLE_ELEMENT_SELECTOR,
  createModalFocusStack,
  isFocusableElement,
  modalKeyAction,
  nextTabStopIndex,
  overlayEscapeAction,
  popoverKeyAction,
  selectFocusableElements,
} from './overlayFocus.js'

type FocusNode = HTMLElement & {
  connected: boolean
  focusCount: number
  parentNode: FocusNode | null
}

function focusNode(parentNode: FocusNode | null = null): FocusNode {
  const node = {
    connected: true,
    focusCount: 0,
    parentNode,
    contains(target: Node | null) {
      let current = target as FocusNode | null
      while (current) {
        if (current === node) return true
        current = current.parentNode
      }
      return false
    },
    focus() {
      node.focusCount += 1
    },
    get isConnected() {
      return node.connected
    },
  }
  return node as unknown as FocusNode
}

type Candidate = {
  tabIndex: number
  attributes: Record<string, string>
  hiddenAncestor?: boolean
  id: string
}

function candidate(
  id: string,
  overrides: Partial<Candidate> = {},
): Candidate & {
  closest(selector: string): Element | null
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
} {
  const value: Candidate = {
    id,
    tabIndex: 0,
    attributes: {},
    ...overrides,
  }
  return {
    ...value,
    closest: () => (value.hiddenAncestor ? ({} as Element) : null),
    getAttribute: name => value.attributes[name] ?? null,
    hasAttribute: name => name in value.attributes,
  }
}

test('focusable selection keeps enabled tab stops and rejects hidden, inert, disabled, and negative candidates', () => {
  const enabled = candidate('enabled')
  const candidates = [
    enabled,
    candidate('disabled', { attributes: { disabled: '' } }),
    candidate('hidden', { attributes: { hidden: '' } }),
    candidate('inert', { attributes: { inert: '' } }),
    candidate('aria-hidden', { attributes: { 'aria-hidden': 'true' } }),
    candidate('hidden-ancestor', { hiddenAncestor: true }),
    candidate('negative', { tabIndex: -1 }),
  ]
  const container = {
    querySelectorAll(selector: string) {
      expect(selector).toBe(FOCUSABLE_ELEMENT_SELECTOR)
      return candidates
    },
  }
  expect(
    selectFocusableElements(container as unknown as HTMLElement).map(
      element => (element as unknown as Candidate).id,
    ),
  ).toEqual(['enabled'])
  expect(isFocusableElement(enabled)).toBe(true)
})

test('Tab wraps only at modal boundaries and enters from an unowned focus target', () => {
  expect(nextTabStopIndex('Tab', false, 0, 3)).toBeNull()
  expect(nextTabStopIndex('Tab', false, 1, 3)).toBeNull()
  expect(nextTabStopIndex('Tab', false, 2, 3)).toBe(0)
  expect(nextTabStopIndex('Tab', true, 0, 3)).toBe(2)
  expect(nextTabStopIndex('Tab', true, 1, 3)).toBeNull()
  expect(nextTabStopIndex('Tab', false, -1, 3)).toBe(0)
  expect(nextTabStopIndex('Tab', true, -1, 3)).toBe(2)
  expect(nextTabStopIndex('Enter', false, 2, 3)).toBeNull()
  expect(nextTabStopIndex('Tab', false, 0, 0)).toBeNull()
})

test('Escape closes only when a nested control has not already handled it', () => {
  expect(
    overlayEscapeAction({ key: 'Escape', defaultPrevented: false }),
  ).toBe('close')
  expect(
    overlayEscapeAction({ key: 'Escape', defaultPrevented: true }),
  ).toBeNull()
  expect(
    overlayEscapeAction({
      key: 'Escape',
      defaultPrevented: false,
      metaKey: true,
    }),
  ).toBeNull()
  expect(
    overlayEscapeAction({
      key: 'Escape',
      defaultPrevented: false,
      ctrlKey: true,
    }),
  ).toBeNull()
  expect(
    overlayEscapeAction({
      key: 'Escape',
      defaultPrevented: false,
      altKey: true,
    }),
  ).toBeNull()
  expect(
    overlayEscapeAction({ key: 'Enter', defaultPrevented: false }),
  ).toBeNull()
})

test('modalKeyAction ignores Ctrl/Cmd/Alt+Tab as OS-level chords, only a bare Tab traps focus', () => {
  expect(modalKeyAction(true, { key: 'Tab', defaultPrevented: false })).toBe(
    'tab',
  )
  expect(
    modalKeyAction(true, {
      key: 'Tab',
      defaultPrevented: false,
      ctrlKey: true,
    }),
  ).toBeNull()
  expect(
    modalKeyAction(true, {
      key: 'Tab',
      defaultPrevented: false,
      metaKey: true,
    }),
  ).toBeNull()
  expect(
    modalKeyAction(true, {
      key: 'Tab',
      defaultPrevented: false,
      altKey: true,
    }),
  ).toBeNull()
})

test('only the topmost concurrent modal owns Tab and bare Escape, then the underlying modal is promoted', () => {
  const stack = createModalFocusStack()
  const underlyingOwner = Symbol('tasks')
  const topOwner = Symbol('palette')
  const opener = focusNode()
  const underlyingContainer = focusNode()
  const underlyingButton = focusNode(underlyingContainer)
  const topContainer = focusNode()

  stack.register(underlyingOwner, underlyingContainer, opener)
  stack.register(topOwner, topContainer, underlyingButton)

  const tab = { key: 'Tab', defaultPrevented: false }
  const escape = { key: 'Escape', defaultPrevented: false }
  expect(modalKeyAction(stack.isTop(underlyingOwner), tab)).toBeNull()
  expect(modalKeyAction(stack.isTop(underlyingOwner), escape)).toBeNull()
  expect(modalKeyAction(stack.isTop(topOwner), tab)).toBe('tab')
  expect(modalKeyAction(stack.isTop(topOwner), escape)).toBe('escape')

  const topRemoval = stack.unregister(topOwner)
  expect(topRemoval).toEqual({
    restoreTarget: underlyingButton,
    shouldRestore: true,
  })
  expect(stack.isTop(underlyingOwner)).toBe(true)
  expect(modalKeyAction(stack.isTop(underlyingOwner), tab)).toBe('tab')
  expect(modalKeyAction(stack.isTop(underlyingOwner), escape)).toBe('escape')
})

test('listener refresh cannot reorder already-registered modal ownership', () => {
  const stack = createModalFocusStack()
  const underlyingOwner = Symbol('tasks')
  const topOwner = Symbol('palette')
  const opener = focusNode()
  const underlyingContainer = focusNode()
  const topContainer = focusNode()

  stack.register(underlyingOwner, underlyingContainer, opener)
  stack.register(topOwner, topContainer, focusNode(underlyingContainer))
  stack.register(underlyingOwner, underlyingContainer, opener)

  expect(stack.isTop(topOwner)).toBe(true)
  expect(stack.isTop(underlyingOwner)).toBe(false)
})

test('concurrent cleanup resolves restoration past removed overlay content', () => {
  const stack = createModalFocusStack()
  const underlyingOwner = Symbol('tasks')
  const topOwner = Symbol('palette')
  const opener = focusNode()
  const underlyingContainer = focusNode()
  const underlyingButton = focusNode(underlyingContainer)
  const topContainer = focusNode()

  stack.register(underlyingOwner, underlyingContainer, opener)
  stack.register(topOwner, topContainer, underlyingButton)

  underlyingContainer.connected = false
  underlyingButton.connected = false
  topContainer.connected = false

  const underlyingRemoval = stack.unregister(underlyingOwner)
  expect(underlyingRemoval).toEqual({
    restoreTarget: null,
    shouldRestore: false,
  })
  const topRemoval = stack.unregister(topOwner)
  expect(topRemoval).toEqual({
    restoreTarget: opener,
    shouldRestore: true,
  })
  expect(topRemoval.restoreTarget).not.toBe(underlyingButton)
})

test('a popover defers Escape to a modal opened on top of it, regardless of which keydown listener runs first', () => {
  const stack = createModalFocusStack()
  const popoverOwner = Symbol('composer-popover')
  const modalOwner = Symbol('command-palette')
  const trigger = focusNode()
  const popoverContainer = focusNode()
  const paletteContainer = focusNode()
  const escape = { key: 'Escape', defaultPrevented: false }

  // Composer face popover (Model / Reasoning / Permission mode) opens first.
  stack.register(popoverOwner, popoverContainer, trigger, 'popover')
  expect(stack.isBlockedByModal(popoverOwner)).toBe(false)
  expect(popoverKeyAction(!stack.isBlockedByModal(popoverOwner), escape)).toBe(
    'escape',
  )

  // Command palette opens on top via ⌘K; the popover never closed (no
  // outside mousedown occurred).
  stack.register(modalOwner, paletteContainer, trigger, 'modal')

  // The popover's own listener may still run first purely by registration
  // order (App.tsx re-registers the palette's listener every render — see
  // overlayFocus.ts). It must now yield instead of consuming Escape.
  expect(stack.isBlockedByModal(popoverOwner)).toBe(true)
  expect(
    popoverKeyAction(!stack.isBlockedByModal(popoverOwner), escape),
  ).toBeNull()
  // The palette, not the popover, owns Escape and Tab.
  expect(modalKeyAction(stack.isTop(modalOwner), escape)).toBe('escape')
  expect(
    modalKeyAction(stack.isTop(modalOwner), { key: 'Tab', defaultPrevented: false }),
  ).toBe('tab')

  // Once the palette closes, the popover regains ownership of its own Escape.
  stack.unregister(modalOwner)
  expect(stack.isBlockedByModal(popoverOwner)).toBe(false)
  expect(popoverKeyAction(!stack.isBlockedByModal(popoverOwner), escape)).toBe(
    'escape',
  )
})

test('a popover nested inside an open modal (PlanPanel + ApproveMenu) owns its own Escape without disturbing the modal Tab trap', () => {
  const stack = createModalFocusStack()
  const modalOwner = Symbol('plan-panel')
  const popoverOwner = Symbol('approve-menu')
  const opener = focusNode()
  const modalContainer = focusNode()
  const popoverContainer = focusNode(modalContainer)
  const escape = { key: 'Escape', defaultPrevented: false }
  const tab = { key: 'Tab', defaultPrevented: false }

  stack.register(modalOwner, modalContainer, opener, 'modal')
  // ApproveMenu mounts while PlanPanel is open — a popover registered ON TOP
  // of an already-open modal, the reverse ordering from the previous test.
  stack.register(popoverOwner, popoverContainer, opener, 'popover')

  // The popover is free to handle its own Escape (PlanPanel additionally
  // disables its own modal Escape via `escapeEnabled: false` while this is
  // up, so nothing here fights over it).
  expect(stack.isBlockedByModal(popoverOwner)).toBe(false)
  expect(popoverKeyAction(!stack.isBlockedByModal(popoverOwner), escape)).toBe(
    'escape',
  )

  // The modal's own Tab trap is unaffected by the nested popover sitting
  // above it in the stack — `isTop` is filtered to modal-kind entries.
  expect(stack.isTop(modalOwner)).toBe(true)
  expect(modalKeyAction(stack.isTop(modalOwner), tab)).toBe('tab')

  // Closing the popover leaves the modal exactly where it was.
  stack.unregister(popoverOwner)
  expect(stack.isTop(modalOwner)).toBe(true)
})
