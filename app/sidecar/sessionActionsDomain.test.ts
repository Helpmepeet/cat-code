/**
 * P4-6b — session-actions domain unit tests. Exercises the domain's fail-closed
 * wrapping + result shaping over an INJECTED fake executor (no real transcript on
 * disk). The engine-op round-trip (saveCustomTitle / renderMessagesToPlainText /
 * createFork) is not re-proven here — the seam is the boundary these tests hold.
 */

import { describe, expect, test } from 'bun:test'
import {
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
