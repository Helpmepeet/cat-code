import { expect, test } from 'bun:test'
import { codeModeSourceFolds, codeModeSourceRows } from './codeModeSourceFolds.js'

const text = ['*** Begin Patch', ...Array(6).fill('pasted `escaped` text'), '*** End Patch']
  .map(line => line.replaceAll('`', String.fromCharCode(92, 96)))

test('folds only literal content and preserves code following the closing delimiter', () => {
  const lines = ['// ` comment', 'const q = "`"', 'const p = String.raw`', ...text, '`; output(`done`)']
  const folds = codeModeSourceFolds(lines)
  expect(codeModeSourceRows(lines, folds, new Set()).map(row => row.text)).toEqual([
    lines[0], lines[1], 'const p = String.raw`…`; output(`done`)',
  ])
  expect(codeModeSourceRows(lines, folds, new Set([2])).map(row => row.text)).toEqual(lines)
})

test('does not fold comments, ordinary strings, short templates, or invalid source', () => {
  const examples = [
    ['/* `', ...text, '` */'],
    ['const q = "`\\', ...text.map(line => line + '\\'), '`"'],
    ['const q = `', ...text.slice(0, 7), '`', 'output(q)'],
    ['const q = `', ...text, '`; output('],
    ['const q = `', ...text],
  ]
  for (const lines of examples) expect(codeModeSourceFolds(lines)).toEqual([])
})

test('keeps interpolations and code between adjacent multiline template chunks', () => {
  const lines = ['const p = `', ...text, '${lookup(`name`)}', ...text, '`; output(p)']
  const folds = codeModeSourceFolds(lines)
  const folded = codeModeSourceRows(lines, folds, new Set())
  expect(folded.map(row => row.text)).toEqual(['const p = `…${lookup(`name`)}…`; output(p)'])
  expect(folded[0]?.folds).toHaveLength(2)
  expect(codeModeSourceRows(lines, folds, new Set(), folds[1]).map(row => row.text)).toEqual([
    'const p = `…${lookup(`name`)}', ...text, '`; output(p)',
  ])
})
