import { expect, test } from 'bun:test'
import { bareFilePaths, isInlineFilePath } from './transcriptFileLinks.js'
import { scopedTranscriptFilePath } from './transcriptFileScope.js'

test('prose discovery retains whole home and route paths without linking abbreviations', () => {
  expect(bareFilePaths('e.g., i.e., U.S. (see src/a.ts) ~/notes/setup.md src/(group)/page.tsx src/[id].tsx src/[...slug]/page.tsx foo.ts:42:7')).toEqual([
    'src/a.ts', '~/notes/setup.md', 'src/(group)/page.tsx', 'src/[id].tsx', 'src/[...slug]/page.tsx', 'foo.ts:42:7',
  ])
  expect(isInlineFilePath('src/(group)/page.tsx')).toBe(true)
  expect(isInlineFilePath('src/[id].tsx')).toBe(true)
})

test('home mentions retain their rooted identity in worker and moved-chat scopes', () => {
  expect(scopedTranscriptFilePath('~/notes.md:12', '/previous/project')).toBe('~/notes.md:12')
})
