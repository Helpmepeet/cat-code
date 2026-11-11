import { expect, test } from 'bun:test'
import { ComposerEditHistory, type ComposerEditSnapshot } from './composerEditHistory.js'

const snapshot = (text: string, start = text.length, end = start): ComposerEditSnapshot => ({
  text, selection: { start, end }, pastes: [],
})

test('contiguous typing groups, while paste and newline remain separate edits', () => {
  const empty = snapshot('')
  const history = new ComposerEditHistory(empty)
  history.record(empty, snapshot('a'), 'insertText', 0)
  history.record(history.current, snapshot('ab'), 'insertText', 100)
  history.record(history.current, snapshot('ab paste'), 'insertFromPaste', 200)
  history.record(history.current, snapshot('ab paste\n'), 'insertLineBreak', 300)
  expect(history.undo()?.text).toBe('ab paste')
  expect(history.undo()?.text).toBe('ab')
  expect(history.undo()).toEqual(empty)
  expect(history.redo()?.text).toBe('ab')
  expect(history.redo()?.text).toBe('ab paste')
  expect(history.redo()?.text).toBe('ab paste\n')
})

test('selection replacement restores the selection and keeps the paste payload', () => {
  const before = { ...snapshot('replace this', 8, 12), pastes: [{ id: 1, content: 'body', numLines: 0 }] }
  const after = snapshot('replace that')
  const history = new ComposerEditHistory(before)
  history.record(before, after)
  expect(history.undo()).toEqual(before)
  expect(history.redo()).toEqual(after)
})

test('caret movement, long pauses, edit kinds and explicit boundaries split typing', () => {
  const history = new ComposerEditHistory(snapshot(''))
  history.record(history.current, snapshot('ab'), 'insertText', 0)
  history.record(snapshot('ab', 0), snapshot('xab', 1), 'insertText', 100)
  history.record(history.current, snapshot('xyab', 2), 'insertText', 2_000)
  history.breakGroup()
  history.record(history.current, snapshot('xyzab', 3), 'insertText', 2_100)
  expect(history.undo()?.text).toBe('xyab')
  expect(history.undo()?.text).toBe('xab')
  expect(history.undo()?.text).toBe('ab')
  expect(history.undo()?.text).toBe('')
})

test('editing after undo discards redo; reset prevents reviving a sent draft', () => {
  const history = new ComposerEditHistory(snapshot(''))
  history.record(history.current, snapshot('sent draft'))
  history.undo()
  history.record(history.current, snapshot('new draft'))
  expect(history.redo()).toBeNull()
  history.reset(snapshot(''))
  expect(history.undo()).toBeNull()
  expect(history.redo()).toBeNull()
})

test('programmatic caret placement is retained for redo, with a bounded stack', () => {
  const history = new ComposerEditHistory(snapshot(''))
  history.record(history.current, snapshot('abc', 0))
  history.select({ start: 3, end: 3 })
  history.undo()
  expect(history.redo()?.selection).toEqual({ start: 3, end: 3 })
  for (let i = 0; i < 110; i++) history.record(history.current, snapshot(String(i)))
  let count = 0
  while (history.undo()) count++
  expect(count).toBe(100)
})
