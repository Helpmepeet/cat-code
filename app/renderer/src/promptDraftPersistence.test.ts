import { describe, expect, test } from 'bun:test'
import type { PromptDraftState } from './appModel.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  createPasteState,
  reducePasteAdded,
  createPendingSubmitState,
  reducePendingSubmitHeld,
} from './composerState.js'
import {
  MAX_PERSISTED_PROMPT_DRAFTS,
  MAX_PERSISTED_PROMPT_DRAFT_CHARS,
  PROMPT_DRAFTS_STORAGE_KEY,
  PROMPT_DRAFT_RECOVERY_STORAGE_KEY,
  readOlderPromptDraftsFromStorage,
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

  test('restores collapsed paste content without depending on in-memory paste entries', () => {
    const storage = fakeStorage()
    const sessionId = 'session-a' as SessionId
    const content = 'important context\n'.repeat(100)
    const pasted = reducePasteAdded(createPasteState(), sessionId, content)
    writePromptDraftsToStorage(
      storage,
      draftsOf({ [sessionId]: `Review this:\n${pasted.token}` }),
      pasted.state,
    )
    expect(readPromptDraftsFromStorage(storage)?.[sessionId]).toBe(`Review this:\n${content}`)
  })

  test('recovers held unsent text as a draft alongside newer typing, without restoring a send queue', () => {
    const storage = fakeStorage()
    const sessionId = 'session-a' as SessionId
    const pendingSubmits = reducePendingSubmitHeld(createPendingSubmitState(), sessionId, {
      text: 'waiting for connection', showQueuedRow: false,
    })
    writePromptDraftsToStorage(storage, draftsOf({ [sessionId]: 'newer typing' }), {}, { pendingSubmits })
    expect(readPromptDraftsFromStorage(storage)).toEqual(draftsOf({
      [sessionId]: 'waiting for connection\nnewer typing',
    }))
    writePromptDraftsToStorage(storage, draftsOf({ [sessionId]: 'newer typing' }))
    expect(readPromptDraftsFromStorage(storage)?.[sessionId]).toBe('newer typing')
  })

  test('saves the original unsent draft while browsing sent-message history', () => {
    const storage = fakeStorage()
    const sessionId = 'session-a' as SessionId
    writePromptDraftsToStorage(storage, draftsOf({ [sessionId]: 'previously sent message' }), {}, {
      historyNavigation: { [sessionId]: { index: 0, savedDraft: 'original unsent draft' } },
    })
    expect(readPromptDraftsFromStorage(storage)?.[sessionId]).toBe('original unsent draft')
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

test('overflow reports every unsaved full draft without evicting the existing 32', () => {
  const storage = fakeStorage()
  const first = Object.fromEntries(Array.from({ length: MAX_PERSISTED_PROMPT_DRAFTS }, (_, index) => [`s${index}`, `text ${index}`]))
  writePromptDraftsToStorage(storage, draftsOf(first))
  const outcomes = writePromptDraftsToStorage(storage, draftsOf({ extra: 'full new draft', ...first }))
  expect(outcomes.extra).toEqual({ status: 'unsaved', text: 'full new draft', reason: 'capacity' })
  expect(readPromptDraftsFromStorage(storage)).toEqual(draftsOf(first))
})

test('quota refusal reports stale full text and does not replace the last-good copy', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'old' }))
  const refusing = { getItem: storage.getItem, setItem: () => { throw new Error('quota') } }
  const outcomes = writePromptDraftsToStorage(refusing, draftsOf({ a: 'latest', b: 'never saved' }))
  expect(outcomes.a).toEqual({ status: 'stale', text: 'latest', reason: 'storage' })
  expect(outcomes.b).toEqual({ status: 'unsaved', text: 'never saved', reason: 'storage' })
  expect(readPromptDraftsFromStorage(storage)).toEqual(draftsOf({ a: 'old' }))
})

test('expanded oversized paste and unavailable storage return full actionable text', () => {
  const sessionId = 'paste-session' as SessionId
  const content = 'full context\n'.repeat(2000)
  const pasted = reducePasteAdded(createPasteState(), sessionId, content)
  const outcomes = writePromptDraftsToStorage(null, draftsOf({ [sessionId]: pasted.token }), pasted.state)
  expect(outcomes[sessionId]).toEqual({ status: 'unsaved', text: content, reason: 'length' })
})

test('a later successful save replaces stale health and recovers the latest complete text', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'old' }))
  const refusal = { getItem: storage.getItem, setItem: () => { throw new Error('quota') } }
  expect(writePromptDraftsToStorage(refusal, draftsOf({ a: 'new' })).a!.status).toBe('stale')
  expect(writePromptDraftsToStorage(storage, draftsOf({ a: 'new' })).a!.status).toBe('saved')
  expect(readPromptDraftsFromStorage(storage)).toEqual(draftsOf({ a: 'new' }))
})

test('only a refused replacement marks an older copy for restoration', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'last good', b: 'normal saved draft' }))
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual({})
  const result = writePromptDraftsToStorage(storage, draftsOf({
    a: 'x'.repeat(MAX_PERSISTED_PROMPT_DRAFT_CHARS + 1), b: 'normal saved draft',
  }))
  expect(result.a).toEqual({ status: 'stale', text: 'x'.repeat(20001), reason: 'length' })
  const restored = readOlderPromptDraftsFromStorage(storage)
  expect(restored).toEqual(draftsOf({ a: 'last good' }))
  writePromptDraftsToStorage(storage, readPromptDraftsFromStorage(storage)!, {}, { olderRestoredDrafts: restored })
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual(restored)
  writePromptDraftsToStorage(storage, draftsOf({ a: 'edited draft', b: 'normal saved draft' }))
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual({})
})

test('storage refusal can retain an older-copy marker when metadata writes still work', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'saved' }))
  const refusingDrafts = {
    getItem: storage.getItem,
    setItem: (key: string, value: string) => {
      if (key === PROMPT_DRAFTS_STORAGE_KEY) throw new Error('quota')
      storage.setItem(key, value)
    },
  }
  expect(writePromptDraftsToStorage(refusingDrafts, draftsOf({ a: 'unsaved edit' })).a!.status).toBe('stale')
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual(draftsOf({ a: 'saved' }))
  writePromptDraftsToStorage(storage, draftsOf({}))
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual({})
})

test('recovery metadata never creates a draft or trusts malformed markers', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'saved', b: 'saved too' }))
  writePromptDraftsToStorage(storage, draftsOf({ a: 'x'.repeat(20001), b: 'saved too' }))
  const marker = JSON.parse(storage.getItem(PROMPT_DRAFT_RECOVERY_STORAGE_KEY)!).olderCopies.a
  storage.setItem(PROMPT_DRAFT_RECOVERY_STORAGE_KEY, JSON.stringify({
    version: 1, olderCopies: { a: marker, b: true, missing: marker },
  }))
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual(draftsOf({ a: 'saved' }))
})

test('a successful new draft is not called an older copy if clearing its previous marker fails', () => {
  const storage = fakeStorage()
  writePromptDraftsToStorage(storage, draftsOf({ a: 'saved' }))
  writePromptDraftsToStorage(storage, draftsOf({ a: 'x'.repeat(20001) }))
  const refusingMetadata = {
    getItem: storage.getItem,
    setItem: (key: string, value: string) => {
      if (key === PROMPT_DRAFT_RECOVERY_STORAGE_KEY) throw new Error('quota')
      storage.setItem(key, value)
    },
  }
  expect(writePromptDraftsToStorage(refusingMetadata, draftsOf({ a: 'latest' })).a!.status).toBe('saved')
  expect(readOlderPromptDraftsFromStorage(storage)).toEqual({})
})
