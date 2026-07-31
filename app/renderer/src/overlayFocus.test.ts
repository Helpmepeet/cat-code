import { expect, test } from 'bun:test'
import {
  FOCUSABLE_ELEMENT_SELECTOR,
  createModalFocusStack,
  isFocusableElement,
  modalKeyAction,
  nextTabStopIndex,
  overlayEscapeAction,
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
