import { feature } from 'bun:bundle'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import * as realClaudeApi from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

/**
 * `/compact` routes through reactive prefix compaction by default, and falls
 * back to full replacement only when the conversation cannot be split.
 *
 * These drive the command's real `call()` rather than the reactive module, so
 * they fail if the routing is removed even while the module still works.
 * `feature()` is false under a plain `bun test`; the reactive assertions run
 * under `bun test --feature=REACTIVE_COMPACT`, which is the switch
 * `scripts/build.ts` passes to `bun build` for dev-full.
 */
const REACTIVE_COMPILED_IN = ((): boolean => {
  if (feature('REACTIVE_COMPACT')) {
    return true
  }
  return false
})()

function assistant(id: string, text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    timestamp: '2026-08-12T00:00:00.000Z',
    message: {
      id,
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

function createContext(
  messages: Message[],
  progress?: { type: string }[],
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: { tools: [], clients: [] },
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
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
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
    onCompactProgress: (event: { type: string }) => progress?.push(event),
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

describe('/compact routing', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let summarizerRequests: string[]
  let previousApiKey: string | undefined

  beforeEach(async () => {
    // getCacheSharingParams builds the real system prompt, which enumerates
    // commands and asks isClaudeAISubscriber() whether each is available
    // (commands.ts:446). That throws on a machine with no Anthropic
    // credentials. Nothing here reaches the network: the only model call is
    // the mocked summarizer below.
    previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key-never-sent'
    tempDir = mkdtempSync(join(tmpdir(), 'compact-command-'))
    switchSession('compact-command-session', tempDir)
    summarizerRequests = []

    // false keeps the summary on the streaming path, which is the one a mocked
    // claude.js can drive; the forked path would spawn a real query.
    await mock.module('../../services/analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))
    await mock.module('../../services/api/claude.js', () => ({
      ...realClaudeApi,
      queryModelWithStreaming: mock(async function* (params: unknown) {
        summarizerRequests.push(JSON.stringify(params))
        yield assistant('summary', '<summary>Older rounds, summarized.</summary>')
      }),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  function threeRoundConversation() {
    const newestAnswer = assistant('round-3', 'NEWEST_ASSISTANT_ANSWER')
    const newest = createUserMessage({ content: 'NEWEST_USER_PROMPT' })
    return {
      newestAnswer,
      newest,
      messages: [
        createUserMessage({ content: 'OLDEST_USER_PROMPT' }),
        assistant('round-1', 'OLDEST_ASSISTANT_ANSWER'),
        createUserMessage({ content: 'MIDDLE_USER_PROMPT' }),
        assistant('round-2', 'MIDDLE_ASSISTANT_ANSWER'),
        createUserMessage({ content: 'THIRD_USER_PROMPT' }),
        newestAnswer,
        newest,
      ],
    }
  }

  test.if(REACTIVE_COMPILED_IN)(
    'preserves the newest round instead of replacing the conversation',
    async () => {
      const { call } = await import('./compact.js')
      const { messages, newestAnswer, newest } = threeRoundConversation()
      const context = createContext(messages)

      const result = await call('', context)

      expect(result.type).toBe('compact')
      // Full compaction returns no messagesToKeep at all, so this key is the
      // discriminator between the two paths.
      expect(result.compactionResult!.messagesToKeep).toEqual([
        newestAnswer,
        newest,
      ])
      expect(summarizerRequests).toHaveLength(1)
      expect(summarizerRequests[0]).toContain('OLDEST_USER_PROMPT')
      expect(summarizerRequests[0]).not.toContain('NEWEST_USER_PROMPT')
    },
  )

  test.if(REACTIVE_COMPILED_IN)(
    'falls back to full compaction when the conversation is one round',
    async () => {
      const { call } = await import('./compact.js')
      const messages = [
        createUserMessage({ content: 'ONLY_USER_PROMPT' }),
        assistant('round-1', 'ONLY_ASSISTANT_ANSWER'),
      ]

      // A single round cannot be split into "summarize" and "preserve" halves.
      // Before the fallback existed this threw "not enough messages"; full
      // compaction has no such requirement, so the command still succeeds.
      const progress: { type: string }[] = []
      const result = await call('', createContext(messages, progress))

      expect(result.type).toBe('compact')
      expect(result.compactionResult!.messagesToKeep).toBeUndefined()
      // Exactly one compaction was started. Two would mean the reactive path
      // ran far enough to emit its own progress and its own PreCompact hooks
      // before falling back, firing the user's hook twice for one compaction.
      expect(progress.filter(event => event.type === 'compact_start')).toEqual([
        { type: 'compact_start' },
      ])
    },
  )

  test.if(!REACTIVE_COMPILED_IN)(
    'compiles out to full compaction when REACTIVE_COMPACT is absent',
    async () => {
      const { call } = await import('./compact.js')
      const { messages } = threeRoundConversation()

      const result = await call('', createContext(messages))

      expect(result.type).toBe('compact')
      expect(result.compactionResult!.messagesToKeep).toBeUndefined()
    },
  )
})
