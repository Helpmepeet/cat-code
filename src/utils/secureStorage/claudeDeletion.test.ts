import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCrossProcessSafeStorage, removeMatchingClaudeOAuthFromStores, type FreshReadResult } from './crossProcessStorage.js'
import { removeMatchingClaudeOAuthCredentials } from './index.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'

let dir: string
let previous: string | undefined
const deleted = { accessToken: 'A', refreshToken: 'refresh-A' }
const replacement = { accessToken: 'B', refreshToken: 'refresh-B' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credential-delete-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
})
afterEach(() => {
  mock.restore()
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function synthetic(initial: FreshReadResult) {
  let result = structuredClone(initial)
  const update = mock(next => { result = { status: 'present', data: structuredClone(next) }; return { success: true } })
  return {
    storage: {
      name: 'synthetic', read: () => structuredClone(result.data), readAsync: async () => structuredClone(result.data),
      readFresh: () => structuredClone(result), update,
      delete: () => { throw new Error('must not delete entire store') },
    },
    set: (next: FreshReadResult) => { result = structuredClone(next) },
    get: () => result.data,
  }
}

test('replacement published after an earlier read survives conditional deletion', () => {
  const store = synthetic({ status: 'present', data: { claudeAiOauth: deleted, other: 'keep' } })
  const wrapped = createCrossProcessSafeStorage(store.storage)
  expect(wrapped.read()?.claudeAiOauth).toEqual(deleted)
  const switched = wrapped.read()!
  switched.claudeAiOauth = replacement
  expect(wrapped.update(switched).success).toBe(true)
  expect(removeMatchingClaudeOAuthFromStores([store.storage], deleted)).toBe(true)
  expect(store.get()).toEqual({ claudeAiOauth: replacement, other: 'keep' })
  expect(store.storage.update).toHaveBeenCalledTimes(1)
})

test('matching copies in both raw backends are cleared without dropping unrelated keys', () => {
  const primary = synthetic({ status: 'present', data: { claudeAiOauth: deleted, primaryOther: 'keep' } })
  const fallback = synthetic({ status: 'present', data: { claudeAiOauth: deleted, fallbackOther: 'keep' } })
  spyOn(macOsKeychainStorage, 'readFresh').mockImplementation(primary.storage.readFresh)
  spyOn(macOsKeychainStorage, 'update').mockImplementation(primary.storage.update)
  spyOn(plainTextStorage, 'readFresh').mockImplementation(fallback.storage.readFresh)
  spyOn(plainTextStorage, 'update').mockImplementation(fallback.storage.update)
  expect(removeMatchingClaudeOAuthCredentials(deleted)).toBe(true)
  if (process.platform === 'darwin') expect(primary.get()).toEqual({ primaryOther: 'keep' })
  expect(fallback.get()).toEqual({ fallbackOther: 'keep' })
})

test('unavailable backend refuses cleanup before writing any matching copy', () => {
  const primary = synthetic({ status: 'present', data: { claudeAiOauth: deleted } })
  const fallback = synthetic({ status: 'unavailable', data: null })
  expect(removeMatchingClaudeOAuthFromStores([primary.storage, fallback.storage], deleted)).toBe(false)
  expect(primary.storage.update).not.toHaveBeenCalled()
})

test('confirmed missing backends permit cleanup without creating credentials', () => {
  const absent = synthetic({ status: 'missing', data: null })
  expect(removeMatchingClaudeOAuthFromStores([absent.storage], deleted)).toBe(true)
  expect(absent.storage.update).not.toHaveBeenCalled()
})

test('replacement primary survives while matching stale fallback is cleared', () => {
  const primary = synthetic({ status: 'present', data: { claudeAiOauth: replacement } })
  const fallback = synthetic({ status: 'present', data: { claudeAiOauth: deleted, other: 'keep' } })
  expect(removeMatchingClaudeOAuthFromStores([primary.storage, fallback.storage], deleted)).toBe(true)
  expect(primary.get()?.claudeAiOauth).toEqual(replacement)
  expect(fallback.get()).toEqual({ other: 'keep' })
})
