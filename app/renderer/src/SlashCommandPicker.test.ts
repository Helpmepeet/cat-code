import { expect, test } from 'bun:test'
import {
  completeSlashDraft,
  filterSlashCommands,
  nextSlashIndex,
  parseSlashDraft,
} from './SlashCommandPicker.js'

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

  // Prefix group first (catalog order); no substring-only match for 'c' here.
  expect(filterSlashCommands(names, 'c')).toEqual(['clear', 'compact'])
  // 'e' prefixes nothing but is a substring of help/clear/model/permissions —
  // all land in the substring group, in catalog order.
  expect(filterSlashCommands(names, 'e')).toEqual([
    'help',
    'clear',
    'model',
    'permissions',
  ])
  // 'omp' is a substring of compact only.
  expect(filterSlashCommands(names, 'omp')).toEqual(['compact'])
  // Case-insensitive.
  expect(filterSlashCommands(names, 'HE')).toEqual(['help'])
  // A bare slash (empty query) shows the whole catalog, in order.
  expect(filterSlashCommands(names, '')).toEqual(names)
  // No match → empty (picker stays closed).
  expect(filterSlashCommands(names, 'zzz')).toEqual([])
})

test('filterSlashCommands does not duplicate a name across groups', () => {
  // 'co' prefixes 'compact'; it must not ALSO appear via the substring pass.
  const result = filterSlashCommands(['compact', 'incompatible'], 'co')
  expect(result).toEqual(['compact', 'incompatible'])
  expect(result.filter(name => name === 'compact')).toHaveLength(1)
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
