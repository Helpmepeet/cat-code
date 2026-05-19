import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'

function createAssistantMessage(text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'compact-summary-assistant',
    timestamp: '2026-05-08T00:00:00.000Z',
    message: {
      id: 'compact-summary-assistant',
      model: 'gpt-5.5',
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
      mainLoopModel: 'gpt-5.5',
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

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'compact-conversation-'))
    switchSession('compact-session', tempDir)

    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))

    await mock.module('../api/claude.js', () => ({
      getMaxOutputTokensForModel: mock(() => 4096),
      queryModelWithStreaming: mock(async function* () {
        yield createAssistantMessage(
          '<summary>Keep the compacted conversation moving.</summary>',
        )
      }),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('full compaction reads session state without requiring agent mode options', async () => {
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
    expect(summaryMessage).not.toContain('Agent Mode Run State')
  })
})
