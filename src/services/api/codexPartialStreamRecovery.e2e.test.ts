import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ClientOptions } from '@anthropic-ai/sdk'

import { query } from '../../query.js'
import type { QueryDeps } from '../../query/deps.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'
import {
  translateCodexStreamToAnthropic,
  translateCodexWsStreamToAnthropic,
} from './codex-fetch-adapter.js'
import { CodexWebSocketClosedBeforeCompletedError } from './codex-websocket-transport.js'

/**
 * The three seams of Codex partial-stream recovery each have their own suite,
 * and every one of them starts from a hand-written version of what the seam
 * below it is supposed to produce. So they can all stay green while the seams
 * stop fitting: an adapter that stopped sealing the text block, a claude.ts
 * that stopped materializing the sealed block or stopped carrying the marker
 * to `apiError`, or a query loop reading a field nobody mints any more.
 *
 * HTTP supplies raw SSE that ends before completion; websocket supplies the
 * typed close error raised by its transport. Above those fake sources,
 * production code runs: the adapter builds SSE, the Anthropic SDK reads it,
 * `claude.ts` materializes and classifies, and `query.ts` decides.
 *
 * The two substitutions and why they are not the thing under test:
 *  - `deps.callModel` wraps the real `queryModelWithStreaming` only to inject
 *    `fetchOverride`; `query.ts` has no parameter for one (it passes
 *    `dumpPromptsFetch`, an Ant-gated capture, at query.ts:864).
 *  - The session runs as `firstParty`/`claude-sonnet-4-6` rather than a `gpt-*`
 *    model, because `getAnthropicClient` (client.ts:484) REPLACES the client
 *    fetch with `createCodexFetch` for a resolved `openai` provider and needs
 *    live Codex OAuth. That substitution is faithful at the seam that matters:
 *    the production Codex path hands the very same
 *    `translateCodexWsStreamToAnthropic` Response to the very same SDK
 *    (codex-fetch-adapter.ts:3894). Continuation eligibility is decided by the
 *    marker's own `provider: 'openai'` field, which the adapter mints, not by
 *    the session's provider.
 */

const PARTIAL_TEXT = 'Half of the answer, already on screen'
const FINAL_TEXT = 'and the rest of it, written once'
const RECOVERY_INSTRUCTION =
  'Continue from the preserved response without repeating completed work'
const ORIGINAL_PROMPT = 'do the thing'

/** A Codex websocket turn that dies after visible text, before completion. */
async function* interruptedCodexTurn(): AsyncGenerator<Record<string, unknown>> {
  yield { type: 'response.created', response: { id: 'resp_interrupted' } }
  yield { type: 'response.output_text.delta', delta: 'Half of the answer, ' }
  yield { type: 'response.output_text.delta', delta: 'already on screen' }
  throw new CodexWebSocketClosedBeforeCompletedError(1006, 'abnormal')
}

/** The continuation turn, which completes. */
async function* completedCodexTurn(): AsyncGenerator<Record<string, unknown>> {
  yield { type: 'response.created', response: { id: 'resp_continuation' } }
  yield { type: 'response.output_text.delta', delta: FINAL_TEXT }
  yield {
    type: 'response.completed',
    response: {
      id: 'resp_continuation',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  }
}

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: { tools: [], clients: [] },
    tasks: {},
    sessionHooks: new Map(),
    fastMode: false,
    effortValue: undefined,
    advisorModel: undefined,
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      mainLoopProvider: 'firstParty',
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
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

function assistantTextOf(messages: Message[]): string[] {
  return messages.flatMap(message =>
    message.type === 'assistant'
      ? (message.message.content as { type: string; text?: string }[])
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
      : [],
  )
}

describe('Codex partial-stream recovery, adapter through query loop', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalFixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  const macroState = globalThis as typeof globalThis & {
    MACRO?: { VERSION: string }
  }
  const originalMacro = macroState.MACRO
  let fixturesRoot: string | undefined

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
    if (originalFixturesRoot === undefined) {
      delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
    } else {
      process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = originalFixturesRoot
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { recursive: true, force: true })
      fixturesRoot = undefined
    }
    macroState.MACRO = originalMacro
  })

  test.each(['websocket', 'http'] as const)('a real %s adapter break continues the turn and keeps the sealed text', async transport => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-codex-e2e-'))
    macroState.MACRO = { VERSION: 'test-version' }

    const dispatchedBodies: { stream?: boolean; messages?: unknown[] }[] = []
    const fetchOverride: NonNullable<ClientOptions['fetch']> = async (
      _input,
      init,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean
        messages?: unknown[]
      }
      dispatchedBodies.push(body)
      if (body.stream !== true) {
        throw new Error(
          'the non-streaming fallback replayed a turn whose output was already read',
        )
      }
      const metadata = {
        accountId: 'acct_e2e',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_e2e:gpt-5.6-luna',
        conversationId: `conv_e2e_${Date.now()}`,
      }
      if (transport === 'websocket') {
        return translateCodexWsStreamToAnthropic(
          dispatchedBodies.length === 1 ? interruptedCodexTurn() : completedCodexTurn(),
          'gpt-5.6-luna',
          metadata,
        )
      }
      const events: Record<string, unknown>[] = []
      if (dispatchedBodies.length === 1) {
        events.push({ type: 'response.output_text.delta', delta: PARTIAL_TEXT })
      } else {
        for await (const event of completedCodexTurn()) events.push(event)
      }
      return translateCodexStreamToAnthropic(
        new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
        'gpt-5.6-luna',
        metadata,
      )
    }

    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: params => {
        // `NODE_ENV=test` turns the VCR recorder on unconditionally
        // (vcr.ts:23), and it keys a cassette on message content with meta
        // user messages filtered out. A continuation whose only new content is
        // the meta recovery instruction therefore hashes to the SAME cassette
        // as the interrupted turn, and replays it instead of dispatching —
        // which is how a broken seal reads as "no second request" rather than
        // as the missing text it is. A fresh fixture root per model call keeps
        // every call a real dispatch.
        process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = mkdtempSync(
          join(fixturesRoot!, 'call-'),
        )
        return queryModelWithStreaming({
          ...params,
          options: { ...params.options, fetchOverride },
        })
      },
    }

    const messages: Message[] = [
      createUserMessage({ content: ORIGINAL_PROMPT }),
    ]
    const toolUseContext = createToolUseContext(messages)
    const yielded: Message[] = []
    for await (const message of query({
      messages,
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'test allows all tools' },
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      deps,
    })) {
      yielded.push(message as Message)
    }

    // Two dispatches: the interrupted original and one continuation. A third
    // would mean the loop re-dialled; a `stream: false` one would mean the
    // outer non-streaming fallback replayed the turn (it throws above).
    expect(dispatchedBodies).toHaveLength(2)
    // The original request went out exactly once. It is the only body carrying
    // just the user's prompt, so a replay would show up as a second copy.
    const originalDispatches = dispatchedBodies.filter(
      body => (body.messages?.length ?? 0) === 1,
    )
    expect(originalDispatches).toHaveLength(1)

    const continuationBody = JSON.stringify(dispatchedBodies[1])
    // What the adapter sealed has to survive as context, or the continuation
    // regenerates it — the duplication the whole path exists to prevent.
    expect(continuationBody).toContain(PARTIAL_TEXT)
    expect(continuationBody).toContain(RECOVERY_INSTRUCTION)
    expect(continuationBody).toContain(ORIGINAL_PROMPT)
    // The synthetic transport error is bookkeeping, not the assistant's turn.
    expect(continuationBody).not.toContain('API Error')

    // Nothing intermediate reaches a caller that treats an error as fatal.
    const apiErrors = yielded.filter(
      message =>
        message.type === 'assistant' &&
        (message as AssistantMessage).isApiErrorMessage === true,
    )
    expect(apiErrors).toHaveLength(0)

    const notices = yielded.filter(
      message =>
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'transport_recovery',
    )
    expect(notices).toHaveLength(1)

    const texts = assistantTextOf(yielded)
    expect(texts).toContain(PARTIAL_TEXT)
    expect(texts).toContain(FINAL_TEXT)
  })
})
