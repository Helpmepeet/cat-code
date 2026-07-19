import { expect, test } from 'bun:test'
import { nextMenuRovingIndex } from './composerPopover.js'

// Feature #13 — the in-panel roving decision function is pure, so its full
// behaviour (wrap-around, Home/End, non-roving keys, empty/single lists) is
// covered here without a DOM. The DOM glue (handleMenuRovingKeyDown) that reads
// document.activeElement and calls .focus() is operator-GUI owed — the renderer
// suite is SSR-only and cannot fire a keydown.

test('ArrowDown advances to the next item', () => {
  expect(nextMenuRovingIndex('ArrowDown', 0, 3)).toBe(1)
  expect(nextMenuRovingIndex('ArrowDown', 1, 3)).toBe(2)
})

test('ArrowDown wraps from the last item back to the first', () => {
  expect(nextMenuRovingIndex('ArrowDown', 2, 3)).toBe(0)
})

test('ArrowUp retreats to the previous item', () => {
  expect(nextMenuRovingIndex('ArrowUp', 2, 3)).toBe(1)
  expect(nextMenuRovingIndex('ArrowUp', 1, 3)).toBe(0)
})

test('ArrowUp wraps from the first item back to the last', () => {
  expect(nextMenuRovingIndex('ArrowUp', 0, 3)).toBe(2)
})

test('with no item focused yet (-1), ArrowDown lands on the first and ArrowUp on the last', () => {
  expect(nextMenuRovingIndex('ArrowDown', -1, 3)).toBe(0)
  expect(nextMenuRovingIndex('ArrowUp', -1, 3)).toBe(2)
})

test('Home jumps to the first item and End to the last, from anywhere', () => {
  expect(nextMenuRovingIndex('Home', 2, 3)).toBe(0)
  expect(nextMenuRovingIndex('End', 0, 3)).toBe(2)
  expect(nextMenuRovingIndex('Home', -1, 3)).toBe(0)
  expect(nextMenuRovingIndex('End', -1, 3)).toBe(2)
})

test('a single-item list stays put on every roving key', () => {
  expect(nextMenuRovingIndex('ArrowDown', 0, 1)).toBe(0)
  expect(nextMenuRovingIndex('ArrowUp', 0, 1)).toBe(0)
  expect(nextMenuRovingIndex('Home', 0, 1)).toBe(0)
  expect(nextMenuRovingIndex('End', 0, 1)).toBe(0)
})

test('an empty list yields null (nothing to focus) for every key', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
    expect(nextMenuRovingIndex(key, -1, 0)).toBeNull()
  }
})

test('non-roving keys yield null so activation/dismiss fall through to native/usePopover', () => {
  // Enter/Space activate the focused <button> natively; Escape/Tab are owned by
  // usePopover + the toolbar — the panel handler must not swallow them.
  for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a', 'ArrowLeft', 'ArrowRight']) {
    expect(nextMenuRovingIndex(key, 0, 3)).toBeNull()
  }
})
