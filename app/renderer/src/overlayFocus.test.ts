import { expect, test } from 'bun:test'
import {
  FOCUSABLE_ELEMENT_SELECTOR,
  isFocusableElement,
  nextTabStopIndex,
  overlayEscapeAction,
  selectFocusableElements,
} from './overlayFocus.js'

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
