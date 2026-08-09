import { expect, test } from 'bun:test'
import { createToolCardExpansionStore } from './toolCardExpansion.js'

test('the store remembers a choice per tool_use id', () => {
  const store = createToolCardExpansionStore()

  expect(store.get('toolu_a')).toBeUndefined()
  store.set('toolu_a', true)
  store.set('toolu_b', false)

  expect(store.get('toolu_a')).toBe(true)
  expect(store.get('toolu_b')).toBe(false)
  expect(store.get('toolu_c')).toBeUndefined()
})

test('undefined and false are distinct: never touched is not the same as closed', () => {
  // `resolveToolCardExpanded` falls back to the card's default on undefined, and
  // a run head only opens for an explicit `true` — so collapsing these two would
  // both revive closed cards and drag run heads open.
  const store = createToolCardExpansionStore()
  store.set('toolu_a', false)

  expect(store.get('toolu_a')).toBe(false)
  expect(store.get('toolu_a') === undefined).toBe(false)
})

test('a later choice replaces the earlier one', () => {
  const store = createToolCardExpansionStore()
  store.set('toolu_a', true)
  store.set('toolu_a', false)

  expect(store.get('toolu_a')).toBe(false)
})

test('inline output reveal depth follows the engine tool_use id', () => {
  const store = createToolCardExpansionStore()

  expect(store.getInlineOutputHead('toolu_a')).toBeUndefined()
  store.setInlineOutputHead('toolu_a', 230)
  store.setInlineOutputHead('toolu_b', 80)

  expect(store.getInlineOutputHead('toolu_a')).toBe(230)
  expect(store.getInlineOutputHead('toolu_b')).toBe(80)
})

test('two stores do not share memory', () => {
  const a = createToolCardExpansionStore()
  const b = createToolCardExpansionStore()
  a.set('toolu_a', true)

  expect(b.get('toolu_a')).toBeUndefined()
})
