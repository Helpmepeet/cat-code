import { expect, test } from 'bun:test'
import { reconcileShownSession } from './shownSession.js'

test('follows the preferred session once it owns a pane', () => {
  expect(reconcileShownSession('a', ['a', 'b'], 'b')).toBe('b')
})

test('keeps the shown session while the preferred session has no pane yet', () => {
  expect(reconcileShownSession('a', ['a', 'b'], 'created')).toBe('a')
})

test('falls back to the first pane when the shown session is gone', () => {
  expect(reconcileShownSession('closed', ['b', 'c'], null)).toBe('b')
  expect(reconcileShownSession(null, ['b'], null)).toBe('b')
})

test('shows nothing without panes', () => {
  expect(reconcileShownSession('a', [], 'a')).toBeNull()
})
