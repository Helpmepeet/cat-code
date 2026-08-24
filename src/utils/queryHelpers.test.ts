import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from './messages.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import type { Message } from '../types/message.js'
import { isCompleteUnboundedRead } from './fileStateCache.js'
import {
  extractReadFilesFromMessages,
  normalizeMessage,
} from './queryHelpers.js'

describe('normalizeMessage internal no-response handling', () => {
  test('does not emit the silent API fallback to live SDK consumers', () => {
    const internal = createAssistantAPIErrorMessage({
      content: NO_RESPONSE_REQUESTED,
    })

    expect([...normalizeMessage(internal)]).toEqual([])
  })

  test('still emits genuine assistant-authored text with the same words', () => {
    const genuine = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })

    expect(JSON.stringify([...normalizeMessage(genuine)])).toContain(
      NO_RESPONSE_REQUESTED,
    )
  })

  test('emits the API-error classification on the SDK assistant frame', () => {
    const apiError = createAssistantAPIErrorMessage({
      content: 'The request could not be completed.',
      error: 'authentication_failed',
    })

    expect([...normalizeMessage(apiError)]).toMatchObject([
      {
        type: 'assistant',
        error: 'authentication_failed',
      },
    ])
  })

  test('preserves the engine-minted code when display text resembles an auth error', () => {
    const apiError = createAssistantAPIErrorMessage({
      content: 'OAuth access token has been revoked. Please run /login.',
      error: 'unknown',
    })

    expect([...normalizeMessage(apiError)]).toMatchObject([
      {
        type: 'assistant',
        error: 'unknown',
      },
    ])
  })

  test('carries durable interruption provenance and cancelled tool status', () => {
    const message = createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: 'Interrupted by user',
          is_error: true,
          tool_use_id: 'toolu-stopped',
        },
      ],
      toolResultStatus: 'cancelled',
      origin: { kind: 'interruption' },
    })

    expect([...normalizeMessage(message)]).toMatchObject([
      {
        type: 'user',
        origin: { kind: 'interruption' },
        tool_result_status: 'cancelled',
      },
    ])
  })

  test('carries the engine-minted subagent name on every nested full frame', () => {
    const agentProgress = (nested: Message): Message => ({
      type: 'progress',
      uuid: '00000000-0000-4000-8000-000000000001',
      parentToolUseID: 'toolu_parent',
      data: {
        type: 'agent_progress',
        message: nested,
        prompt: 'inspect the seam',
        agentId: 'agent-1',
        agentName: ' @Ada ',
      },
    })

    const assistant = [...normalizeMessage(agentProgress(createAssistantMessage({ content: 'Working.' })))]
    const user = [...normalizeMessage(agentProgress(createUserMessage({ content: 'Initial task.' })))]
    expect(assistant[0]).toMatchObject({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      agent_name: 'Ada',
    })
    expect(user[0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: 'toolu_parent',
      agent_name: 'Ada',
    })
  })
})

function readTranscript(options: {
  filePath: string
  offset?: number
  partial?: boolean
}): Message[] {
  const toolUseId = `toolu-${options.filePath}`
  const numLines = options.partial ? 1 : 2
  return [
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: FILE_READ_TOOL_NAME,
          input: {
            file_path: options.filePath,
            ...(options.offset === undefined ? {} : { offset: options.offset }),
          },
        },
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            '     1→alpha' +
            (options.partial
              ? '\n\n<system-reminder>Showing lines 1 to 1 of 2. This is a partial view. Read again with offset 2 to continue.</system-reminder>'
              : '\n     2→beta'),
        },
      ],
      toolUseResult: {
        type: 'text',
        file: { numLines, totalLines: 2 },
      },
    }),
  ]
}

describe('extractReadFilesFromMessages Write authorization', () => {
  test('restores a complete unbounded Read as authorizing', () => {
    const filePath = '/tmp/restored-complete.txt'
    const cache = extractReadFilesFromMessages(
      readTranscript({ filePath }),
      '/tmp',
    )

    expect(isCompleteUnboundedRead(cache.get(filePath))).toBe(true)
  })

  test('restores an explicit offset 1 Read as authorizing', () => {
    const filePath = '/tmp/restored-offset-one.txt'
    const cache = extractReadFilesFromMessages(
      readTranscript({ filePath, offset: 1 }),
      '/tmp',
    )

    expect(isCompleteUnboundedRead(cache.get(filePath))).toBe(true)
  })

  test('preserves truncation so a partial Read cannot authorize Write', () => {
    const filePath = '/tmp/restored-partial.txt'
    const cache = extractReadFilesFromMessages(
      readTranscript({ filePath, partial: true }),
      '/tmp',
    )

    expect(cache.get(filePath)?.isTruncatedView).toBe(true)
    expect(isCompleteUnboundedRead(cache.get(filePath))).toBe(false)
  })
})
