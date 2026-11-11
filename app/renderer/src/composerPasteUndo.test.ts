import { expect, test } from 'bun:test'
import {
  createPasteState, expandPasteRefs, reducePasteAdded, reducePastesPruned,
  reduceSessionPastesRestored, selectSessionPasteState,
} from './composerState.js'

test('restored paste payload expands after pruning without reusing paste ids', () => {
  const first = reducePasteAdded(createPasteState(), 'a', 'original body')
  const original = selectSessionPasteState(first.state, 'a').entries[1]!
  const removed = reducePastesPruned(first.state, 'a', '')
  const second = reducePasteAdded(removed, 'a', 'new body')
  const restored = reduceSessionPastesRestored(second.state, 'a', [original])
  expect(expandPasteRefs(first.token, selectSessionPasteState(restored, 'a').entries)).toBe('original body')
  expect(selectSessionPasteState(restored, 'a').nextId).toBe(3)
  expect(reducePasteAdded(restored, 'a', 'third').token).toBe('[Pasted text #3]')
  expect(selectSessionPasteState(restored, 'b').entries).toEqual({})
})
