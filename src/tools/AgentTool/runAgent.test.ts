import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import {
  allocateWorkerName,
  releaseWorkerName,
  tryReserveWorkerName,
  resetWorkerNamesForTests,
} from '../../utils/workerNames.js'
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
import { ASK_PARENT_SESSION_TOOL_NAME } from '../AskParentSessionTool/prompt.js'
import { CLAUDE_CLI_TOOL_NAME } from '../ClaudeCliTool/constants.js'
import { _claudeCliToolInternalsForTest } from '../ClaudeCliTool/ClaudeCliTool.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { finalizeAgentTool } from './agentToolUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Scripted stand-in for the query loop, so these tests exercise runAgent's own
// message handling without an API call. Only query() is replaced; the rest of
// the module is passed through so runAgent's other imports keep working.
const realQueryModule = await import('../../query.js')
let queryScript: (
  toolUseContext: ToolUseContext | undefined,
) => AsyncGenerator<Message> = async function* () {}
// The system prompt runAgent actually handed the model, captured where the
// engine hands it over. Assembly happens inside runAgent (getAgentSystemPrompt
// is private), so this is the only place the finished array is observable.
let lastQuerySystemPrompt: string[] | undefined
// The subagent's own ToolUseContext is only observable here: runAgent builds it
// and hands it straight to query().
let lastQueryToolUseContext: ToolUseContext | undefined
mock.module('../../query.js', () => ({
  ...realQueryModule,
  query: (params: {
    systemPrompt?: string[]
    toolUseContext?: ToolUseContext
  }) => {
    lastQuerySystemPrompt = params.systemPrompt
    lastQueryToolUseContext = params.toolUseContext
    return queryScript(params.toolUseContext)
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
  getAgentTranscriptPath,
  recordSidechainTranscript: recordSidechainTranscriptImpl,
  resetProjectForTesting,
} = realSessionStorageModule
let recordSidechainCalls: Array<{
  messages: Message[]
  agentId?: string
  startingParentUuid?: string | null
}> = []
mock.module('../../utils/sessionStorage.js', () => ({
  ...realSessionStorageModule,
  recordSidechainTranscript: async (
    messages: Message[],
    agentId?: string,
    startingParentUuid?: unknown,
  ) => {
    recordSidechainCalls.push({
      messages,
      agentId,
      startingParentUuid: startingParentUuid as string | null | undefined,
    })
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
  const knownNames = [
    'Ada', 'Katherine', 'Johnson', 'Hamilton', 'Ritchie', 'Kay', 'Wilkes',
    'Goldstine', 'Backus', 'Engelbart', 'Cerf', 'Barton', 'Hopper', 'Turing',
    'McCarthy', 'Lamarr', 'Knuth', 'Dijkstra', 'Allen', 'Berners-Lee', 'Naur',
    'Iverson', 'Minsky', 'Shannon', 'Lovelace', 'Boole', 'Babbage', 'Torvalds',
    'Matsumoto', 'Raskin', 'Thompson', 'Kernighan', 'Stroustrup', 'Meyer',
    'Ousterhout', 'Liskov', 'Karger', 'Sutherland', 'Metcalfe', 'Kahn', 'Codd',
    'Brooks', 'Hamming', 'Sperry', 'Hollerith', 'Zuse', 'Tukey', 'Nielsen',
    'Moggridge', 'Norman', 'Abelson', 'Sussman', 'Miller', 'Reddy', 'Ullman',
    'Aho', 'Sedgewick', 'Tarjan', 'Karp', 'Rivest', 'Shamir', 'Adleman',
    'Diffie', 'Hellman', 'Moser', 'Conway', 'Moore', 'Lampson', 'Wirth',
    'Hoare', 'Hewitt', 'Milner', 'Kiczales', 'Cardelli', 'Peyton-Jones',
  ]
  for (const name of knownNames) {
    expect(tryReserveWorkerName(name)).toBe(true)
  }
  for (const name of knownNames) releaseWorkerName(name)
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

describe('runAgent worker-scoped delegated-child cleanup', () => {
  let tempDir: string
  // Only pids this describe block spawns itself; never a process-table
  // sweep, since other sessions and the operator share this machine.
  const spawnedPids: number[] = []

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-delegated-'))
    switchSession(asSessionId('session-run-agent-delegated'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone, which the test below asserts.
      }
    }
  })

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return !isAlive(pid)
  }

  // The scenario killShellTasksForAgent already covers for background bash:
  // a call the worker made outlives the worker's own run because nothing
  // else was watching it (the streaming tool executor can discard an
  // in-flight tool call without aborting it). Reproduced here for
  // ClaudeCliTool by spawning through its own seam and deliberately never
  // awaiting the result, then draining the worker's run to completion.
  test('a delegated Claude CLI child dies when the worker that spawned it does', async () => {
    const agentId = createAgentId('delegated-cleanup-test')
    const harness = createAppStateHarness()
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'done' })
    }

    let markSpawned: () => void = () => {}
    const spawned = new Promise<void>(resolve => {
      markSpawned = resolve
    })
    void _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello', timeout: 30_000 },
      { abortController: new AbortController(), agentId },
      (_executable, _args, options) => {
        const child = spawn('/bin/sh', ['-c', 'sleep 20'], options)
        if (child.pid !== undefined) spawnedPids.push(child.pid)
        markSpawned()
        return child as never
      },
    )
    await spawned
    const [pid] = spawnedPids
    expect(isAlive(pid!)).toBe(true)

    for await (const _message of startAgent(harness, {
      override: {
        agentId,
        systemPrompt: ['fixture prompt'] as never,
        userContext: {},
        systemContext: {},
      },
    })) {
      // drain
    }

    expect(await waitUntilGone(pid!)).toBe(true)
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

describe('runAgent terminal escalation', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-'))
    switchSession(asSessionId('session-run-agent-escalation'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  const ESCALATION = {
    kind: 'question',
    message: 'Which schema owns the retry field, protocol.ts or hostApi.ts?',
    evidence: ['Both declare `retry`, and the brief names neither'],
  }
  const KEPT_GOING = 'Nobody answered, so I picked one.'

  /**
   * One escalation turn, followed by the turn a worker takes when nothing
   * stops it. Wilkes took exactly that second turn on 2026-09-06 and returned
   * Blocked having read nothing, so the second message is the regression: it
   * must never reach the caller.
   */
  async function collectEscalatingRun({
    isError = false,
  }: { isError?: boolean } = {}): Promise<Message[]> {
    queryScript = async function* () {
      yield createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_escalate',
            name: ASK_PARENT_SESSION_TOOL_NAME,
            input: ESCALATION,
          },
        ] as never,
      })
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_escalate',
            content: 'Handed to the parent session.',
            ...(isError ? { is_error: true } : {}),
          },
        ],
      })
      yield createAssistantMessage({ content: KEPT_GOING })
    }
    const collected: Message[] = []
    for await (const message of startAgent(createAppStateHarness())) {
      collected.push(message)
    }
    return collected
  }

  function resultTextOf(collected: Message[]): string {
    return finalizeAgentTool(collected, 'agent-escalation', {
      prompt: 'sweep the renderer',
      resolvedAgentModel: 'gpt-5.6-luna',
      isBuiltInAgent: true,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: false,
    })
      .content.map(block => block.text)
      .join('\n')
  }

  test('ends the run instead of letting the worker take another turn', async () => {
    const collected = await collectEscalatingRun()

    expect(
      collected.some(
        message =>
          message.type === 'assistant' &&
          JSON.stringify(message.message.content).includes(KEPT_GOING),
      ),
    ).toBe(false)
  })

  test('returns the question and evidence as a blocked handoff', async () => {
    const text = resultTextOf(await collectEscalatingRun())

    expect(text).toContain('status: blocked')
    expect(text).toContain(ESCALATION.message)
    expect(text).toContain(ESCALATION.evidence[0]!)
  })

  // A blocked handoff is a finished run awaiting a decision, not a failure:
  // `error` is what makes the parent report the agent as failed
  // (max-turns and API-error terminals above are the paths that set it).
  test('does not report the escalated run as an error', async () => {
    const result = finalizeAgentTool(
      await collectEscalatingRun(),
      'agent-escalation',
      {
        prompt: 'sweep the renderer',
        resolvedAgentModel: 'gpt-5.6-luna',
        isBuiltInAgent: true,
        startTime: Date.now(),
        agentType: 'general-purpose',
        isAsync: false,
      },
    )

    expect(result.error).toBeUndefined()
  })

  // A denied or failed call is not an escalation the parent session ever
  // received, so stopping the worker on it would strand the question.
  test('keeps running when the escalation call itself failed', async () => {
    const collected = await collectEscalatingRun({ isError: true })

    expect(
      collected.some(
        message =>
          message.type === 'assistant' &&
          JSON.stringify(message.message.content).includes(KEPT_GOING),
      ),
    ).toBe(true)
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
    const pool = ['Read', SEND_MESSAGE_TOOL_NAME, ASK_PARENT_SESSION_TOOL_NAME]

    const foreground = await systemPromptFor(pool, { isAsync: false })
    expect(foreground).toContain(
      `${SEND_MESSAGE_TOOL_NAME} reaches running workers and teammates, never whoever spawned you.`,
    )

    const background = await systemPromptFor(pool, { isAsync: true })
    expect(background).not.toContain(SEND_MESSAGE_TOOL_NAME)
    expect(background).toContain(
      `call ${ASK_PARENT_SESSION_TOOL_NAME} with the exact question: it ends your run`,
    )
  })

  // The worker is no longer asked to stop after escalating, because the
  // harness stops it. A line that still told it to would be a rule the run
  // contradicts, which is how the old contract failed in the first place.
  test('does not ask the worker to stop its own turn after escalating', async () => {
    const prompt = await systemPromptFor(['Read', ASK_PARENT_SESSION_TOOL_NAME], {
      isAsync: false,
    })

    expect(prompt).not.toContain('then stop your turn')
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

describe('runAgent resume continuation continuity', () => {
  let tempDir: string

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-resume-'))
    switchSession(asSessionId('session-run-agent-resume'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  function callForAgent(agentId: string, index: number) {
    return recordSidechainCalls.filter(call => call.agentId === agentId)[index]
  }

  test('links new resume instruction to the seeded tail', async () => {
    const agentId = createAgentId('resume-continuity')
    const seededA = createUserMessage({ content: 'resumed seed A' })
    const seededB = createUserMessage({ content: 'resumed seed B' })
    const resumeInstruction = createUserMessage({ content: 'continue from here' })
    recordSidechainCalls = []
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'working' })
    }

    for await (const _message of startAgent(createAppStateHarness(), {
      promptMessages: [seededA, seededB, resumeInstruction],
      seededMessagesForPersistence: [seededA, seededB],
      override: {
        systemPrompt: ['fixture prompt'] as never,
        userContext: {},
        systemContext: {},
        agentId,
      },
    })) {
      // drain
    }

    const persistedReplay = callForAgent(agentId, 0)
    expect(persistedReplay).toBeDefined()
    expect(persistedReplay?.messages).toEqual([resumeInstruction])
    expect(persistedReplay?.startingParentUuid).toBe(seededB.uuid)

    const continuationReplay = callForAgent(agentId, 1)
    expect(continuationReplay?.startingParentUuid).toBe(resumeInstruction.uuid)
  })

  test('falls back to the seeded tail only when no new persisted initial message exists', async () => {
    const agentId = createAgentId('resume-empty-initial')
    const seededA = createUserMessage({ content: 'resumed seed A' })
    const seededB = createUserMessage({ content: 'resumed seed B' })
    recordSidechainCalls = []
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'working' })
    }

    for await (const _message of startAgent(createAppStateHarness(), {
      promptMessages: [seededA, seededB],
      seededMessagesForPersistence: [seededA, seededB],
      override: {
        systemPrompt: ['fixture prompt'] as never,
        userContext: {},
        systemContext: {},
        agentId,
      },
    })) {
      // drain
    }

    const persistedReplay = callForAgent(agentId, 0)
    expect(persistedReplay?.messages).toHaveLength(0)
    expect(persistedReplay?.startingParentUuid).toBe(seededB.uuid)

    const continuationReplay = callForAgent(agentId, 1)
    expect(continuationReplay?.startingParentUuid).toBe(seededB.uuid)
  })

  test('persists same-destination resume continuations once and keeps their chain reachable', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'run-agent-resume-cfg-'))
    const sessionDir = mkdtempSync(join(tmpdir(), 'run-agent-resume-session-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    const agentId = createAgentId('durable-resume-continuity')
    const seededA = createUserMessage({ content: 'historical seed A' })
    const seededB = createUserMessage({ content: 'historical seed B' })
    const firstAssistant = createAssistantMessage({ content: 'first output' })
    const resumeInstruction = createUserMessage({ content: 'resume instruction' })
    const resumedAssistant = createAssistantMessage({
      content: 'resumed output',
    })
    const secondInstruction = createUserMessage({
      content: 'second continuation',
    })
    const secondAssistant = createAssistantMessage({
      content: 'second output',
    })
    const queryOutputs = [firstAssistant, resumedAssistant, secondAssistant]
    let queryOutputIndex = 0

    const run = async (
      promptMessages: Message[],
      seededMessagesForPersistence?: Message[],
    ) => {
      queryScript = async function* () {
        yield queryOutputs[queryOutputIndex++]!
      }
      for await (const _message of startAgent(createAppStateHarness(), {
        promptMessages,
        seededMessagesForPersistence,
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
      clearSessionMessagesCache()
      return (await getAgentTranscript(agentId))!
    }

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
      resetProjectForTesting()
      switchSession(asSessionId(randomUUID()), sessionDir)
      clearSessionMessagesCache()
      recordSidechainCalls = []

      const firstTranscript = await run([seededA, seededB])
      expect(firstTranscript.messages.map(message => message.uuid)).toEqual([
        seededA.uuid,
        seededB.uuid,
        firstAssistant.uuid,
      ])

      const resumeTranscript = await run(
        [...firstTranscript.messages, resumeInstruction],
        firstTranscript.messages,
      )
      expect(resumeTranscript.messages.map(message => message.uuid)).toEqual([
        seededA.uuid,
        seededB.uuid,
        firstAssistant.uuid,
        resumeInstruction.uuid,
        resumedAssistant.uuid,
      ])

      const secondTranscript = await run(
        [...resumeTranscript.messages, secondInstruction],
        resumeTranscript.messages,
      )
      expect(secondTranscript.messages.map(message => message.uuid)).toEqual([
        seededA.uuid,
        seededB.uuid,
        firstAssistant.uuid,
        resumeInstruction.uuid,
        resumedAssistant.uuid,
        secondInstruction.uuid,
        secondAssistant.uuid,
      ])

      const rawEntries = (await readFile(
        getAgentTranscriptPath(agentId),
        'utf8',
      ))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
          uuid?: string
          parentUuid?: string | null
        })
      const uuidOccurrences = (uuid: string) =>
        rawEntries.filter(entry => entry.uuid === uuid)

      for (const message of [
        seededA,
        seededB,
        firstAssistant,
        resumeInstruction,
        resumedAssistant,
        secondInstruction,
        secondAssistant,
      ]) {
        expect(uuidOccurrences(message.uuid)).toHaveLength(1)
      }
      expect(
        uuidOccurrences(resumeInstruction.uuid)[0]?.parentUuid,
      ).toBe(firstAssistant.uuid)
      expect(uuidOccurrences(resumedAssistant.uuid)[0]?.parentUuid).toBe(
        resumeInstruction.uuid,
      )
      expect(
        secondTranscript.messages.some(
          message => message.uuid === resumedAssistant.uuid,
        ),
      ).toBe(true)
      expect(uuidOccurrences(secondInstruction.uuid)[0]?.parentUuid).toBe(
        resumedAssistant.uuid,
      )
      expect(uuidOccurrences(secondAssistant.uuid)[0]?.parentUuid).toBe(
        secondInstruction.uuid,
      )
    } finally {
      clearSessionMessagesCache()
      resetProjectForTesting()
      switchSession(asSessionId('session-run-agent-resume'), tempDir)
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

describe('runAgent MCP generation handed to the subagent', () => {
  let tempDir: string

  const staleClient = { name: 'stale-server', type: 'pending' }
  const liveClient = { name: 'cua-driver', type: 'connected' }
  const liveResource = { uri: 'file://demo', name: 'demo' }
  const baseCommand = { name: 'base-command', isMcp: false }
  const staleMcpCommand = { name: 'stale-command', isMcp: true }
  const staleMcpSkill = { name: 'stale-skill', loadedFrom: 'mcp' }
  const liveMcpCommand = { name: 'live-command', isMcp: true }
  const liveTool = {
    name: 'mcp__cua-driver__click',
    mcpInfo: { serverName: 'cua-driver', toolName: 'click' },
  }
  const liveSnapshot = {
    clients: [liveClient],
    tools: [liveTool],
    commands: [liveMcpCommand],
    resources: { 'cua-driver': [liveResource] },
  } as never

  beforeEach(() => {
    resetStateForTests()
    resetWorkerNamesForTests()
    lastQueryToolUseContext = undefined
    queryScript = async function* () {
      yield createAssistantMessage({ content: 'done' })
    }
    tempDir = mkdtempSync(join(tmpdir(), 'run-agent-mcp-'))
    switchSession(asSessionId('session-run-agent-mcp'), tempDir)
  })

  afterEach(() => {
    resetWorkerNamesForTests()
    resetStateForTests()
  })

  async function drain(
    harness: ReturnType<typeof createAppStateHarness>,
    parentOptions: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const toolUseContext = createParentContext(harness)
    Object.assign(toolUseContext.options, parentOptions)
    for await (const _message of runAgent({
      agentDefinition: AGENT,
      promptMessages: [],
      toolUseContext,
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
    })) {
      // drain
    }
    return lastQueryToolUseContext!
  }

  test('a caller-supplied snapshot wins over the parent options', async () => {
    // AgentTool reads this snapshot after waiting for a required server, so
    // the subagent launched in that same iteration must start from it. Falling
    // back to options.mcpClients would hand it the turn-start clients, which
    // is exactly the server it just finished waiting for.
    const context = await drain(
      createAppStateHarness(),
      {
        commands: [baseCommand, staleMcpCommand, staleMcpSkill],
        mcpClients: [staleClient],
        mcpResources: {},
      },
      {
        availableTools: [liveTool],
        mcpRuntimeSnapshot: liveSnapshot,
      },
    )

    expect(context.options.tools).toEqual([liveTool] as never)
    expect(context.options.commands).toEqual([
      baseCommand,
      liveMcpCommand,
    ] as never)
    expect(context.options.mcpClients).toEqual([liveClient] as never)
    expect(context.options.mcpResources).toEqual({
      'cua-driver': [liveResource],
    } as never)
  })

  test('with no snapshot passed, the live source is read at launch', async () => {
    let reads = 0
    const context = await drain(createAppStateHarness(), {
      commands: [baseCommand, staleMcpCommand, staleMcpSkill],
      mcpClients: [staleClient],
      mcpResources: {},
      getMcpRuntimeSnapshot: () => {
        reads++
        return liveSnapshot
      },
    })

    expect(reads).toBe(1)
    expect(context.options.commands).toEqual([
      baseCommand,
      liveMcpCommand,
    ] as never)
    expect(context.options.mcpClients).toEqual([liveClient] as never)
    expect(context.options.mcpResources).toEqual({
      'cua-driver': [liveResource],
    } as never)
  })

  test('an assembled runtime is passed through without another snapshot read', async () => {
    let reads = 0
    const context = await drain(
      createAppStateHarness(),
      {
        commands: [baseCommand, staleMcpCommand, staleMcpSkill],
        mcpClients: [staleClient],
        mcpResources: {},
        getMcpRuntimeSnapshot: () => {
          reads++
          return liveSnapshot
        },
      },
      {
        availableTools: [liveTool],
        mcpRuntimeInputs: {
          tools: [liveTool],
          commands: [baseCommand, liveMcpCommand],
          mcpClients: [liveClient],
          mcpResources: { 'cua-driver': [liveResource] },
        },
      },
    )

    expect(reads).toBe(0)
    expect(context.options.tools).toEqual([liveTool] as never)
    expect(context.options.commands).toEqual([
      baseCommand,
      liveMcpCommand,
    ] as never)
    expect(context.options.mcpClients).toEqual([liveClient] as never)
    expect(context.options.mcpResources).toEqual({
      'cua-driver': [liveResource],
    } as never)
  })

  test('refreshes each MCP runtime field together between child query iterations', async () => {
    const replacementClient = { name: 'replacement-server', type: 'connected' }
    const replacementTool = {
      name: 'mcp__replacement-server__act',
      mcpInfo: { serverName: 'replacement-server', toolName: 'act' },
    }
    const replacementCommand = { name: 'replacement-command', isMcp: true }
    const replacementResource = { uri: 'file://replacement', name: 'replacement' }
    const replacementSnapshot = {
      clients: [replacementClient],
      tools: [replacementTool],
      commands: [replacementCommand],
      resources: { 'replacement-server': [replacementResource] },
    } as never
    const observed: Array<{
      tools: unknown
      commands: unknown
      clients: unknown
      resources: unknown
    }> = []

    queryScript = async function* (context) {
      if (!context) throw new Error('runAgent did not create a child context')
      observed.push({
        tools: context.options.tools,
        commands: context.options.commands,
        clients: context.options.mcpClients,
        resources: context.options.mcpResources,
      })
      const refreshed = context.options.refreshMcpRuntime?.()
      if (!refreshed) throw new Error('runAgent did not install MCP refresh')
      Object.assign(context.options, refreshed)
      observed.push({
        tools: context.options.tools,
        commands: context.options.commands,
        clients: context.options.mcpClients,
        resources: context.options.mcpResources,
      })
      yield createAssistantMessage({ content: 'done' })
    }

    await drain(
      createAppStateHarness(),
      {
        commands: [baseCommand, liveMcpCommand],
        mcpClients: [liveClient],
        mcpResources: { 'cua-driver': [liveResource] },
        getMcpRuntimeSnapshot: () => replacementSnapshot,
      },
      {
        availableTools: [liveTool],
        mcpRuntimeSnapshot: liveSnapshot,
      },
    )

    expect(observed).toEqual([
      {
        tools: [liveTool],
        commands: [baseCommand, liveMcpCommand],
        clients: [liveClient],
        resources: { 'cua-driver': [liveResource] },
      },
      {
        tools: [replacementTool],
        commands: [baseCommand, replacementCommand],
        clients: [replacementClient],
        resources: { 'replacement-server': [replacementResource] },
      },
    ])
  })

  test('a static parent still passes its own clients and resources through', async () => {
    const parentResources = { 'stale-server': [liveResource] }
    const context = await drain(createAppStateHarness(), {
      commands: [baseCommand],
      mcpClients: [staleClient],
      mcpResources: parentResources,
    })

    expect(context.options.commands).toEqual([])
    expect(context.options.mcpClients).toEqual([staleClient] as never)
    expect(context.options.mcpResources).toBe(parentResources as never)
  })
})
