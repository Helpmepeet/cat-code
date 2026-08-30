/**
 * P4-6b — session-actions domain unit tests. Exercises the domain's fail-closed
 * wrapping + result shaping over an INJECTED fake executor (no real transcript on
 * disk). The engine-op round-trip (saveCustomTitle / renderMessagesToPlainText /
 * createFork) is not re-proven here — the seam is the boundary these tests hold.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import type { LogOption, SerializedMessage } from '../../src/types/logs.js'
import type { Message } from '../../src/types/message.js'
import type { InterruptedTurnRecordV1 } from '../../src/utils/interruptedTurn.js'
import {
  createRealSessionActionsExecutor,
  createSidecarSessionActionsDomain,
  type SessionActionsExecutor,
} from './sessionActionsDomain.js'

function fakeExecutor(
  overrides: Partial<SessionActionsExecutor> = {},
): { executor: SessionActionsExecutor; calls: string[] } {
  const calls: string[] = []
  const executor: SessionActionsExecutor = {
    async rename(title) {
      calls.push(`rename:${title}`)
    },
    async export() {
      calls.push('export')
      return 'RENDERED TRANSCRIPT'
    },
    async branch() {
      calls.push('branch')
      return {
        engineSessionId: 'fork-engine-id',
        title: 'First prompt (Branch)',
        forkPath: '/tmp/fork.jsonl',
      }
    },
    selectUserMessage(userMessageId) {
      calls.push(`selectUserMessage:${userMessageId}`)
      return {
        type: 'user',
        uuid: userMessageId,
        timestamp: '2026-08-24T00:00:00.000Z',
        message: { role: 'user', content: 'selected prompt' },
        imagePasteIds: [4],
      }
    },
    async editFromMessage(userMessageId) {
      calls.push(`editFromMessage:${userMessageId}`)
      return {
        prompt: {
          type: 'user',
          uuid: userMessageId,
          timestamp: '2026-08-24T00:00:00.000Z',
          message: { role: 'user', content: 'selected prompt' },
          imagePasteIds: [4],
        },
        retainedMessages: [],
      }
    },
    async branchFromMessage(userMessageId) {
      calls.push(`branchFromMessage:${userMessageId}`)
      return {
        engineSessionId: 'targeted-fork-engine-id',
        title: 'First prompt (Branch)',
        prompt: {
          type: 'user',
          uuid: userMessageId,
          timestamp: '2026-08-24T00:00:00.000Z',
          message: { role: 'user', content: 'selected prompt' },
          imagePasteIds: [4],
        },
      }
    },
    async tag(tag) {
      calls.push(`tag:${tag}`)
    },
    ...overrides,
  }
  return { executor, calls }
}

describe('sessionActionsDomain — rename', () => {
  test('a non-empty title is trimmed, forwarded to the executor, and acked ok', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('  My Session  ')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('My Session')
    // The executor sees the TRIMMED title.
    expect(calls).toEqual(['rename:My Session'])
  })

  test('an empty / whitespace-only title fails closed BEFORE the executor runs', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('   ')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Title cannot be empty.')
    expect(calls).toEqual([])
  })

  test('an executor throw degrades to ok:false, never a rejection', async () => {
    const { executor } = fakeExecutor({
      rename: async () => {
        throw new Error('disk full')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('x')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('disk full')
  })
})

describe('sessionActionsDomain — export', () => {
  test('carries the engine-rendered text on a successful result', async () => {
    const { executor } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(true)
    expect(result.exportText).toBe('RENDERED TRANSCRIPT')
  })

  test('an executor throw degrades to ok:false with no exportText', async () => {
    const { executor } = fakeExecutor({
      export: async () => {
        throw new Error('no conversation')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(false)
    expect(result.exportText).toBeUndefined()
    expect(result.message).toContain('no conversation')
  })

  // A transcript that cannot be read is NOT an empty transcript. The read
  // (`getLastSessionLog`, `src/utils/sessionStorage.ts:5219`) answers null when
  // it resolves no conversation at all, and the export op forwards that null
  // rather than rendering it as text. Reporting success with an empty pane is
  // the failure this pins.
  test('an unloadable transcript fails instead of reporting an empty export', async () => {
    const { executor } = fakeExecutor({
      export: async () => null,
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(false)
    expect(result.exportText).toBeUndefined()
    expect(result.message).toBe('This session has nothing saved to export.')
  })

  // The other half of the same call: a transcript that DID load but rendered to
  // nothing is a real, successful export of an empty conversation.
  test('a transcript that loaded but rendered empty is still a successful export', async () => {
    const { executor } = fakeExecutor({
      export: async () => '',
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(true)
    expect(result.exportText).toBe('')
  })
})

describe('sessionActionsDomain — message-targeted mutations', () => {
  test('edit returns the complete selected prompt and retained replay seed', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.editFromMessage('12345678-1234-4234-8234')

    expect(result).toMatchObject({
      ok: true,
      selectedPrompt: { content: 'selected prompt' },
      retainedMessages: [],
    })
    expect(calls).toEqual(['editFromMessage:12345678-1234-4234-8234'])
  })

  test('targeted branch returns the engine id, title, and complete source prompt', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.branchFromMessage('12345678-1234-4234-8234')

    expect(result).toMatchObject({
      ok: true,
      branchEngineSessionId: 'targeted-fork-engine-id',
      branchTitle: 'First prompt (Branch)',
      selectedPrompt: { content: 'selected prompt' },
    })
    expect(calls).toEqual(['branchFromMessage:12345678-1234-4234-8234'])
  })
})

describe('sessionActionsDomain — tag (P4-29)', () => {
  test('a tag is trimmed, forwarded to the executor, and acked ok', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.tag('  infra  ')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Tagged #infra.')
    expect(calls).toEqual(['tag:infra'])
  })

  // Unlike rename, an empty value is MEANINGFUL: it is the engine's own remove
  // form (`src/commands/tag/tag.tsx:141`), so it must reach the executor.
  test('an empty / whitespace tag is the REMOVE form and still reaches the engine', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.tag('   ')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Tag removed.')
    expect(calls).toEqual(['tag:'])
  })

  test('an executor throw degrades to ok:false, never a rejected promise', async () => {
    const { executor } = fakeExecutor({
      tag: async () => {
        throw new Error('transcript is read-only')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.tag('infra')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('transcript is read-only')
  })

  // HackerOne #3086545 — hidden Unicode characters (bidi overrides, zero-width
  // marks) must not survive into the catalog's `tag` field verbatim, the same
  // as `/tag` itself does via `recursivelySanitizeUnicode`
  // (`src/commands/tag/tag.tsx:82`, `src/utils/sanitization.ts`). Plain
  // `.trim()` alone does not touch any of these — these tags all sit inside
  // the string, not at its edges.
  test('a bidi-override character is stripped, not merely trimmed around', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    // U+202E RIGHT-TO-LEFT OVERRIDE — the RTL-injection example from the bug
    // report (`"prod‮gnimaerts"` renders as an RTL override live).
    const result = await domain.tag('prod‮gnimaerts')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Tagged #prodgnimaerts.')
    expect(calls).toEqual(['tag:prodgnimaerts'])
  })

  test('a zero-width character is stripped so two visually-identical tags cannot diverge into separate filter tabs', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    // U+200B ZERO WIDTH SPACE embedded in an otherwise-plain tag.
    const result = await domain.tag('in​fra')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Tagged #infra.')
    expect(calls).toEqual(['tag:infra'])
  })

  test('sanitization runs before trim, matching the engine order recursivelySanitizeUnicode(tag).trim()', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.tag('  prod‮gnimaerts  ')

    expect(result.ok).toBe(true)
    expect(calls).toEqual(['tag:prodgnimaerts'])
  })

  test('a tag made only of hidden characters sanitizes to empty and stays the REMOVE form', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    // Zero-width space / non-joiner / joiner — nothing renderable survives.
    const result = await domain.tag('​‌‍')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Tag removed.')
    expect(calls).toEqual(['tag:'])
  })
})

/**
 * Read-only session actions must not resume. `loadConversationForResume` is not
 * a reader: it runs the user's own SessionStart hooks and appends their output
 * to the messages, and it consumes the interrupted-turn record a later REAL
 * resume needs (`src/utils/conversationRecovery.ts:705-726`). Export and
 * targeted branch only need to READ, so they take the loader half of that
 * function's own string-source branch and none of the tail.
 *
 * These tests exercise the REAL executor with the two side-effecting engine
 * modules replaced by in-memory fakes — no session file, no vault, no user hook
 * is ever reached. The assertions are the effects, not the call shape: the hook
 * runner must never fire and the interrupted-turn record must still be there
 * afterwards, while the export still renders the fixture transcript.
 */

const FIXTURE_SESSION_ID = '11111111-2222-4333-8444-555555555555'

let sessionStartHookRuns = 0
let storedInterruptedTurn: InterruptedTurnRecordV1 | null = null
let storedLog: LogOption | null = null

const realSessionStart = await import('../../src/utils/sessionStart.js')
mock.module('../../src/utils/sessionStart.js', () => ({
  ...realSessionStart,
  processSessionStartHooks: async () => {
    sessionStartHookRuns += 1
    return []
  },
}))

const realInterruptedTurn = await import('../../src/utils/interruptedTurn.js')
mock.module('../../src/utils/interruptedTurn.js', () => ({
  ...realInterruptedTurn,
  readInterruptedTurnRecord: async () => storedInterruptedTurn,
  takeInterruptedTurnRecord: async () => {
    const record = storedInterruptedTurn
    storedInterruptedTurn = null
    return record
  },
  consumeInterruptedTurnRecord: async () => {
    storedInterruptedTurn = null
  },
}))

const realSessionStorage = await import('../../src/utils/sessionStorage.js')
mock.module('../../src/utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  getLastSessionLog: async () => storedLog,
}))

// The plain-text renderer mounts the terminal component tree, which never
// settles without a TTY, so it is replaced by a recorder. What it RECEIVES is
// the interesting half here anyway: those are the messages the read produced.
let renderedMessages: Message[] | null = null
const realExportRenderer = await import('../../src/utils/exportRenderer.js')
mock.module('../../src/utils/exportRenderer.js', () => ({
  ...realExportRenderer,
  renderMessagesToPlainText: async (messages: Message[]) => {
    renderedMessages = messages
    return 'RENDERED'
  },
}))

function fixtureLog(): LogOption {
  const message: SerializedMessage = {
    type: 'user',
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: '2026-08-30T00:00:00.000Z',
    message: { role: 'user', content: 'fixture transcript line' },
    cwd: '/tmp/fixture-not-a-real-session',
    userType: 'external',
    sessionId: FIXTURE_SESSION_ID,
    version: '0.0.0',
  }
  return {
    date: '2026-08-30',
    messages: [message],
    value: 0,
    created: new Date('2026-08-30T00:00:00.000Z'),
    modified: new Date('2026-08-30T00:00:00.000Z'),
    firstPrompt: 'fixture transcript line',
    messageCount: 1,
    isSidechain: false,
    customTitle: '  Fixture conversation  ',
  }
}

function fixtureInterruptedTurn(): InterruptedTurnRecordV1 {
  return {
    version: 1,
    sessionId: FIXTURE_SESSION_ID,
    leafUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    partialOutput: 'half a sentence before the interruption',
    partialOutputTruncated: false,
    reason: 'user_abort',
    capturedAt: 0,
  }
}

/** A controller stub for the targeted-branch path only; export never touches it. */
function forkOnlyController(
  seen: { customTitle?: string },
): AppSessionController {
  return {
    async forkBeforeUserMessage(targetUuid: string, customTitle?: string) {
      seen.customTitle = customTitle
      return {
        sessionId: '99999999-8888-4777-8666-555555555555',
        title: 'Fixture conversation',
        forkPath: '/tmp/fixture-not-a-real-session/fork.jsonl',
        serializedMessages: [],
        contentReplacementRecords: [],
        sourcePrompt: {
          type: 'user',
          uuid: targetUuid,
          timestamp: '2026-08-30T00:00:00.000Z',
          message: { role: 'user', content: 'fixture transcript line' },
        },
      }
    },
  } as unknown as AppSessionController
}

describe('sessionActionsDomain — read-only actions never resume', () => {
  beforeEach(() => {
    sessionStartHookRuns = 0
    storedInterruptedTurn = fixtureInterruptedTurn()
    storedLog = fixtureLog()
    renderedMessages = null
  })

  test('export reads the transcript without running SessionStart hooks or consuming the interrupted turn', async () => {
    const executor = createRealSessionActionsExecutor({
      tools: [],
      controller: forkOnlyController({}),
    })

    const exported = await executor.export()

    // Not vacuous: the transcript really was read, and its content reached the
    // renderer.
    expect(exported).toBe('RENDERED')
    expect(
      (renderedMessages ?? []).some(
        entry =>
          entry.type === 'user' &&
          entry.message.content === 'fixture transcript line',
      ),
    ).toBe(true)
    // A later real resume still has its recovery record.
    expect(storedInterruptedTurn).toEqual(fixtureInterruptedTurn())
    // The user's own hooks are arbitrary shell, and their output used to be
    // appended to the very messages this export renders.
    expect(sessionStartHookRuns).toBe(0)
  })

  test('a transcript that cannot be resolved is still null, not an empty success', async () => {
    storedLog = null
    const executor = createRealSessionActionsExecutor({
      tools: [],
      controller: forkOnlyController({}),
    })

    expect(await executor.export()).toBeNull()
    expect(sessionStartHookRuns).toBe(0)
  })

  test('targeted branch still carries the source custom title, with no hook run and the interrupted turn intact', async () => {
    const seen: { customTitle?: string } = {}
    const executor = createRealSessionActionsExecutor({
      tools: [],
      controller: forkOnlyController(seen),
    })

    const result = await executor.branchFromMessage(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )

    expect(result.title).toBe('Fixture conversation')
    // Trimmed, exactly as before — the title is the only thing this path read.
    expect(seen.customTitle).toBe('Fixture conversation')
    expect(storedInterruptedTurn).toEqual(fixtureInterruptedTurn())
    expect(sessionStartHookRuns).toBe(0)
  })
})
