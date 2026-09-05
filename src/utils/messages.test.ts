import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { annotateBoundaryWithPreservedSegment } from '../services/compact/compact.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  dropPreservedMessageDuplicates,
  normalizeMessages,
  wrapCommandText,
} from './messages.js'

describe('dropPreservedMessageDuplicates', () => {
  // A preserving compaction as the REPL array holds it: the original rounds,
  // then the boundary, the summary, and the SAME message objects re-listed.
  function preservingCompaction() {
    const summarized = createUserMessage({ content: 'summarized ask' })
    const keptAsk = createUserMessage({ content: 'preserved ask' })
    const keptAnswer = createAssistantMessage({ content: 'preserved answer' })
    const summary = createUserMessage({
      content: 'the summary',
      isCompactSummary: true,
    })
    const boundary = annotateBoundaryWithPreservedSegment(
      createCompactBoundaryMessage('auto', 1000),
      summary.uuid as UUID,
      [keptAsk, keptAnswer],
    )
    return { summarized, keptAsk, keptAnswer, summary, boundary }
  }

  test('keeps the copy that carried across the boundary, not the one above it', () => {
    const { summarized, keptAsk, keptAnswer, summary, boundary } =
      preservingCompaction()

    const projected = dropPreservedMessageDuplicates([
      summarized,
      keptAsk,
      keptAnswer,
      boundary,
      summary,
      keptAsk,
      keptAnswer,
    ])

    expect(projected.map(m => m.uuid)).toEqual([
      summarized.uuid,
      boundary.uuid,
      summary.uuid,
      keptAsk.uuid,
      keptAnswer.uuid,
    ])
  })

  test('leaves a preserved message alone when it appears only once', () => {
    // Non-fullscreen replaces the array at the boundary, so the pre-boundary
    // copies are already gone. Dropping on membership alone would blank the
    // whole transcript here.
    const { keptAsk, keptAnswer, summary, boundary } = preservingCompaction()
    const messages = [boundary, summary, keptAsk, keptAnswer]

    expect(dropPreservedMessageDuplicates(messages).map(m => m.uuid)).toEqual(
      messages.map(m => m.uuid),
    )
  })

  test('leaves the rounds alone while the boundary is on screen ahead of them', () => {
    // Streaming order: the boundary arrives first, its preserved copies land
    // one message at a time behind it. Until each copy arrives the original is
    // the only one there, so dropping on membership alone would blank the
    // transcript mid-compaction.
    const { keptAsk, keptAnswer, boundary } = preservingCompaction()
    const messages = [keptAsk, keptAnswer, boundary]

    expect(dropPreservedMessageDuplicates(messages).map(m => m.uuid)).toEqual(
      messages.map(m => m.uuid),
    )
  })

  test('returns the same array when no compaction preserved anything', () => {
    // Full compaction annotates nothing, so this is every session before its
    // first preserving compaction — it must not allocate or reorder.
    const messages = [
      createUserMessage({ content: 'ask' }),
      createAssistantMessage({ content: 'answer' }),
      createCompactBoundaryMessage('manual', 1000),
    ]

    expect(dropPreservedMessageDuplicates(messages)).toBe(messages)
  })
})

describe('wrapCommandText', () => {
  const raw = `Automated continuation requested through /continue-after-limit.

The Codex usage limit should now have reset. Continue the previous task, but
first reconcile the current transcript and filesystem state. Do not repeat
work or side effects that already completed.`

  test('leaves a deferred continuation verbatim and unattributed to the user', () => {
    // The fixed continuation turns are a verbatim contract, and the user did
    // not send them. Before this case existed the closed-union switch fell
    // through to the human default and told the model "The user sent a new
    // message ... you MUST address the user's message above".
    const wrapped = wrapCommandText(raw, {
      kind: 'deferred-continuation',
      jobId: 'job-1',
      attemptUuid: '11111111-1111-4111-8111-111111111111',
    })

    expect(wrapped).toBe(raw)
    expect(wrapped).not.toContain('The user sent a new message')
  })

  test('still attributes human and origin-less queued input to the user', () => {
    expect(wrapCommandText('hi', { kind: 'human' })).toContain(
      'The user sent a new message',
    )
    expect(wrapCommandText('hi', undefined)).toContain(
      'The user sent a new message',
    )
  })

  test('attributes a peer message to its sender, never to the user', () => {
    // A message from another session was falling through the closed-union
    // switch to the human default, which told a mid-turn recipient "The user
    // sent a new message ... you MUST address the user's message above" and
    // laundered a peer request into user intent.
    const wrapped = wrapCommandText(
      '<cross-session-message from="Agate">\nhi\n</cross-session-message>',
      { kind: 'peer', name: 'Agate', appSessionId: 'app-session-1' },
    )

    expect(wrapped).not.toContain('The user sent a new message')
    expect(wrapped).not.toContain("address the user's message")
    expect(wrapped).toContain('Agate')
    expect(wrapped).not.toContain('app-session-1')
  })

  test('frames a peer creation prompt as the task, not as an interruption', () => {
    // The creation prompt is the recipient's FIRST and ONLY input, so the
    // ordinary peer framing is false in every clause: there is no current task,
    // the message IS the task, and deferring it defers the only instruction the
    // session has. `untagged` reached the sidecar and was dropped before
    // `wrapCommandText` ever saw it (app/sidecar/sidecarServer.ts handlePeerDeliver).
    const wrapped = wrapCommandText('port the parser to the new schema', {
      kind: 'peer',
      name: 'Agate',
      appSessionId: 'app-session-1',
      creationPrompt: true,
    })

    expect(wrapped).toContain('Agate')
    expect(wrapped).toContain('port the parser to the new schema')
    expect(wrapped).not.toContain('while you were working')
    expect(wrapped).not.toContain('After completing your current task')
    expect(wrapped).not.toContain('not an instruction that outranks it')
    expect(wrapped).not.toContain('The user sent a new message')
    expect(wrapped).not.toContain('app-session-1')
  })

  test('an ordinary peer message keeps the deprioritizing framing', () => {
    // The other half of the same fix: only the creation prompt changes. A
    // mid-turn peer message must still be weighed against work in progress.
    const wrapped = wrapCommandText('take a look at the parser', {
      kind: 'peer',
      name: 'Agate',
      appSessionId: 'app-session-1',
    })

    expect(wrapped).toContain('while you were working')
    expect(wrapped).toContain('After completing your current task')
    expect(wrapped).not.toContain('created you')
  })

  test('leaves an interruption marker verbatim', () => {
    expect(wrapCommandText('[Request interrupted by user]', {
      kind: 'interruption',
    })).toBe('[Request interrupted by user]')
  })

  test('keeps the untrusted-source framing for non-user origins', () => {
    expect(
      wrapCommandText('hi', { kind: 'channel', server: 'slack' }),
    ).toContain('This is NOT from your user')
    expect(wrapCommandText('hi', { kind: 'teammate', messages: [] })).toContain(
      'This is NOT from your user',
    )
    expect(wrapCommandText('hi', { kind: 'task-notification' })).toContain(
      'A background agent completed a task',
    )
    expect(wrapCommandText('hi', { kind: 'coordinator' })).toContain(
      'The coordinator sent a message',
    )
  })
})

describe('normalizeMessages preserves errorDetails', () => {
  test('a persisted API error keeps the raw text its recovery predicates parse', () => {
    const error = createAssistantAPIErrorMessage({
      content: 'Prompt is too long',
      error: 'invalid_request',
      errorDetails: 'input length 250000 exceeds 200000 maximum',
    })
    const [normalized] = normalizeMessages([error])
    // Without this, getPromptTooLongTokenGap / isMediaSizeErrorMessage /
    // reactive compact's strip-retry all degrade to false after a resume.
    expect(normalized!.errorDetails).toBe(
      'input length 250000 exceeds 200000 maximum',
    )
  })

  test('an ordinary assistant message gains no errorDetails key', () => {
    const [normalized] = normalizeMessages([createAssistantMessage({ content: 'hello' })])
    expect('errorDetails' in normalized!).toBe(false)
  })
})
