import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
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
import { finalizeAgentTool } from './agentToolUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Scripted stand-in for the query loop, so these tests exercise runAgent's own
// message handling without an API call. Only query() is replaced; the rest of
// the module is passed through so runAgent's other imports keep working.
const realQueryModule = await import('../../query.js')
let queryScript: () => AsyncGenerator<Message> = async function* () {}
mock.module('../../query.js', () => ({
  ...realQueryModule,
  query: () => queryScript(),
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
