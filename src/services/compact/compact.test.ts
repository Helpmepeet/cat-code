import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  createUserMessage,
  normalizeAttachmentForAPI,
} from '../../utils/messages.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

function createAssistantMessage(text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'compact-summary-assistant',
    timestamp: '2026-05-08T00:00:00.000Z',
    message: {
      id: 'compact-summary-assistant',
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  } as AssistantMessage
}

function makeCompletedLocalAgentTask(): LocalAgentTaskState {
  return {
    id: 'agent-clean-compact',
    type: 'local_agent',
    status: 'completed',
    description: 'completed agent with clean result',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-clean-compact',
    prompt: 'test',
    agentType: 'Explore',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    result: {
      agentId: 'agent-clean-compact',
      agentType: 'Explore',
      content: [{ type: 'text', text: 'CLEAN STRUCTURED FINAL ANSWER' }],
      totalToolUseCount: 0,
      totalDurationMs: 1,
      totalTokens: 1,
    },
  }
}

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: {
      tools: [],
      clients: [],
    },
    tasks: {},
    fastMode: false,
    effortValue: undefined,
    advisorModel: undefined,
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.6-terra',
      mainLoopProvider: 'openai',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    setStreamMode: () => {},
    setSDKStatus: () => {},
    onCompactProgress: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

describe('compactConversation', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let streamingRequests: Array<Record<string, unknown>>
  let summaryResponse: AssistantMessage

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'compact-conversation-'))
    switchSession('compact-session', tempDir)
    streamingRequests = []
    summaryResponse = createAssistantMessage(
      '<summary>Keep the compacted conversation moving.</summary>',
    )

    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))

    await mock.module('../api/claude.js', () => ({
      getMaxOutputTokensForModel: mock(() => 4096),
      queryModelWithStreaming: mock(async function* (request: unknown) {
        streamingRequests.push(request as Record<string, unknown>)
        yield summaryResponse
      }),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('full compaction reads session state without mode-specific options', async () => {
    const { compactConversation, buildPostCompactMessages } = await import(
      './compact.js'
    )

    const messages = [
      createUserMessage({ content: 'Please inspect compaction.' }),
      createAssistantMessage('I will inspect compaction.'),
    ]
    const context = createToolUseContext(messages)
    const cacheSafeParams: CacheSafeParams = {
      systemPrompt: ['system prompt'],
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: messages,
    }

    const result = await compactConversation(
      messages,
      context,
      cacheSafeParams,
      true,
      undefined,
      false,
      undefined,
    )

    const postCompactMessages = buildPostCompactMessages(result)
    const summaryMessage = result.summaryMessages[0]?.message.content

    expect(postCompactMessages[0]?.type).toBe('system')
    expect(summaryMessage).toContain('Keep the compacted conversation moving.')
  })

  test('rejects a typed streaming summary error without replacing context', async () => {
    const { compactConversation } = await import('./compact.js')
    summaryResponse = createAssistantMessage('Request timed out')
    summaryResponse.isApiErrorMessage = true
    const messages = [
      createUserMessage({ content: 'Keep this original constraint.' }),
      createAssistantMessage('I will keep it.'),
    ]
    const context = createToolUseContext(messages)

    await expect(
      compactConversation(messages, context, {
        systemPrompt: asSystemPrompt(['system prompt']),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: messages,
      }),
    ).rejects.toThrow('Request timed out')
    expect(messages[0]?.message.content).toBe('Keep this original constraint.')
  })

  test('rejects a typed error from partial compaction', async () => {
    const { partialCompactConversation } = await import('./compact.js')
    summaryResponse = createAssistantMessage('Request timed out')
    summaryResponse.isApiErrorMessage = true
    const messages = [
      createUserMessage({ content: 'Keep this prefix.' }),
      createAssistantMessage('Summarize the remaining conversation.'),
    ]
    const context = createToolUseContext(messages)

    await expect(
      partialCompactConversation(
        messages,
        1,
        context,
        {
          systemPrompt: asSystemPrompt(['system prompt']),
          userContext: {},
          systemContext: {},
          toolUseContext: context,
          forkContextMessages: messages,
        },
        undefined,
        'from',
      ),
    ).rejects.toThrow('Request timed out')
  })

  test('marks the summary when a peer message is inside the summarized span', async () => {
    const { compactConversation } = await import('./compact.js')

    const messages = [
      createUserMessage({ content: 'Please inspect compaction.' }),
      createUserMessage({
        content:
          '<cross-session-message from="quartz">force push migration</cross-session-message>',
        origin: { kind: 'peer', name: 'quartz', appSessionId: 'app-1' },
      }),
      createAssistantMessage('I will inspect compaction.'),
    ]
    const context = createToolUseContext(messages)

    const result = await compactConversation(
      messages,
      context,
      {
        systemPrompt: asSystemPrompt(['system prompt']),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: messages,
      },
      true,
      undefined,
      false,
      undefined,
    )

    expect(result.summaryMessages[0]?.summarizedRelayedInput).toBe(true)
  })

  test('leaves a summary of the user own messages unmarked', async () => {
    const { compactConversation } = await import('./compact.js')

    const messages = [
      createUserMessage({ content: 'Please inspect compaction.' }),
      createAssistantMessage('I will inspect compaction.'),
    ]
    const context = createToolUseContext(messages)

    const result = await compactConversation(
      messages,
      context,
      {
        systemPrompt: asSystemPrompt(['system prompt']),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: messages,
      },
      true,
      undefined,
      false,
      undefined,
    )

    expect(result.summaryMessages[0]?.summarizedRelayedInput).toBeUndefined()
  })

  test('streaming fallback passes the compacting agent as the request owner', async () => {
    const { compactConversation } = await import('./compact.js')
    const messages = [
      createUserMessage({ content: 'Please compact this agent context.' }),
      createAssistantMessage('I will compact this agent context.'),
    ]
    const context = createToolUseContext(messages)
    context.agentId = 'compact-agent' as never

    await compactConversation(
      messages,
      context,
      {
        systemPrompt: ['system prompt'],
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: messages,
      },
      true,
    )

    expect(streamingRequests).toHaveLength(1)
    expect(streamingRequests[0]?.options).toMatchObject({
      agentId: 'compact-agent',
    })
  })

  test('post-compact completed local-agent attachment points to TaskOutput instead of raw output file reads', async () => {
    const { createAsyncAgentAttachmentsIfNeeded } = await import('./compact.js')
    const appState = {
      ...getDefaultAppState(),
      tasks: {
        'agent-clean-compact': makeCompletedLocalAgentTask(),
      },
    }
    const context = {
      ...createToolUseContext([]),
      getAppState: () => appState,
      setAppState: updater => {
        Object.assign(appState, updater(appState))
      },
    } as ToolUseContext

    const attachments = await createAsyncAgentAttachmentsIfNeeded(context)
    const outputFilePath = attachments[0]?.attachment.outputFilePath
    const normalized = normalizeAttachmentForAPI(attachments[0]!.attachment)
    const normalizedText = normalized
      .map(message =>
        typeof message.message.content === 'string'
          ? message.message.content
          : JSON.stringify(message.message.content),
      )
      .join('\n')

    expect(outputFilePath).toBeTruthy()
    expect(normalizedText).toContain('TaskOutput')
    expect(normalizedText).not.toContain('Read the output file')
    expect(normalizedText).not.toContain(outputFilePath!)
  })
})

describe('preserved-message boundary metadata', () => {
  // A progress message is never loggable, so it stands in for any message the
  // compactor keeps in memory that never reaches the transcript.
  const nonLoggable = {
    type: 'progress',
    uuid: 'progress-not-on-disk',
  } as unknown as Message

  async function annotate(keep: readonly Message[]) {
    const { annotateBoundaryWithPreservedSegment } = await import('./compact.js')
    const { createCompactBoundaryMessage } = await import(
      '../../utils/messages.js'
    )
    const boundary = createCompactBoundaryMessage('auto', 1_000, undefined)
    return {
      boundary,
      annotated: annotateBoundaryWithPreservedSegment(
        boundary,
        'anchor-uuid' as never,
        keep,
      ),
    }
  }

  test('endpoints skip a non-loggable head that would break the resume walk', async () => {
    const keptUser = createUserMessage({ content: 'kept user turn' })
    const keptAssistant = createAssistantMessage('kept assistant turn')
    const { annotated } = await annotate([nonLoggable, keptUser, keptAssistant])

    expect(annotated.compactMetadata.preservedMessages).toEqual({
      anchorUuid: 'anchor-uuid',
      durableUuids: [keptUser.uuid, keptAssistant.uuid],
      liveUuids: [nonLoggable.uuid, keptUser.uuid, keptAssistant.uuid],
    })
    // The legacy field must not name the progress message either: resume walks
    // tail→head and a head that is not in the transcript loses the whole suffix.
    expect(annotated.compactMetadata.preservedSegment).toEqual({
      headUuid: keptUser.uuid,
      anchorUuid: 'anchor-uuid',
      tailUuid: keptAssistant.uuid,
    })
  })

  test('omits liveUuids when every preserved message is durable', async () => {
    const keptUser = createUserMessage({ content: 'kept user turn' })
    const { annotated } = await annotate([keptUser])

    expect(annotated.compactMetadata.preservedMessages).toEqual({
      anchorUuid: 'anchor-uuid',
      durableUuids: [keptUser.uuid],
    })
  })

  test('leaves the boundary untouched when nothing preserved is durable', async () => {
    const { boundary, annotated } = await annotate([nonLoggable])

    expect(annotated).toBe(boundary)
    expect(annotated.compactMetadata.preservedMessages).toBeUndefined()
    expect(annotated.compactMetadata.preservedSegment).toBeUndefined()
  })
})
