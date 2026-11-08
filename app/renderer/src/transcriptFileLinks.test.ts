import { expect, test } from 'bun:test'
import { bareFilePaths, isInlineFilePath, recoverAbsoluteFileLinkPath, workspaceFileHref } from './transcriptFileLinks.js'
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

test('bare prose admits only known file names, and known extensionless names need path context', () => {
  expect(bareFilePaths('object.property window.catcode.openWorkspaceFile Node.js README.md Makefile ./Makefile app/Dockerfile')).toEqual([
    'Node.js', 'README.md', './Makefile', 'app/Dockerfile',
  ])
  for (const name of ['Makefile', 'Dockerfile', '.env', '.gitignore', 'src/Makefile']) expect(isInlineFilePath(name)).toBe(true)
})

test('a prose label and colon stay outside a whole relative path', () => {
  expect(bareFilePaths('Created at:docs/reports/summary.md.')).toEqual(['docs/reports/summary.md'])
})

test('absolute link recovery only removes the observed leading non-joiner after URL decoding', () => {
  const path = '/repo/src/memoryTypes.ts:43'
  expect(workspaceFileHref(`%E2%80%8C${path}`)).toBe(`\u200c${path}`)
  expect(recoverAbsoluteFileLinkPath(workspaceFileHref(`%E2%80%8C${path}`)!)).toBe(path)
  for (const literal of [
    path, '/repo/\u200cmemoryTypes.ts:43', '\u200cmemoryTypes.ts:43',
    '\u200c//server/file.ts', '\u200c\u200c/repo/file.ts',
    '\u200c~/file.ts', '\u200chttps://example.com/file.ts', '\u200cfile:///repo/file.ts',
    '\u200b/repo/file.ts', '\u200d/repo/file.ts',
  ]) expect(recoverAbsoluteFileLinkPath(literal)).toBeNull()
})
