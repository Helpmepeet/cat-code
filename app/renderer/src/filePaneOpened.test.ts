import { expect, test } from 'bun:test'
import { findOpenedFile, rememberOpenedFile, updateOpenedFileScroll, type OpenedPaneFiles } from './filePaneOpened.js'

test('opened files preserve requested aliases and positions within a fifty-file LRU', () => {
  let opened: OpenedPaneFiles = new Map()
  opened = rememberOpenedFile(opened, '/private/tmp/plan.md', { x: 0, y: 12 }, '/tmp/plan.md:7')
  const first = opened
  expect(findOpenedFile(opened, '/tmp/plan.md')?.scroll.y).toBe(12)
  opened = rememberOpenedFile(opened, '/repo/b.ts', { x: 3, y: 0, topLine: 42 })
  opened = updateOpenedFileScroll(opened, '/tmp/plan.md', { x: 0, y: 84 })
  expect([...opened.keys()]).toEqual(['/private/tmp/plan.md', '/repo/b.ts'])
  expect(findOpenedFile(first, '/tmp/plan.md')?.scroll.y).toBe(12)
  expect(findOpenedFile(opened, '/private/tmp/plan.md')?.scroll.y).toBe(84)
  opened = rememberOpenedFile(opened, '/private/tmp/plan.md', { x: 0, y: 84 })
  expect([...opened.keys()]).toEqual(['/repo/b.ts', '/private/tmp/plan.md'])
  for (let i = 0; i < 49; i++) opened = rememberOpenedFile(opened, `/repo/${i}.ts`, { x: 0, y: i })
  expect(opened.size).toBe(50)
  expect(findOpenedFile(opened, '/repo/b.ts')).toBeUndefined()
  expect(findOpenedFile(opened, '/tmp/plan.md')?.scroll.y).toBe(84)
})


test('repeated symlink spellings cannot grow one opened record without bound', () => {
  let opened: OpenedPaneFiles = new Map()
  for (let i = 0; i < 100; i++) opened = rememberOpenedFile(opened, '/real/report.md', { x: 0, y: 0 }, `/aliases/${i}/report.md`)
  expect(opened.size).toBe(1)
  expect(opened.get('/real/report.md')?.aliases).toHaveLength(50)
  expect(findOpenedFile(opened, '/aliases/0/report.md')).toBeUndefined()
  expect(findOpenedFile(opened, '/aliases/99/report.md')?.path).toBe('/real/report.md')
})
