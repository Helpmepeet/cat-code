import { expect, test } from 'bun:test'
import {
  DEFAULT_TOOLS_EXPANDED,
  TOOLS_EXPANDED_STORAGE_KEY,
  readToolsExpandedFromStorage,
  writeToolsExpandedToStorage,
} from './toolsExpanded.js'
import {
  memoryStorage,
  throwingStorage,
} from './viewPreferenceStorageFixture.js'

const store = (initial?: string) =>
  memoryStorage(
    initial === undefined ? {} : { [TOOLS_EXPANDED_STORAGE_KEY]: initial },
  )

test('the shipped default is the prototype default: tool cards start closed', () => {
  expect(DEFAULT_TOOLS_EXPANDED).toBe(false)
})

test('a written preference reads back', () => {
  const s = store()
  writeToolsExpandedToStorage(s, true)
  expect(readToolsExpandedFromStorage(s)).toBe(true)
  writeToolsExpandedToStorage(s, false)
  expect(readToolsExpandedFromStorage(s)).toBe(false)
})

test('nothing stored yields null, so the caller falls back to the default', () => {
  expect(readToolsExpandedFromStorage(store())).toBeNull()
})

test('a foreign, damaged or future-versioned payload is ignored, never guessed', () => {
  // Each of these would otherwise reach the transcript as a bogus expansion
  // state; a null sends the caller to the shipped default instead.
  expect(readToolsExpandedFromStorage(store('not json'))).toBeNull()
  expect(readToolsExpandedFromStorage(store('{"version":2,"expanded":true}'))).toBeNull()
  expect(readToolsExpandedFromStorage(store('{"version":1,"expanded":"yes"}'))).toBeNull()
  expect(readToolsExpandedFromStorage(store('{"version":1}'))).toBeNull()
})

test('an absent or throwing store degrades quietly, never breaking the session', () => {
  expect(readToolsExpandedFromStorage(null)).toBeNull()
  expect(() => writeToolsExpandedToStorage(null, true)).not.toThrow()
  const hostile = throwingStorage()
  expect(readToolsExpandedFromStorage(hostile)).toBeNull()
  expect(() => writeToolsExpandedToStorage(hostile, true)).not.toThrow()
})
