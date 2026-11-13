import { expect, test } from 'bun:test'
import type { SlashCatalogEntry } from '../../shared/protocol.js'
import {
  applyInlineSlashCommand,
  completeSlashDraft,
  filterSlashCommands,
  findInlineSlashToken,
  findSlashCommandRanges,
  nextSlashIndex,
  parseSlashDraft,
} from './slashCommandPickerModel.js'

/** Catalog entries whose descriptions never incidentally match a name query. */
const entriesOf = (names: string[]): SlashCatalogEntry[] =>
  names.map(name => ({ name, description: 'd' }))

test('parseSlashDraft opens only on a single leading slash-token', () => {
  // Open: a bare slash and an in-progress command name (no whitespace yet).
  expect(parseSlashDraft('/')).toBe('')
  expect(parseSlashDraft('/he')).toBe('he')
  expect(parseSlashDraft('/help')).toBe('help')

  // Closed: a completed command (space typed → editing args), non-slash text,
  // a slash that isn't leading, and an empty draft.
  expect(parseSlashDraft('/help ')).toBeNull()
  expect(parseSlashDraft('/help me')).toBeNull()
  expect(parseSlashDraft('hello')).toBeNull()
  expect(parseSlashDraft('type / to search')).toBeNull()
  expect(parseSlashDraft('')).toBeNull()
})

test('filterSlashCommands ranks prefix matches before substring matches', () => {
  const names = ['help', 'clear', 'compact', 'model', 'permissions']
  const entries = entriesOf(names)
  const names_ = (result: SlashCatalogEntry[]) => result.map(e => e.name)

  // Prefix group first (catalog order); no substring-only match for 'c' here.
  expect(names_(filterSlashCommands(entries, 'c'))).toEqual(['clear', 'compact'])
  // 'e' prefixes nothing but is a substring of help/clear/model/permissions —
  // all land in the substring group, in catalog order.
  expect(names_(filterSlashCommands(entries, 'e'))).toEqual([
    'help',
    'clear',
    'model',
    'permissions',
  ])
  // 'omp' is a substring of compact only.
  expect(names_(filterSlashCommands(entries, 'omp'))).toEqual(['compact'])
  // Case-insensitive.
  expect(names_(filterSlashCommands(entries, 'HE'))).toEqual(['help'])
  // A bare slash (empty query) shows the whole catalog, in order.
  expect(names_(filterSlashCommands(entries, ''))).toEqual(names)
  // No match → empty (picker stays closed).
  expect(filterSlashCommands(entries, 'zzz')).toEqual([])
})

test('filterSlashCommands puts a complete name ahead of longer names it prefixes', () => {
  const entries = entriesOf(['model', 'mode', 'review-impl', 'review'])
  const names_ = (result: SlashCatalogEntry[]) => result.map(e => e.name)
  expect(names_(filterSlashCommands(entries, 'mode'))).toEqual(['mode', 'model'])
  expect(names_(filterSlashCommands(entries, 'MODE'))).toEqual(['mode', 'model'])
  expect(names_(filterSlashCommands(entries, 'review'))).toEqual(['review', 'review-impl'])
  // A partial name keeps catalog order.
  expect(names_(filterSlashCommands(entries, 'mo'))).toEqual(['model', 'mode'])
})

test('filterSlashCommands matches on description substring, after name prefixes', () => {
  const entries: SlashCatalogEntry[] = [
    { name: 'model', description: 'Switch the model' },
    { name: 'clear', description: 'Reset the transcript' },
  ]
  // 'switch' is in no NAME but is in model's description → matches via the rest group.
  expect(filterSlashCommands(entries, 'switch').map(e => e.name)).toEqual([
    'model',
  ])
})

test('filterSlashCommands does not duplicate a name across groups', () => {
  // 'co' prefixes 'compact'; it must not ALSO appear via the substring pass.
  const result = filterSlashCommands(entriesOf(['compact', 'incompatible']), 'co')
  expect(result.map(e => e.name)).toEqual(['compact', 'incompatible'])
  expect(result.filter(e => e.name === 'compact')).toHaveLength(1)
})

test('nextSlashIndex wraps in both directions and tolerates empty', () => {
  expect(nextSlashIndex(0, 3, 1)).toBe(1)
  expect(nextSlashIndex(2, 3, 1)).toBe(0) // wrap forward
  expect(nextSlashIndex(0, 3, -1)).toBe(2) // wrap backward
  expect(nextSlashIndex(0, 0, 1)).toBe(0) // empty list → stays 0
})

test('completeSlashDraft inserts /name with a trailing space (picker closes)', () => {
  const draft = completeSlashDraft('help')
  expect(draft).toBe('/help ')
  // The completed draft no longer opens the picker (space present).
  expect(parseSlashDraft(draft)).toBeNull()
})

test('findInlineSlashToken finds the slash token around the caret after whitespace', () => {
  expect(findInlineSlashToken('fix /el', 7)).toEqual({ start: 4, end: 7, query: 'el' })
  // The token runs past the caret to the end of the name.
  expect(findInlineSlashToken('fix /eli5 now', 6)).toEqual({ start: 4, end: 9, query: 'eli5' })
  expect(findInlineSlashToken('line\n/', 6)).toEqual({ start: 5, end: 6, query: '' })
  expect(findInlineSlashToken('/re', 3)).toEqual({ start: 0, end: 3, query: 're' })
  // Paths, a caret past the name, and a caret outside the draft are not tokens.
  expect(findInlineSlashToken('see a/b', 7)).toBeNull()
  expect(findInlineSlashToken('fix /eli5 now', 10)).toBeNull()
  expect(findInlineSlashToken('fix', 8)).toBeNull()
  expect(findInlineSlashToken('/x', 0)).toBeNull()
})

test('applyInlineSlashCommand replaces only the token and reuses a following space', () => {
  const draft = 'fix /el now'
  const token = findInlineSlashToken(draft, 7)!
  expect(applyInlineSlashCommand(draft, token, 'eli5')).toEqual({ text: 'fix /eli5 now', caret: 10 })
  const atEnd = findInlineSlashToken('fix /el', 7)!
  expect(applyInlineSlashCommand('fix /el', atEnd, 'eli5')).toEqual({ text: 'fix /eli5 ', caret: 10 })
  const beforeNewline = findInlineSlashToken('fix /el\nok', 7)!
  expect(applyInlineSlashCommand('fix /el\nok', beforeNewline, 'eli5'))
    .toEqual({ text: 'fix /eli5 \nok', caret: 10 })
})

test('findSlashCommandRanges keeps only known names at the start or after whitespace', () => {
  const known = (name: string) => name === 'eli5'
  expect(findSlashCommandRanges('/eli5 a/eli5 /eli5x\t/eli5.', known)).toEqual([
    { start: 0, end: 5 },
    { start: 20, end: 25 },
  ])
  // The leading position may use a different set.
  expect(findSlashCommandRanges('/new /new', (name, start) => name === 'new' && start === 0))
    .toEqual([{ start: 0, end: 4 }])
})
