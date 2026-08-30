import { expect, test } from 'bun:test'
import {
  estimateFilePathMenuHeight,
  extractLineSuffix,
  placeFilePathActionsMenu,
  resolveFilePathActionItems,
  resolveFilePathParts,
  stripLineSuffix,
  FILE_PATH_MENU_WIDTH,
  FILE_PATH_FLYOUT_WIDTH,
} from './filePathActions.js'

test('stripLineSuffix removes only trailing line and column suffixes', () => {
  expect(stripLineSuffix('src/foo.ts')).toBe('src/foo.ts')
  expect(stripLineSuffix('src/foo.ts:42')).toBe('src/foo.ts')
  expect(stripLineSuffix('src/foo.ts:42:10')).toBe('src/foo.ts')
  expect(stripLineSuffix('src/foo.ts?query=1')).toBe('src/foo.ts?query=1')
  expect(stripLineSuffix('src/C#/Program.cs')).toBe('src/C#/Program.cs')
})

test('resolveFilePathParts preserves literal hash and question-mark characters', () => {
  expect(
    resolveFilePathParts({
      rawPath: 'C#/Program.cs:42',
      cwd: '/Users/test/project',
    }),
  ).toMatchObject({
    cleanPath: 'C#/Program.cs',
    absolutePath: '/Users/test/project/C#/Program.cs:42',
    filename: 'Program.cs',
    lineSuffix: ':42',
  })
  expect(
    resolveFilePathParts({
      rawPath: 'src/what?.ts',
      cwd: '/Users/test/project',
    }),
  ).toMatchObject({
    cleanPath: 'src/what?.ts',
    absolutePath: '/Users/test/project/src/what?.ts',
    filename: 'what?.ts',
    lineSuffix: null,
  })
})

test('extractLineSuffix finds trailing line numbers', () => {
  expect(extractLineSuffix('src/foo.ts')).toBeNull()
  expect(extractLineSuffix('src/foo.ts:42')).toBe(':42')
  expect(extractLineSuffix('src/foo.ts:42:10')).toBe(':42:10')
})

test('resolveFilePathParts resolves clean, absolute, and filename with cwd', () => {
  const partsWithCwd = resolveFilePathParts({
    rawPath: 'src/components/Header.tsx:25',
    cwd: '/Users/test/project',
  })
  expect(partsWithCwd).toEqual({
    rawPath: 'src/components/Header.tsx:25',
    cleanPath: 'src/components/Header.tsx',
    absolutePath: '/Users/test/project/src/components/Header.tsx:25',
    filename: 'Header.tsx',
    lineSuffix: ':25',
  })

  // Null cwd
  const partsWithoutCwd = resolveFilePathParts({
    rawPath: 'src/foo.ts',
    cwd: null,
  })
  expect(partsWithoutCwd.absolutePath).toBeNull()
  expect(partsWithoutCwd.filename).toBe('foo.ts')

  // Already absolute path
  const partsAlreadyAbs = resolveFilePathParts({
    rawPath: '/Users/test/project/src/foo.ts:10',
    cwd: null,
  })
  expect(partsAlreadyAbs.absolutePath).toBe('/Users/test/project/src/foo.ts:10')
  expect(partsAlreadyAbs.filename).toBe('foo.ts')
})

test('resolveFilePathParts resolves dot and parent segments without changing display suffixes', () => {
  expect(
    resolveFilePathParts({
      rawPath: '../shared/what?.ts:4:2',
      cwd: '/repo/app',
    }).absolutePath,
  ).toBe('/repo/shared/what?.ts:4:2')
  expect(
    resolveFilePathParts({
      rawPath: './C#/Program.cs:42',
      cwd: '/repo/app',
    }).absolutePath,
  ).toBe('/repo/app/C#/Program.cs:42')
  expect(
    resolveFilePathParts({
      rawPath: '..\\shared\\x.ts:9',
      cwd: 'C:\\repo\\app',
    }).absolutePath,
  ).toBe('C:\\repo\\shared\\x.ts:9')
})

test('resolveFilePathActionItems creates Copy and Open in structure with flyouts', () => {
  const parts = resolveFilePathParts({
    rawPath: 'src/foo.ts',
    cwd: '/repo',
  })
  const macItems = resolveFilePathActionItems(parts, 'Macintosh; Mac OS X')
  expect(macItems).toHaveLength(2)
  expect(macItems[0].label).toBe('Copy')
  expect(macItems[0].flyout).toBeDefined()
  expect(macItems[0].flyout?.map(item => item.label)).toEqual([
    'Absolute path',
    'Relative path',
    'Filename',
  ])

  expect(macItems[1].label).toBe('Open in')
  expect(macItems[1].flyout).toBeDefined()
  expect(macItems[1].flyout?.map(item => item.label)).toEqual([
    'Default application',
    'Visual Studio Code',
    'Zed',
    'Cursor',
    'Reveal in Finder',
  ])

  // Non-mac platform label
  const linuxItems = resolveFilePathActionItems(parts, 'Linux x86_64')
  const finderItem = linuxItems[1].flyout?.find(item => item.kind === 'open-finder')
  expect(finderItem?.label).toBe('Show in file manager')
})

test('disabled absolute path when cwd is missing', () => {
  const parts = resolveFilePathParts({
    rawPath: 'src/foo.ts',
    cwd: null,
  })
  const items = resolveFilePathActionItems(parts)
  const copyFlyout = items[0].flyout
  const absItem = copyFlyout?.find(item => item.kind === 'copy-absolute')
  expect(absItem?.enabled).toBe(false)
  expect(absItem?.reason).toBe('Workspace path unavailable')
})

test('placeFilePathActionsMenu clamps within viewport and flips when needed', () => {
  const viewport = { width: 1000, height: 800 }
  const height = estimateFilePathMenuHeight(
    resolveFilePathActionItems(resolveFilePathParts({ rawPath: 'a.ts' })),
  )

  // Near top-left: places below, flyout on right
  const p1 = placeFilePathActionsMenu({ type: 'pointer', x: 100, y: 100 }, viewport, height)
  expect(p1.placeAbove).toBe(false)
  expect(p1.top).toBe(106)
  expect(p1.left).toBe(100)
  expect(p1.flipFlyoutLeft).toBe(false)

  // Near bottom: places above
  const p2 = placeFilePathActionsMenu({ type: 'pointer', x: 100, y: 780 }, viewport, height)
  expect(p2.placeAbove).toBe(true)
  expect(p2.bottom).toBe(800 - 780 + 6)
  expect(p2.flipFlyoutLeft).toBe(false)

  // Near right edge: flyout flips left
  const p3 = placeFilePathActionsMenu(
    { type: 'pointer', x: viewport.width - 50, y: 100 },
    viewport,
    height,
  )
  expect(p3.flipFlyoutLeft).toBe(true)
  expect(p3.left).toBeLessThanOrEqual(viewport.width - FILE_PATH_MENU_WIDTH - 8)
})
