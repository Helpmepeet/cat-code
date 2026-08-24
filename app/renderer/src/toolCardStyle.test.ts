import { expect, test } from 'bun:test'
import {
  DEFAULT_TOOL_CARD_STYLE,
  TOOL_CARD_BODY_CLASS,
  TOOL_CARD_HEADER_CLASS,
  TOOL_CARD_SHELL_CLASS,
  TOOL_CARD_STYLES,
  TOOL_CARD_STYLE_LABELS,
  TOOL_CARD_STYLE_STORAGE_KEY,
  isToolCardStyle,
  readToolCardStyleFromStorage,
  writeToolCardStyleToStorage,
} from './toolCardStyle.js'

function store(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(TOOL_CARD_STYLE_STORAGE_KEY, initial)
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

test('the shipped default is the drawing the app already had', () => {
  expect(DEFAULT_TOOL_CARD_STYLE).toBe('cards')
})

test('a written preference reads back', () => {
  const s = store()
  writeToolCardStyleToStorage(s, 'lines')
  expect(readToolCardStyleFromStorage(s)).toBe('lines')
  writeToolCardStyleToStorage(s, 'cards')
  expect(readToolCardStyleFromStorage(s)).toBe('cards')
})

test('nothing stored yields null, so the caller falls back to the default', () => {
  expect(readToolCardStyleFromStorage(store())).toBeNull()
})

test('a foreign, damaged or future-versioned payload is ignored, never guessed', () => {
  expect(readToolCardStyleFromStorage(store('not json'))).toBeNull()
  expect(
    readToolCardStyleFromStorage(store('{"version":2,"style":"lines"}')),
  ).toBeNull()
  expect(readToolCardStyleFromStorage(store('{"version":1,"style":7}'))).toBeNull()
  expect(readToolCardStyleFromStorage(store('{"version":1}'))).toBeNull()
})

test('a stored style outside the closed set is rejected, not rendered', () => {
  // The class maps are keyed by the union, so an unknown value reaching the
  // transcript would index them to undefined and strip a card's chrome
  // entirely. Read-time rejection is what keeps that unreachable.
  expect(
    readToolCardStyleFromStorage(store('{"version":1,"style":"bare"}')),
  ).toBeNull()
  expect(isToolCardStyle('bare')).toBe(false)
  expect(isToolCardStyle('lines')).toBe(true)
})

test('every style has a label and a full set of classes', () => {
  for (const style of TOOL_CARD_STYLES) {
    expect(TOOL_CARD_STYLE_LABELS[style]).toBeTruthy()
    expect(TOOL_CARD_SHELL_CLASS[style]).toContain('w-full')
    expect(TOOL_CARD_HEADER_CLASS[style]).toContain('items-center')
    expect(TOOL_CARD_BODY_CLASS[style]).toBeTruthy()
  }
})

test('lines drops the container chrome cards draws, and keeps the width', () => {
  // The whole point of the preference: same column, no box.
  expect(TOOL_CARD_SHELL_CLASS.cards).toContain('border-shell-seam')
  expect(TOOL_CARD_SHELL_CLASS.lines).not.toContain('border')
  expect(TOOL_CARD_SHELL_CLASS.lines).not.toContain('bg-white')
  expect(TOOL_CARD_SHELL_CLASS.lines).toContain('w-full')
})

test('the lines body indents under a rule instead of filling a panel', () => {
  expect(TOOL_CARD_BODY_CLASS.cards).toContain('bg-black/[0.28]')
  expect(TOOL_CARD_BODY_CLASS.lines).toContain('border-l')
  expect(TOOL_CARD_BODY_CLASS.lines).not.toContain('bg-black')
})

test('class strings are whole literals, never interpolated fragments', () => {
  // Tailwind resolves classes from literal source text, so a fragment that only
  // becomes a class at runtime produces no rule. Guards the dynamic-class trap.
  for (const style of TOOL_CARD_STYLES) {
    for (const map of [
      TOOL_CARD_SHELL_CLASS,
      TOOL_CARD_HEADER_CLASS,
      TOOL_CARD_BODY_CLASS,
    ]) {
      expect(map[style]).not.toContain('${')
    }
  }
})
