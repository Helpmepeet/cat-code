import { expect, test } from 'bun:test'
import { createTranscriptOutlineBookmarks } from './transcriptOutlineBookmarks.js'

test('temporary bookmark snapshots are immutable and isolated by prompt identity', () => {
  const store = createTranscriptOutlineBookmarks()
  const initial = store.getSnapshot()
  let changes = 0
  const unsubscribe = store.subscribe(() => { changes++ })
  store.toggle('["session-a","prompt"]')
  const first = store.getSnapshot()
  expect(initial.size).toBe(0)
  expect(first.has('["session-a","prompt"]')).toBe(true)
  expect(first.has('["session-b","prompt"]')).toBe(false)
  store.toggle('["session-b","prompt"]')
  expect(first.size).toBe(1)
  expect(store.getSnapshot().size).toBe(2)
  store.toggle('["session-a","prompt"]')
  expect(store.getSnapshot().has('["session-a","prompt"]')).toBe(false)
  expect(changes).toBe(3)
  unsubscribe()
  store.toggle('["session-b","prompt"]')
  expect(changes).toBe(3)
  expect(createTranscriptOutlineBookmarks().getSnapshot().size).toBe(0)
})
