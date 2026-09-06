import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import {
  allocateWorkerName,
  resetWorkerNamesForTests,
} from '../../agent-mode/workerNames.js'
import { asSessionId } from '../../types/ids.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  createAssistantMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { createAgentId } from '../../utils/uuid.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { ASK_ORCHESTRATOR_TOOL_NAME } from '../AskOrchestratorTool/prompt.js'
import { CLAUDE_CLI_TOOL_NAME } from '../ClaudeCliTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { finalizeAgentTool } from './agentToolUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Scripted stand-in for the query loop, so these tests exercise runAgent's own
// message handling without an API call. Only query() is replaced; the rest of
// the module is passed through so runAgent's other imports keep working.
const realQueryModule = await import('../../query.js')
let queryScript: () => AsyncGenerator<Message> = async function* () {}
// The system prompt runAgent actually handed the model, captured where the
// engine hands it over. Assembly happens inside runAgent (getAgentSystemPrompt
// is private), so this is the only place the finished array is observable.
let lastQuerySystemPrompt: string[] | undefined
mock.module('../../query.js', () => ({
  ...realQueryModule,
  query: (params: { systemPrompt?: string[] }) => {
    lastQuerySystemPrompt = params.systemPrompt
    return queryScript()
  },
}))

// Spies on recordSidechainTranscript while still calling through to the real
// implementation, so tests can assert which messages runAgent records without
// standing up a transcript. The real writer skips every write unless
// TEST_ENABLE_SESSION_PERSISTENCE is set, which is what the durable test at
// the end of this file turns on.
const realSessionStorageModule = await import('../../utils/sessionStorage.js')
// mock.module mutates the module namespace in place, so every real function
// this file needs has to be captured BEFORE the mock is installed. Reading
// recordSidechainTranscript back off the namespace afterwards returns the spy
// itself, which then recurses until the stack blows — invisibly, because
// runAgent wraps the record call in a .catch that logs and continues.
const {
  clearSessionMessagesCache,
  flushSessionStorage,
  getAgentTranscript,
  recordSidechainTranscript: recordSidechainTranscriptImpl,
  resetProjectForTesting,
} = realSessionStorageModule
let recordSidechainCalls: Array<{ messages: Message[]; agentId?: string }> = []
mock.module('../../utils/sessionStorage.js', () => ({
  ...realSessionStorageModule,
  recordSidechainTranscript: async (
    messages: Message[],
    agentId?: string,
    startingParentUuid?: unknown,
  ) => {
    recordSidechainCalls.push({ messages, agentId })
    return recordSidechainTranscriptImpl(
      messages,
      agentId,
      startingParentUuid as never,
    )
  },
}))

const { filterIncompleteToolCalls, runAgent } = await import('./runAgent.js')

/**
 * Minimal fake root store. runAgent only needs the slices its setup touches:
 * the permission context it reads, and the session-hook / todo maps it writes.
 */
function createAppStateHarness() {
  let state = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    sessionHooks: new Map<string, unknown>(),
    todos: {},
    tasks: {},
  }
  return {
    getAppState: () => state,
    setAppState: (update: (prev: never) => never) => {
      state = update(state as never) as never
    },
    readState: () => state,
  }
}

function createParentContext(harness: ReturnType<typeof createAppStateHarness>) {
  return {
    options: {
      commands: [],
      debug: false,
      verbose: false,
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [],
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: harness.getAppState,
    setAppState: harness.setAppState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    toolUseId: 'parent-tool-use',
  } as unknown as ToolUseContext
}

const AGENT: AgentDefinition = {
  agentType: 'implementor',
  whenToUse: 'never, this is a fixture',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => 'fixture prompt',
  hooks: {
    SubagentStop: [
      { matcher: '', hooks: [{ type: 'command', command: 'true' }] },
    ],
  },
}

/**
 * Drives runAgent far enough to acquire its pre-loop resources, then fails.
 * onCacheSafeParams is the last caller-controlled hook before the query loop's
 * try/finally, so throwing there reproduces a setup failure without a network
 * call, a real subagent, or any writes to the session store.
 */
function startAgent(
  harness: ReturnType<typeof createAppStateHarness>,
  extra: Record<string, unknown> = {},
) {
  return runAgent({
    agentDefinition: AGENT,
    promptMessages: [],
    toolUseContext: createParentContext(harness),
    canUseTool: (async () => ({
      behavior: 'allow' as const,
      updatedInput: {},
    })) as never,
    isAsync: false,
    querySource: 'agent' as never,
    availableTools: [],
    useExactTools: true,
    override: {
      systemPrompt: ['fixture prompt'] as never,
      userContext: {},
      systemContext: {},
    },
    ...extra,
  })
}

function runFailingSetup(harness: ReturnType<typeof createAppStateHarness>) {
  return startAgent(harness, {
    onCacheSafeParams: () => {
      throw new Error('setup boom')
    },
  })
}

function expectNoLeakedWorkerName() {
  // The implementor pool holds 20 distinct names. If a finished run kept its
  // reservation, one of these 20 allocations has to fall back to a suffixed
  // name (`Turing-2`), which is what a leak looks like from the outside.
  const names = Array.from({ length: 20 }, () =>
    allocateWorkerName('implementor'),
  )
  expect(names.filter(name => name?.includes('-'))).toEqual([])
}

describe('runAgent setup-failure cleanup', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    queryScript = async function* () {}
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-'))
    switchSession(asSessionId('session-run-agent'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  test('propagates the setup failure to the caller', async () => {
    const harness = createAppStateHarness()

    await expect(runFailingSetup(harness).next()).rejects.toThrow('setup boom')
  })

  test('releases the worker-name reservation when setup fails', async () => {
    const harness = createAppStateHarness()

    await expect(runFailingSetup(harness).next()).rejects.toThrow('setup boom')

    expectNoLeakedWorkerName()
  })

  test("clears the agent's session hooks when setup fails", async () => {
    const harness = createAppStateHarness()

    await expect(runFailingSetup(harness).next()).rejects.toThrow('setup boom')

    expect(harness.readState().sessionHooks.size).toBe(0)
  })

  test('still releases exactly once when the run completes normally', async () => {
    const harness = createAppStateHarness()
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'done' })
    }

    for await (const _message of startAgent(harness)) {
      // drain
    }

    expectNoLeakedWorkerName()
    expect(harness.readState().sessionHooks.size).toBe(0)
  })
})

describe('runAgent max-turn exhaustion', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-'))
    switchSession(asSessionId('session-run-agent-turns'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  async function collectExhaustedRun(): Promise<Message[]> {
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'partial work' })
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns: 3,
        turnCount: 4,
      })
    }
    const collected: Message[] = []
    for await (const message of startAgent(createAppStateHarness())) {
      collected.push(message)
    }
    return collected
  }

  test('forwards the max-turns signal instead of swallowing it', async () => {
    const collected = await collectExhaustedRun()

    expect(
      collected.filter(
        message =>
          message.type === 'attachment' &&
          (message.attachment as { type?: string }).type ===
            'max_turns_reached',
      ),
    ).toHaveLength(1)
  })

  test('lets the caller report the run as failed', async () => {
    const collected = await collectExhaustedRun()

    const result = finalizeAgentTool(collected, 'agent-turns', {
      prompt: 'do the thing',
      resolvedAgentModel: 'claude-sonnet-4-5',
      isBuiltInAgent: true,
      startTime: Date.now(),
      agentType: 'implementor',
      isAsync: false,
    })

    expect(result.error).toBe('Reached maximum number of turns (3)')
  })
})

describe('runAgent worker capability line', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-'))
    switchSession(asSessionId('session-run-agent-capabilities'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  /**
   * Spawns a worker through the real tool-resolution path (no `useExactTools`,
   * no `systemPrompt` override) and returns the assembled system prompt, so
   * the capability line is read off the pool the worker really received.
   */
  async function systemPromptFor(
    toolNames: string[],
    {
      isAsync,
      grantedTools,
      prebuiltPrompt,
      useExactTools = false,
    }: {
      isAsync: boolean
      grantedTools?: string[]
      /** Stands in for AgentTool's pre-assembled override.systemPrompt. */
      prebuiltPrompt?: string[]
      useExactTools?: boolean
    },
  ): Promise<string> {
    lastQuerySystemPrompt = undefined
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'done' })
    }
    for await (const _message of startAgent(createAppStateHarness(), {
      agentDefinition: grantedTools
        ? { ...AGENT, tools: grantedTools }
        : AGENT,
      availableTools: toolNames.map(name => ({
        name,
        inputSchema: {},
      })) as never,
      useExactTools,
      isAsync,
      override: {
        userContext: {},
        systemContext: {},
        ...(prebuiltPrompt ? { systemPrompt: prebuiltPrompt as never } : {}),
      },
    })) {
      // drain
    }
    return (lastQuerySystemPrompt ?? []).join('\n')
  }

  // ALL_AGENT_DISALLOWED_TOOLS strips Agent from every subagent outside
  // USER_TYPE=ant, and nothing told the worker. On 2026-09-06 three of four
  // general-purpose workers went hunting for a delegation tool that had
  // already been removed, and two fell back to launching engines through Bash.
  test('tells a worker whose pool lost Agent that it cannot delegate', async () => {
    const prompt = await systemPromptFor(['Read', 'Bash', AGENT_TOOL_NAME], {
      isAsync: false,
    })

    expect(prompt).toContain('you have no tool that starts another agent')
    expect(prompt).toContain('MUST NOT launch one through a shell')
  })

  // The same assembly must promise the capability when the pool really kept
  // it, or the line is a constant rather than a derivation. ClaudeCli is
  // grant-only (ASYNC_AGENT_EXPLICIT_GRANT_TOOLS), so a definition that names
  // it keeps it and the wildcard definition above does not — which is the
  // difference the line has to track.
  test('offers delegation when the resolved pool kept a delegation tool', async () => {
    const pool = ['Read', CLAUDE_CLI_TOOL_NAME]

    const granted = await systemPromptFor(pool, {
      isAsync: false,
      grantedTools: pool,
    })
    expect(granted).toContain(
      `you may run ${CLAUDE_CLI_TOOL_NAME} for a read-only advisory pass`,
    )

    const wildcard = await systemPromptFor(pool, { isAsync: false })
    expect(wildcard).toContain('you have no tool that starts another agent')
  })

  // Report §9: SendMessage survives filterToolsForAgent for a foreground
  // worker and is stripped from a background one, so the same brief produced
  // two different escalation capabilities and neither worker was told which it
  // had. The line has to move with the spawn shape, and must never offer
  // SendMessage as a route back to the spawner (SendMessageTool's own
  // fall-through says it can only reach running workers and agent IDs).
  test('reflects the escalation channel each spawn shape actually has', async () => {
    const pool = ['Read', SEND_MESSAGE_TOOL_NAME, ASK_ORCHESTRATOR_TOOL_NAME]

    const foreground = await systemPromptFor(pool, { isAsync: false })
    expect(foreground).toContain(
      `${SEND_MESSAGE_TOOL_NAME} reaches running workers and teammates, never whoever spawned you.`,
    )

    const background = await systemPromptFor(pool, { isAsync: true })
    expect(background).not.toContain(SEND_MESSAGE_TOOL_NAME)
    expect(background).toContain(
      `call ${ASK_ORCHESTRATOR_TOOL_NAME} once, then stop your turn and return a blocked result`,
    )
  })

  // The ordinary Agent spawn never reaches getAgentSystemPrompt: AgentTool
  // assembles the prompt itself and passes it as override.systemPrompt unless
  // a worktree or cwd override is in play. A capability line added only to the
  // builder would therefore miss every worker that motivated it.
  test('reaches a worker whose prompt AgentTool pre-assembled', async () => {
    const prompt = await systemPromptFor(['Read', 'Bash'], {
      isAsync: false,
      prebuiltPrompt: ['pre-assembled by AgentTool'],
    })

    expect(prompt).toContain('pre-assembled by AgentTool')
    expect(prompt).toContain('you have no tool that starts another agent')
  })

  // Fork children run on the parent's exact prompt and tool array so the
  // request prefix stays cache-identical. Appending anything there would break
  // that for no gain: their capabilities are the parent's.
  test('leaves a fork child prompt byte-identical to the parent', async () => {
    const parentPrompt = ['parent prompt']

    const prompt = await systemPromptFor(['Read', 'Bash'], {
      isAsync: false,
      useExactTools: true,
      prebuiltPrompt: parentPrompt,
    })

    expect(prompt).toBe('parent prompt')
  })
})

describe('runAgent coordinator-message sidechain recording', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-'))
    switchSession(asSessionId('session-run-agent-coordinator'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  function attachmentRecordings(agentId: string) {
    return recordSidechainCalls
      .filter(call => call.agentId === agentId)
      .flatMap(call => call.messages)
      .filter(m => m.type === 'attachment')
  }

  // A SendMessage delivery to a running worker (or any other queued/coordinator
  // turn) reaches the worker's query loop as a 'queued_command' attachment
  // (src/utils/attachments.ts getAgentPendingMessageAttachments), which arrives
  // here as message.type === 'attachment'. Before this fix, every attachment
  // was yielded and never recorded, so no subagent sidechain could ever show
  // that a coordinator message was delivered.
  test('records a delivered queued_command attachment naming its origin', async () => {
    const agentId = createAgentId('coordinator-test')
    recordSidechainCalls = []
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'working' })
      yield createAttachmentMessage({
        type: 'queued_command',
        prompt: 'Clarification: read source directly.',
        origin: { kind: 'coordinator' },
      })
    }

    for await (const _message of startAgent(createAppStateHarness(), {
      override: {
        systemPrompt: ['fixture prompt'] as never,
        userContext: {},
        systemContext: {},
        agentId,
      },
    })) {
      // drain
    }

    const recorded = attachmentRecordings(agentId).find(
      m => (m as { attachment: { type?: string } }).attachment.type === 'queued_command',
    )

    expect(recorded).toBeDefined()
    expect(
      (recorded as { attachment: { origin?: { kind?: string } } }).attachment
        .origin?.kind,
    ).toBe('coordinator')
  })

  // Not every attachment kind should start showing up in sidechains: only
  // delivered queued_command turns carry an origin worth naming. structured_output
  // (and the rest) are re-derived every turn from live state, so recording them
  // would just be noise — the blanket "don't record attachments" comment on
  // runAgent.ts still governs everything except this one narrow case.
  test('does not record an attachment kind with no delivery origin', async () => {
    const agentId = createAgentId('structured-output-test')
    recordSidechainCalls = []
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'working' })
      yield createAttachmentMessage({
        type: 'structured_output',
        data: { ok: true },
      })
    }

    for await (const _message of startAgent(createAppStateHarness(), {
      override: {
        systemPrompt: ['fixture prompt'] as never,
        userContext: {},
        systemContext: {},
        agentId,
      },
    })) {
      // drain
    }

    expect(attachmentRecordings(agentId)).toHaveLength(0)
  })

  /**
   * The two tests above prove runAgent hands the attachment to the recorder.
   * They cannot prove a row lands or that anything can read it back, which is
   * the whole point of the diagnostic: the investigation this fix came from
   * could not tell whether 39 coordinator messages were delivered because no
   * subagent transcript could hold one. So this one runs the real writer
   * against a real on-disk session and reads it back through
   * getAgentTranscript, the same call the runtime uses to load a subagent
   * transcript.
   */
  test('leaves the origin recoverable from the loaded agent transcript', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'run-agent-cfg-'))
    const sessionDir = mkdtempSync(join(tmpdir(), 'run-agent-session-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    const agentId = createAgentId('durable-coordinator-test')

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
      resetProjectForTesting()
      switchSession(asSessionId(randomUUID()), sessionDir)
      clearSessionMessagesCache()

      queryScript = async function* () {
        yield createAssistantMessage({ content: 'working' })
        yield createAttachmentMessage({
          type: 'queued_command',
          prompt: 'Clarification: read source directly.',
          origin: { kind: 'coordinator' },
        })
      }

      for await (const _message of startAgent(createAppStateHarness(), {
        override: {
          systemPrompt: ['fixture prompt'] as never,
          userContext: {},
          systemContext: {},
          agentId,
        },
      })) {
        // drain
      }

      await flushSessionStorage()
      const transcript = await getAgentTranscript(agentId)
      const delivered = (transcript?.messages ?? []).filter(
        message =>
          message.type === 'attachment' &&
          (message.attachment as { type?: string }).type === 'queued_command',
      )

      expect(delivered).toHaveLength(1)
      expect(
        (delivered[0] as { attachment: { origin?: { kind?: string } } })
          .attachment.origin?.kind,
      ).toBe('coordinator')
    } finally {
      clearSessionMessagesCache()
      resetProjectForTesting()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousPersistence === undefined) {
        delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      } else {
        process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
      }
      await rm(configDir, { recursive: true, force: true }).catch(() => {})
      await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('filterIncompleteToolCalls', () => {
  function toolUse(id: string) {
    return { type: 'tool_use' as const, id, name: 'Read', input: {} }
  }

  function toolResult(id: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'ok',
      is_error: false,
    }
  }

  function toolUseIdsIn(messages: Message[]): string[] {
    return messages.flatMap(message =>
      message.type === 'assistant' && Array.isArray(message.message.content)
        ? message.message.content.flatMap(block =>
            block.type === 'tool_use' ? [block.id] : [],
          )
        : [],
    )
  }

  function toolResultIdsIn(messages: Message[]): string[] {
    return messages.flatMap(message =>
      message.type === 'user' && Array.isArray(message.message.content)
        ? message.message.content.flatMap(block =>
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
              ? [block.tool_use_id as string]
              : [],
          )
        : [],
    )
  }

  test('leaves a fully paired turn untouched', () => {
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('a')] }),
      createUserMessage({ content: [toolResult('a')] }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(filtered).toHaveLength(2)
    expect(toolResultIdsIn(filtered)).toEqual(['a'])
  })

  test('drops an assistant message whose tool calls never returned', () => {
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('a'), toolUse('b')] }),
      createUserMessage({ content: [toolResult('a')] }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(toolUseIdsIn(filtered)).toEqual([])
  })

  test('does not leave behind the results of a dropped assistant message', () => {
    // The interrupted-turn shape: results from tools that already finished were
    // yielded, then createUserInterruptionMessage inserted a text-only message
    // and synthesized no result for the tool still running.
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('a'), toolUse('b')] }),
      createUserMessage({ content: [toolResult('a')] }),
      createUserInterruptionMessage({ toolUse: true }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(toolResultIdsIn(filtered)).toEqual([])
  })

  test('keeps the results that belong to assistant messages it kept', () => {
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('kept')] }),
      createUserMessage({ content: [toolResult('kept')] }),
      createAssistantMessage({ content: [toolUse('a'), toolUse('b')] }),
      createUserMessage({ content: [toolResult('a')] }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(toolUseIdsIn(filtered)).toEqual(['kept'])
    expect(toolResultIdsIn(filtered)).toEqual(['kept'])
  })

  test('keeps the other content of a message it strips a result from', () => {
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('a'), toolUse('b')] }),
      createUserMessage({
        content: [toolResult('a'), { type: 'text', text: 'carry on' }],
      }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(toolResultIdsIn(filtered)).toEqual([])
    const user = filtered.find(message => message.type === 'user')
    expect(user?.message.content).toEqual([{ type: 'text', text: 'carry on' }])
  })

  test('passes non-assistant, non-user messages through', () => {
    const attachment = createAttachmentMessage({ type: 'verify_plan_reminder' })
    const messages: Message[] = [
      createAssistantMessage({ content: [toolUse('a')] }),
      attachment,
      createUserMessage({ content: [toolResult('a')] }),
    ]

    const filtered = filterIncompleteToolCalls(messages)

    expect(filtered).toContain(attachment)
    expect(toolResultIdsIn(filtered)).toEqual(['a'])
  })
})
