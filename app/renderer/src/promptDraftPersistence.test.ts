import { describe, expect, test } from 'bun:test'
import type { PromptDraftState } from './appModel.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  MAX_PERSISTED_PROMPT_DRAFTS,
  MAX_PERSISTED_PROMPT_DRAFT_CHARS,
  PROMPT_DRAFTS_STORAGE_KEY,
  readPromptDraftsFromStorage,
  writePromptDraftsToStorage,
} from './promptDraftPersistence.js'
import { memoryStorage as fakeStorage } from './viewPreferenceStorageFixture.js'

const draftsOf = (entries: Record<string, string>): PromptDraftState =>
  entries as PromptDraftState

describe('prompt draft persistence', () => {
  // The regression: promptDrafts was plain component state, so any renderer
  // reload (including the crash-recovery reload main performs) emptied every
  // composer. A round trip through storage is the whole feature.
  test('restores the draft that was written, keyed by session', () => {
    const storage = fakeStorage()
    writePromptDraftsToStorage(
      storage,
      draftsOf({ 'session-a': 'half a thought', 'session-b': 'another' }),
    )

    expect(readPromptDraftsFromStorage(storage)).toEqual(
      draftsOf({ 'session-a': 'half a thought', 'session-b': 'another' }),
    )
  })

  test('reads nothing when no draft was ever written', () => {
    expect(readPromptDraftsFromStorage(fakeStorage())).toBeNull()
  })

  test('degrades to no drafts on a corrupt or foreign stored value', () => {
    expect(
      readPromptDraftsFromStorage(
        fakeStorage({ [PROMPT_DRAFTS_STORAGE_KEY]: 'not json' }),
      ),
    ).toBeNull()
    expect(
      readPromptDraftsFromStorage(
        fakeStorage({
          [PROMPT_DRAFTS_STORAGE_KEY]: JSON.stringify({ version: 2, drafts: {} }),
        }),
      ),
    ).toBeNull()
  })

  test('drops non-string and blank draft values found in storage', () => {
    const storage = fakeStorage({
      [PROMPT_DRAFTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        drafts: { good: 'kept', empty: '', numeric: 12, nested: { a: 1 } },
      }),
    })

    expect(readPromptDraftsFromStorage(storage)).toEqual(
      draftsOf({ good: 'kept' }),
    )
  })

  // An unreadable store is the private-window / thumbnail-capture case: the
  // accessor itself throws. Neither side may propagate that.
  test('survives a storage that throws on read and on write', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }

    expect(readPromptDraftsFromStorage(hostile)).toBeNull()
    expect(() =>
      writePromptDraftsToStorage(hostile, draftsOf({ a: 'text' })),
    ).not.toThrow()
  })

  test('does nothing at all when there is no storage', () => {
    expect(readPromptDraftsFromStorage(null)).toBeNull()
    expect(() =>
      writePromptDraftsToStorage(null, draftsOf({ a: 'text' })),
    ).not.toThrow()
  })

  test('caps the number of persisted drafts', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_PERSISTED_PROMPT_DRAFTS + 10; i++) {
      many[`session-${i}`] = `draft ${i}`
    }
    const storage = fakeStorage()
    writePromptDraftsToStorage(storage, draftsOf(many))

    const restored = readPromptDraftsFromStorage(storage)
    expect(Object.keys(restored ?? {})).toHaveLength(
      MAX_PERSISTED_PROMPT_DRAFTS,
    )
    expect((restored ?? {})['session-0' as SessionId]).toBe('draft 0')
  })

  // Truncating would hand back a prompt the user cannot tell is incomplete.
  test('drops an oversized draft rather than truncating it', () => {
    const storage = fakeStorage()
    writePromptDraftsToStorage(
      storage,
      draftsOf({
        huge: 'x'.repeat(MAX_PERSISTED_PROMPT_DRAFT_CHARS + 1),
        small: 'kept',
      }),
    )

    expect(readPromptDraftsFromStorage(storage)).toEqual(
      draftsOf({ small: 'kept' }),
    )
  })

  test('an emptied draft set clears what was stored before', () => {
    const storage = fakeStorage()
    writePromptDraftsToStorage(storage, draftsOf({ a: 'typed' }))
    writePromptDraftsToStorage(storage, draftsOf({}))

    expect(readPromptDraftsFromStorage(storage)).toEqual(draftsOf({}))
  })
})
