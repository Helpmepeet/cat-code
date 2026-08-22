import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { LogOption } from '../types/logs.js'
import type { AssistantMessage, Message, UserMessage } from '../types/message.js'
import {
  adoptInterruptedTurnForResume,
  loadConversationForResume,
} from './conversationRecovery.js'
import {
  captureInterruptedTurn,
  getInterruptedTurnDir,
  INTERRUPTED_TURN_MAX_AGE_MS,
  MAX_PARTIAL_OUTPUT_BYTES,
} from './interruptedTurn.js'
import {
  createAssistantMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from './messages.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

async function withStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp('/tmp/cat-code-interrupted-turn-')
  cleanup.push(root)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
}

const PARTIAL_TEXT =
  'I read src/query.ts and found the abort branch at line 1094.'

test('interruption marker records durable non-human provenance', () => {
  expect(createUserInterruptionMessage({ toolUse: true }).origin).toEqual({
    kind: 'interruption',
  })
})

/**
 * The transcript an interrupted tool trajectory leaves behind: prompt,
 * assistant text plus tool_use, then the interruption marker.
 *
 * `resolvedToolResult: false` is the lossy shape this feature exists for. The
 * tool_result never reached the transcript, so `filterUnresolvedToolUses` drops
 * the whole assistant message on resume and takes its text with it. Nothing in
 * the resumed conversation holds that text any more.
 */
function interruptedTurnTranscript(
  sessionId: string,
  options?: { resolvedToolResult?: boolean },
): {
  log: LogOption
  assistantMessages: AssistantMessage[]
  messages: Message[]
} {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`
  const prompt = createUserMessage({ content: 'find the abort branch' })
  const assistant = createAssistantMessage({
    content: [
      { type: 'text', text: PARTIAL_TEXT, citations: null },
      { type: 'tool_use', id: toolUseId, name: 'Read', input: {} },
    ],
  }) as AssistantMessage
  const toolResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: 'Interrupted by user',
        is_error: true,
        tool_use_id: toolUseId,
      },
    ],
    toolUseResult: 'Interrupted by user',
  })
  const interruption = createUserInterruptionMessage({ toolUse: true })
  const messages: Message[] = [
    prompt,
    assistant,
    ...(options?.resolvedToolResult ? [toolResult] : []),
    interruption,
  ]
  for (const message of messages) {
    ;(message as { sessionId?: string }).sessionId = sessionId
  }
  return {
    log: logOptionFor(sessionId, messages),
    assistantMessages: [assistant],
    messages,
  }
}

function logOptionFor(sessionId: string, messages: Message[]): LogOption {
  return {
    date: new Date().toISOString(),
    messages: messages as LogOption['messages'],
    value: 0,
    created: new Date(),
    modified: new Date(),
    firstPrompt: 'find the abort branch',
    messageCount: messages.length,
    isSidechain: false,
    sessionId,
  }
}

function continuationText(state: {
  kind: string
  message?: UserMessage
}): string {
  if (state.kind !== 'interrupted_prompt') {
    throw new Error(`expected interrupted_prompt, got ${state.kind}`)
  }
  const content = state.message!.message.content
  return typeof content === 'string'
    ? content
    : content
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('')
}

describe('structured interrupted-turn continuation', () => {
  // Success direction, on the shape where the loss is real: the recovery filters
  // delete the assistant message that held the output, so the resumed history no
  // longer contains it and only the durable record can put it back.
  test('carries the exact partial output into the resumed continuation', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { log, assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)

      const record = captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })
      expect(record?.partialOutput).toBe(PARTIAL_TEXT)
      expect(record?.leafUuid).toBe(String(messages.at(-1)!.uuid))

      const resumed = await loadConversationForResume(log, undefined)
      expect(resumed?.interruptedTurn).toEqual({
        status: 'apply',
        record: record!,
      })

      // The filters really did remove it from the conversation history.
      expect(
        JSON.stringify(
          resumed!.messages.filter(message => message.type === 'assistant'),
        ),
      ).not.toContain(PARTIAL_TEXT)

      const continuation = continuationText(resumed!.turnInterruptionState)
      expect(continuation).toContain(PARTIAL_TEXT)
      expect(continuation).toContain('the user interrupted it')
      expect(continuation).not.toContain('Continue from where you left off.')

      // Consumed: a second resume of the same session gets the generic recovery
      // back rather than replaying a spent record.
      const again = await loadConversationForResume(
        logOptionFor(sessionId, messages),
        undefined,
      )
      expect(again?.interruptedTurn).toBeNull()
    })
  })

  test('keeps the record when a loaded resume is rejected before adoption', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { log, assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })

      const rejected = await loadConversationForResume(log, undefined, {
        interruptedTurn: 'defer',
      })
      expect(rejected?.interruptedTurn?.status).toBe('apply')

      const accepted = await loadConversationForResume(
        logOptionFor(sessionId, messages),
        undefined,
        { interruptedTurn: 'defer' },
      )
      expect(accepted?.interruptedTurn?.status).toBe('apply')
      await adoptInterruptedTurnForResume(accepted!)

      const spent = await loadConversationForResume(
        logOptionFor(sessionId, messages),
        undefined,
      )
      expect(spent?.interruptedTurn).toBeNull()
    })
  })

  test('does not apply or consume the source record when forking', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { log, assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })

      const forked = await loadConversationForResume(log, undefined, {
        interruptedTurn: 'ignore',
      })
      expect(forked?.interruptedTurn).toBeNull()
      expect(continuationText(forked!.turnInterruptionState)).not.toContain(
        PARTIAL_TEXT,
      )

      const source = await loadConversationForResume(
        logOptionFor(sessionId, messages),
        undefined,
      )
      expect(source?.interruptedTurn?.status).toBe('apply')
    })
  })

  // The ordinary abort path does emit the tool_result, so the assistant survives
  // the filters. Today that transcript resumes by re-sending the literal
  // interruption marker as the next prompt; the record replaces it.
  test('replaces the interruption marker as the continuation prompt', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { log, assistantMessages, messages } = interruptedTurnTranscript(
        sessionId,
        { resolvedToolResult: true },
      )
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })

      const resumed = await loadConversationForResume(log, undefined)
      expect(resumed?.interruptedTurn?.status).toBe('apply')
      const continuation = continuationText(resumed!.turnInterruptionState)
      expect(continuation).toContain(PARTIAL_TEXT)
      expect(continuation).not.toBe('[Request interrupted by user]')
    })
  })

  // Failure direction, and the reason the record is bound to a leaf at all: the
  // conversation moved on after the interruption. Grafting the partial text onto
  // this branch would attribute output the model never produced here.
  test('discards the record when the resumed leaf moved on', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })

      const nextPrompt = createUserMessage({ content: 'actually, do this instead' })
      ;(nextPrompt as { sessionId?: string }).sessionId = sessionId
      const divergent = [...messages, nextPrompt]

      const resumed = await loadConversationForResume(
        logOptionFor(sessionId, divergent),
        undefined,
      )
      expect(resumed?.interruptedTurn).toEqual({
        status: 'discard',
        reason: 'leaf_mismatch',
      })
      const continuation = continuationText(resumed!.turnInterruptionState)
      expect(continuation).not.toContain(PARTIAL_TEXT)
      expect(await readdir(getInterruptedTurnDir())).toEqual([])
    })
  })

  // A compaction that preserves the recent suffix verbatim keeps the captured
  // leaf as the chain leaf while introducing a new boundary. Matching on the
  // boundary instead of the leaf would break exactly this case.
  test('still applies when the leaf sits inside a preserved suffix', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'user_abort',
      })

      // Post-compaction shape: boundary becomes the new root, the summary
      // follows, then the preserved suffix, which still ends at the same leaf.
      const summary = createUserMessage({
        content: 'preserved compact summary',
        isCompactSummary: true,
      })
      ;(summary as { sessionId?: string }).sessionId = sessionId
      const compacted = [summary, ...messages]

      const resumed = await loadConversationForResume(
        logOptionFor(sessionId, compacted),
        undefined,
      )
      expect(resumed?.interruptedTurn?.status).toBe('apply')
      expect(continuationText(resumed!.turnInterruptionState)).toContain(
        PARTIAL_TEXT,
      )
    })
  })

  test('discards a record older than the retention window', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const { log, assistantMessages, messages } =
        interruptedTurnTranscript(sessionId)
      captureInterruptedTurn({
        sessionId,
        messages,
        assistantMessages,
        reason: 'aborted',
        now: Date.now() - INTERRUPTED_TURN_MAX_AGE_MS - 60_000,
      })

      const resumed = await loadConversationForResume(log, undefined)
      expect(resumed?.interruptedTurn).toEqual({
        status: 'discard',
        reason: 'expired',
      })
    })
  })

  test('keeps the tail when the output exceeds the size bound', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const tail = 'THE-END-OF-THE-OUTPUT'
      const long = `${'x'.repeat(MAX_PARTIAL_OUTPUT_BYTES)}${tail}`
      const assistant = createAssistantMessage({
        content: long,
      }) as AssistantMessage
      const interruption = createUserInterruptionMessage({ toolUse: false })
      const record = captureInterruptedTurn({
        sessionId,
        messages: [assistant, interruption],
        assistantMessages: [assistant],
        reason: 'aborted',
      })
      expect(record?.partialOutputTruncated).toBe(true)
      expect(record?.partialOutput.endsWith(tail)).toBe(true)
      expect(Buffer.byteLength(record!.partialOutput, 'utf8')).toBeLessThanOrEqual(
        MAX_PARTIAL_OUTPUT_BYTES,
      )
    })
  })

  test('preserves leading indentation and trailing whitespace exactly', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const exact = '  if (ready) {\n    run()\n  }\n\n'
      const assistant = createAssistantMessage({
        content: exact,
      }) as AssistantMessage
      const interruption = createUserInterruptionMessage({ toolUse: false })
      const record = captureInterruptedTurn({
        sessionId,
        messages: [assistant, interruption],
        assistantMessages: [assistant],
        reason: 'aborted',
      })

      expect(record?.partialOutput).toBe(exact)
    })
  })

  test('writes nothing when the turn produced no output', async () => {
    await withStore(async () => {
      const sessionId = randomUUID()
      const interruption = createUserInterruptionMessage({ toolUse: false })
      expect(
        captureInterruptedTurn({
          sessionId,
          messages: [createUserMessage({ content: 'hi' }), interruption],
          assistantMessages: [],
          reason: 'user_abort',
        }),
      ).toBeNull()
      await expect(readdir(getInterruptedTurnDir())).rejects.toThrow()
    })
  })
})
