import { expect, test } from 'bun:test'
import { formatGrepDigest, grepDigest, totalGrepDigest } from './grepResult.js'

// Every payload below is the shape `GrepTool.mapToolResultToToolResultBlockParam`
// actually writes (`src/tools/GrepTool/GrepTool.ts:254-308`), not an invented one.

test('files_with_matches — the default mode — reports FILES, not matches', () => {
  const content =
    'Found 3 files\napp/renderer/src/App.tsx\napp/shared/protocol.ts\napp/sidecar/sidecarServer.ts'

  expect(grepDigest(content)).toEqual({ unit: 'files', count: 3 })
  expect(formatGrepDigest(grepDigest(content)!)).toBe('3 files')
})

test('files_with_matches with pagination still parses the count', () => {
  const content = 'Found 250 files (truncated, showing first 250)\na.ts\nb.ts'

  expect(grepDigest(content)).toEqual({ unit: 'files', count: 250 })
})

test('a single file is singular', () => {
  expect(formatGrepDigest(grepDigest('Found 1 file\na.ts')!)).toBe('1 file')
})

test('count mode reports occurrences from its trailing summary', () => {
  const content =
    'app/a.ts:4\napp/b.ts:2\n\nFound 6 total occurrences across 2 files.'

  expect(grepDigest(content)).toEqual({ unit: 'matches', count: 6 })
  expect(formatGrepDigest(grepDigest(content)!)).toBe('6 matches')
})

test('content mode counts match lines by their colon locator', () => {
  const content =
    'app/a.ts:12:const x = 1\napp/a.ts:40:const y = 2\napp/b.ts:7:const z = 3'

  expect(grepDigest(content)).toEqual({ unit: 'matches', count: 3 })
})

test('context lines do NOT inflate the match count', () => {
  // rg writes matches with `:` and -A/-B/-C context with `-`. Counting both
  // would report the window size, not the number of matches.
  const content =
    'app/a.ts-11-before\napp/a.ts:12:the match\napp/a.ts-13-after\n--\napp/b.ts:7:another match'

  expect(grepDigest(content)).toEqual({ unit: 'matches', count: 2 })
})

test('a path containing a colon cannot swallow the line number', () => {
  const content = 'app/we:ird.ts:12:hit'

  expect(grepDigest(content)).toEqual({ unit: 'matches', count: 1 })
})

test('both empty results are recognised as a real, stated zero', () => {
  expect(grepDigest('No files found')).toEqual({ unit: 'none', count: 0 })
  expect(grepDigest('No matches found')).toEqual({ unit: 'none', count: 0 })
  expect(formatGrepDigest({ unit: 'none', count: 0 })).toBe('no matches')
})

test('an unrecognised payload yields no digest rather than a guess', () => {
  expect(grepDigest('')).toBeNull()
  expect(grepDigest('rg: unrecognized flag --nope')).toBeNull()
  expect(grepDigest('some prose with no locator at all')).toBeNull()
})

test('a run total sums members that agree on the unit', () => {
  const total = totalGrepDigest([
    { unit: 'matches', count: 4 },
    { unit: 'matches', count: 6 },
    { unit: 'none', count: 0 },
  ])

  expect(total).toEqual({ unit: 'matches', count: 10 })
})

test('a MIXED-unit run refuses to total — the sum would mean nothing', () => {
  expect(
    totalGrepDigest([
      { unit: 'files', count: 3 },
      { unit: 'matches', count: 6 },
    ]),
  ).toBeNull()
})

test('a run where every reporting member found nothing totals as a real zero', () => {
  // Distinct from the mixed-unit refusal below it: "all of these found nothing"
  // is a measured answer, and must not render the same as "these do not add up".
  expect(totalGrepDigest([{ unit: 'none', count: 0 }, { unit: 'none', count: 0 }])).toEqual({
    unit: 'none',
    count: 0,
  })
  expect(totalGrepDigest([null, { unit: 'none', count: 0 }])).toEqual({
    unit: 'none',
    count: 0,
  })
})

test('a run where nothing measured anything at all has no total', () => {
  expect(totalGrepDigest([null, null])).toBeNull()
  expect(totalGrepDigest([])).toBeNull()
})
