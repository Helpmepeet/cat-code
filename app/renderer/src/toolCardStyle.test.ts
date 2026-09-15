import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_TOOL_CARD_STYLE,
  TOOL_CARD_BAND_CLASS,
  TOOL_CARD_BODY_CLASS,
  TOOL_CARD_BODY_INNER_CLASS,
  TOOL_CARD_DIVIDER_CLASS,
  TOOL_CARD_HEADER_CLASS,
  TOOL_CARD_INSET_CLASS,
  TOOL_CARD_ORPHAN_SHELL_CLASS,
  TOOL_CARD_PLAIN_HEADER_CLASS,
  TOOL_CARD_SHELL_CLASS,
  TOOL_CARD_SUB_CLASS,
  TOOL_CARD_STYLES,
  TOOL_CARD_STYLE_LABELS,
  TOOL_CARD_STYLE_STORAGE_KEY,
  isToolCardStyle,
  readToolCardStyleFromStorage,
  writeToolCardStyleToStorage,
} from './toolCardStyle.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'

const store = (initial?: string) =>
  memoryStorage(
    initial === undefined ? {} : { [TOOL_CARD_STYLE_STORAGE_KEY]: initial },
  )

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

/**
 * EVERY map, not a sample. A third style added later typechecks only if each map
 * is a full `Record<ToolCardStyle, …>`, and without this loop the suite would
 * not say which one was forgotten. `TOOL_CARD_DIVIDER_CLASS.lines` is
 * legitimately empty (no box, so no rule), so it is checked for presence of the
 * key rather than a truthy value.
 */
const ALL_CLASS_MAPS = {
  TOOL_CARD_SHELL_CLASS,
  TOOL_CARD_ORPHAN_SHELL_CLASS,
  TOOL_CARD_HEADER_CLASS,
  TOOL_CARD_PLAIN_HEADER_CLASS,
  TOOL_CARD_BAND_CLASS,
  TOOL_CARD_INSET_CLASS,
  TOOL_CARD_DIVIDER_CLASS,
  TOOL_CARD_BODY_CLASS,
  TOOL_CARD_BODY_INNER_CLASS,
  TOOL_CARD_SUB_CLASS,
}

test('every style has a label and an entry in every class map', () => {
  for (const style of TOOL_CARD_STYLES) {
    expect(TOOL_CARD_STYLE_LABELS[style]).toBeTruthy()
    const missing = Object.entries(ALL_CLASS_MAPS)
      .filter(([, map]) => typeof map[style] !== 'string')
      .map(([name]) => name)
    expect(missing).toEqual([])
  }
})

test('the collapsed band follows the body out of its panel under lines', () => {
  // A collapsed card is the default, so this band is the most common row on
  // screen. Left hardcoded it drew a lidless filled panel under a header that
  // no longer had a box.
  expect(TOOL_CARD_BAND_CLASS.cards).toContain('border-t border-shell-seam')
  expect(TOOL_CARD_BAND_CLASS.lines).not.toContain('border-t')
  expect(TOOL_CARD_BAND_CLASS.lines).toContain('border-l')
})

test('lines drops the inside-a-box inset and the inside-a-box divider', () => {
  expect(TOOL_CARD_INSET_CLASS.cards).toContain('px-3')
  expect(TOOL_CARD_INSET_CLASS.lines).not.toContain('px-')
  expect(TOOL_CARD_DIVIDER_CLASS.cards).toContain('border-t')
  expect(TOOL_CARD_DIVIDER_CLASS.lines).toBe('')
})

test('lines carries a hover affordance, since it has no border to signal one', () => {
  // `cards` is signalled by its own box; a bare row has nothing, and it sits
  // directly above run members that DO tint on hover (`ToolRunRow`).
  expect(TOOL_CARD_HEADER_CLASS.lines).toContain('hover:bg-white/[0.04]')
  expect(TOOL_CARD_PLAIN_HEADER_CLASS.lines).toContain('hover:bg-white/[0.04]')
})

test('the orphan shell stays dashed in both styles', () => {
  // The dashes are the signal that a parent is missing; losing them under
  // `lines` would silently drop the only thing that row says.
  for (const style of TOOL_CARD_STYLES) {
    expect(TOOL_CARD_ORPHAN_SHELL_CLASS[style]).toContain('border-dashed')
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

test('class names in this module are whole literals, never built at runtime', () => {
  // Tailwind resolves classes from literal SOURCE text, so a name assembled at
  // runtime produces no rule at all. This has to read the source: asserting
  // `map[style]` does not contain a '$' + '{' cannot fail, because by the time
  // the test sees the value the template has already been evaluated. Replacing
  // one entry with an interpolated name left the old version of this test fully
  // green, which is why it now reads the file.
  const source = readFileSync(new URL('./toolCardStyle.ts', import.meta.url), 'utf8')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const offenders = withoutComments
    .split('\n')
    .filter(line => /^\s*(cards|lines):/.test(line))
    .filter(line => line.includes('`'))
  expect(offenders).toEqual([])
})

test('the provider is actually mounted at the composition root', () => {
  // Gate blindness this closes: nothing in the suite renders `main.tsx` (it
  // calls createRoot at import time), so deleting the provider there would
  // leave the whole battery green while the setting silently did nothing in
  // the real app. A source assertion is weak evidence in general; here it is
  // the only evidence available short of booting Electron.
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  expect(main).toContain("from './ToolCardStyleProvider.js'")
  expect(main).toMatch(/<ToolCardStyleProvider>[\s\S]*<App \/>[\s\S]*<\/ToolCardStyleProvider>/)
})
