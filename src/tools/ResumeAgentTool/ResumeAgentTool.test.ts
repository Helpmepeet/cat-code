import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import {
  getAgentTranscriptPath,
  getTranscriptPathForSession,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { createAgentId } from '../../utils/uuid.js'
import * as agentToolUtils from '../AgentTool/agentToolUtils.js'
import { FORK_AGENT } from '../AgentTool/forkSubagent.js'
import * as resumeAgentModule from '../AgentTool/resumeAgent.js'
import * as resolveAgentTargetModule from '../AgentTool/resolveAgentTarget.js'
import type { ResolvedAgentTarget } from '../AgentTool/resolveAgentTarget.js'
import {
  ResumeAgentTool,
  type Output as ResumeAgentToolOutput,
} from './ResumeAgentTool.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const createdFiles: string[] = []

function getSessionStatePath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId).replace(
    /\.jsonl$/,
    '.worker-state.json',
  )
}

function writeSessionState(sessionId: string, state: unknown): void {
  const path = getSessionStatePath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

function writeAgentTranscript(
  agentId: string,
  sessionId = getSessionId(),
  projectDir = getSessionProjectDir(),
): void {
  const path =
    sessionId === getSessionId()
      ? getAgentTranscriptPath(asAgentId(agentId))
      : join(projectDir!, sessionId, 'subagents', `agent-${agentId}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  const userUuid = randomUUID()
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        isSidechain: true,
        sessionId,
        agentId,
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'continue' },
      }),
      '',
    ].join('\n'),
    'utf-8',
  )
  createdFiles.push(path)
}

function writeAgentTranscriptWithUsage({
  agentId,
  model,
  inputTokens,
  outputTokens,
}: {
  agentId: string
  model: string
  inputTokens: number
  outputTokens: number
}): void {
  const path = getAgentTranscriptPath(asAgentId(agentId))
  mkdirSync(dirname(path), { recursive: true })
  const userUuid = randomUUID()
  const assistantUuid = randomUUID()
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        isSidechain: true,
        sessionId: getSessionId(),
        agentId,
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'continue' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: true,
        sessionId: getSessionId(),
        agentId,
        timestamp: '2026-05-01T00:00:01.000Z',
        message: {
          id: `msg-${assistantUuid}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'prior result' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf-8',
  )
  createdFiles.push(path)
}

function createToolUseContext(initialState?: Record<string, unknown>) {
  let state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: 'acceptEdits',
    },
    mcp: { tools: [] },
    tasks: {},
    agentNameRegistry: new Map(),
    agent: undefined,
    agentDefinitions: { activeAgents: [] },
    ...initialState,
  }

  const context = {
    toolUseId: 'toolu-resume-agent',
    contentReplacementState: {},
    renderedSystemPrompt: undefined,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    getAppState: () => state,
    options: {
      agentDefinitions: { activeAgents: [] },
      tools: [],
      mcpClients: [],
      mcpResources: {},
      commands: [],
      debug: false,
      verbose: false,
      thinkingConfig: {},
      isNonInteractiveSession: false,
      mainLoopModel: 'gpt-5.6-luna',
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
    },
    abortController: new AbortController(),
  } as never

  return {
    context,
    getState: () => state,
  }
}

describe('ResumeAgentTool', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resume-agent-tool-'))
    sessionId = randomUUID()
    switchSession(sessionId, tempDir)
  })

  afterEach(() => {
    mock.restore()
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()
      if (file) rmSync(file, { force: true })
    }
    rmSync(tempDir, { recursive: true, force: true })
    switchSession(originalSessionId, originalProjectDir)
  })

  test('resumes a stopped subagent in the background', async () => {
    const resumeAgentBackground = spyOn(
      resumeAgentModule,
      'resumeAgentBackground',
    ).mockImplementation(mock(async () => ({
      agentId: 'agent-stopped',
      description: 'Stopped worker',
      outputFile: join(tempDir, 'output.txt'),
    })) as never)
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', 'agent-stopped']]),
      tasks: {
        'agent-stopped': {
          id: 'agent-stopped',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-stopped',
          agentType: 'general-purpose',
        },
      },
    })

    const result = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-1' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledTimes(1)
    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-stopped',
        prompt: 'continue',
        sourceSessionId: sessionId,
        toolUseContext: context,
        invokingRequestId: 'req-1',
      }),
    )
    expect(result).toEqual({
      data: {
        success: true,
        message: 'Resumed "@worker-one" in the background.',
      },
    })
  })

  test('resolves durable current-session handles', async () => {
    const resumeAgentBackground = spyOn(
      resumeAgentModule,
      'resumeAgentBackground',
    ).mockImplementation(mock(async () => ({
      agentId: 'agent-current',
      description: 'Current worker',
      outputFile: join(tempDir, 'output.txt'),
    })) as never)
    writeSessionState(sessionId, {
      sessionId,
      mode: 'coordinator',
      activeWorkers: {},
      knownWorkers: {
        'agent-current': {
          agentId: 'agent-current',
          role: 'explorer',
          description: 'Current durable worker',
          status: 'completed',
          worktreePath: null,
          handle: 'explore-current',
        },
      },
    })
    const { context } = createToolUseContext()

    await ResumeAgentTool.call(
      { agentId: 'explore-current', prompt: 'continue durable' },
      context,
      undefined as never,
      { requestId: 'req-current' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-current',
        sourceSessionId: sessionId,
      }),
    )
  })

  test('returns not found for unresolved targets', async () => {
    const { context } = createToolUseContext()

    const result = await ResumeAgentTool.call(
      { agentId: 'missing-worker', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-missing' } as never,
    )

    expect(result.data).toEqual({
      success: false,
      message:
        'No subagent found for "missing-worker". Check the agentId or call Agent to spawn a new one.',
    })
  })

  test('returns already-running error for running subagents', async () => {
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', 'agent-running']]),
      tasks: {
        'agent-running': {
          id: 'agent-running',
          type: 'local_agent',
          status: 'running',
          agentId: 'agent-running',
          agentType: 'general-purpose',
        },
      },
    })

    const result = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-running' } as never,
    )

    expect(result.data.message).toBe(
      'Agent "@worker-one" is already running; resume is not needed. Any message you send via SendMessage will queue automatically for this worker execution.',
    )
  })

  test('uses typed transcript-missing error for cleaned-up transcripts', async () => {
    spyOn(resumeAgentModule, 'resumeAgentBackground').mockImplementation(
      mock(async ({ agentId }) => {
        throw new resumeAgentModule.TranscriptNotFoundError(agentId)
      }) as never,
    )
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', 'agent-cleaned']]),
      tasks: {
        'agent-cleaned': {
          id: 'agent-cleaned',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-cleaned',
          agentType: 'general-purpose',
        },
      },
    })

    const result = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-cleaned' } as never,
    )

    expect(result.data.message).toBe(
      'Agent "@worker-one" has no transcript to resume; it may have been cleaned up. Spawn a new agent with Agent.',
    )
  })

  test('returns generic resume failure for other errors', async () => {
    spyOn(resumeAgentModule, 'resumeAgentBackground').mockImplementation(
      mock(async () => {
        throw new Error('boom')
      }) as never,
    )
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', 'agent-fails']]),
      tasks: {
        'agent-fails': {
          id: 'agent-fails',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-fails',
          agentType: 'general-purpose',
        },
      },
    })

    const result = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-fails' } as never,
    )

    expect(result.data.message).toBe('Failed to resume "@worker-one": boom')
  })

  test('passes fork-capable context through to resumeAgentBackground', async () => {
    const renderedSystemPrompt = asSystemPrompt(['parent prompt'])
    const resumeAgentBackground = spyOn(
      resumeAgentModule,
      'resumeAgentBackground',
    ).mockImplementation(mock(async () => ({
      agentId: 'agent-fork',
      description: 'Fork worker',
      outputFile: join(tempDir, 'output.txt'),
    })) as never)
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['fork-one', 'agent-fork']]),
      tasks: {
        'agent-fork': {
          id: 'agent-fork',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-fork',
          agentType: FORK_AGENT.agentType,
        },
      },
    })
    ;(context as { renderedSystemPrompt?: typeof renderedSystemPrompt }).renderedSystemPrompt =
      renderedSystemPrompt

    await ResumeAgentTool.call(
      { agentId: 'fork-one', prompt: 'resume fork' },
      context,
      undefined as never,
      { requestId: 'req-fork' } as never,
    )

    expect(resumeAgentBackground.mock.calls[0]?.[0].toolUseContext).toBe(context)
    expect(
      resumeAgentBackground.mock.calls[0]?.[0].toolUseContext.renderedSystemPrompt,
    ).toBe(renderedSystemPrompt)
  })

  test('concurrent double resume calls only schedule one background run', async () => {
    const runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    const agentId = createAgentId()
    writeAgentTranscript(agentId)
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Race worker',
    })
    const { context, getState } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', agentId]]),
      tasks: {
        [agentId]: {
          id: agentId,
          type: 'local_agent',
          status: 'completed',
          agentId,
          agentType: 'general-purpose',
        },
      },
    })

    const results = await Promise.all([
      ResumeAgentTool.call(
        { agentId: 'worker-one', prompt: 'first' },
        context,
        undefined as never,
        { requestId: 'req-race-1' } as never,
      ),
      ResumeAgentTool.call(
        { agentId: 'worker-one', prompt: 'second' },
        context,
        undefined as never,
        { requestId: 'req-race-2' } as never,
      ),
    ])

    const successfulPrompt = results[0].data.success ? 'first' : 'second'
    expect(results.filter(result => result.data.success)).toHaveLength(1)
    expect(results.filter(result => !result.data.success)).toHaveLength(1)
    expect(results.find(result => !result.data.success)?.data.message).toContain(
      'already running',
    )
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
    expect(getState().tasks[agentId].status).toBe('running')
    expect(getState().tasks[agentId].prompt).toBe(successfulPrompt)
  })

  test('a call whose resolution is still in flight re-reads state before acting, losing to a faster resume', async () => {
    const runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    const agentId = createAgentId()
    writeAgentTranscript(agentId)
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Race worker',
    })
    const { context, getState } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', agentId]]),
      tasks: {
        [agentId]: {
          id: agentId,
          type: 'local_agent',
          status: 'completed',
          agentId,
          agentType: 'general-purpose',
        },
      },
    })

    // Call B's target resolution is held open behind a deferred promise (a
    // barrier, never a timer) so call A can run resolution + resume to
    // completion and register running state first. B is released only
    // afterward, and must then re-read fresh state — not act on the
    // 'completed' snapshot that existed when B's resolution began — to
    // correctly detect that the target is now running.
    const resolveGate = deferred<ResolvedAgentTarget | null>()
    const realResolveAgentTarget = resolveAgentTargetModule.resolveAgentTarget
    let resolveCalls = 0
    const resolveSpy = spyOn(
      resolveAgentTargetModule,
      'resolveAgentTarget',
    ).mockImplementation(
      mock(async args => {
        resolveCalls++
        if (resolveCalls === 1) return resolveGate.promise
        return realResolveAgentTarget(args)
      }) as never,
    )

    const bPromise = ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'B' },
      context,
      undefined as never,
      { requestId: 'req-race-b' } as never,
    )

    const aResult = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'A' },
      context,
      undefined as never,
      { requestId: 'req-race-a' } as never,
    )
    expect(aResult.data.success).toBe(true)
    expect(getState().tasks[agentId].status).toBe('running')

    resolveGate.resolve(
      await realResolveAgentTarget({
        input: 'worker-one',
        appState: getState(),
        sessionId: getSessionId(),
      }),
    )
    const bResult = await bPromise

    expect(bResult.data.success).toBe(false)
    expect(bResult.data.message).toContain('already running')
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
    expect(resolveSpy).toHaveBeenCalledTimes(2)
  })

  test('resumes an evicted task from an on-disk transcript', async () => {
    const runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    const agentId = createAgentId()
    writeAgentTranscript(agentId)
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Evicted worker',
    })
    const { context, getState } = createToolUseContext()

    const result = await ResumeAgentTool.call(
      { agentId, prompt: 'resume evicted' },
      context,
      undefined as never,
      { requestId: 'req-evicted' } as never,
    )

    expect(result.data).toEqual({
      success: true,
      message: 'Resumed "Evicted worker" in the background.',
    })
    expect(getState().tasks[agentId].status).toBe('running')
    expect(getState().tasks[agentId].prompt).toBe('resume evicted')
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
    expect(readFileSync(getTranscriptPathForSession(sessionId), 'utf-8')).toContain(
      '"type":"subagent-spawned"',
    )
  })

  test('reports resumed context against the model window without post-action advice', async () => {
    const runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    const agentId = createAgentId()
    writeAgentTranscriptWithUsage({
      agentId,
      model: 'claude-3-haiku',
      inputTokens: 52_000,
      outputTokens: 1_000,
    })
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Context worker',
    })
    const { context } = createToolUseContext()

    const result = await ResumeAgentTool.call(
      { agentId, prompt: 'resume with context' },
      context,
      undefined as never,
      { requestId: 'req-context' } as never,
    )

    expect(result.data).toEqual({
      success: true,
      message:
        'Resumed "Context worker" in the background. Previous context: ~53k / 200k tokens (27%).',
    })
    expect(result.data.message).not.toContain('fresh agent may be cheaper')
    expect(result.data.message).not.toContain('last checkpoint')
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
  })

  test('preserves pending messages when replacing an in-state task', async () => {
    const runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    const agentId = createAgentId()
    writeAgentTranscript(agentId)
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Pending worker',
    })
    const { context, getState } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', agentId]]),
      tasks: {
        [agentId]: {
          id: agentId,
          type: 'local_agent',
          status: 'completed',
          agentId,
          prompt: 'old prompt',
          description: 'Pending worker',
          agentType: 'general-purpose',
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          isBackgrounded: true,
          pendingMessages: [
            {
              id: 'queued-1',
              message: 'queued-1',
              status: 'pending',
              acceptedAt: 1,
            },
            {
              id: 'queued-2',
              message: 'queued-2',
              status: 'pending',
              acceptedAt: 2,
            },
          ],
          retain: false,
          diskLoaded: false,
        },
      },
    })

    const result = await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'resume now' },
      context,
      undefined as never,
      { requestId: 'req-pending' } as never,
    )

    expect(result.data).toEqual({
      success: true,
      message: 'Resumed "@worker-one" in the background.',
    })
    expect(getState().tasks[agentId].pendingMessages).toEqual([
      {
        id: 'queued-1',
        message: 'queued-1',
        status: 'pending',
        acceptedAt: 1,
      },
      {
        id: 'queued-2',
        message: 'queued-2',
        status: 'pending',
        acceptedAt: 2,
      },
    ])
    expect(getState().tasks[agentId].status).toBe('running')
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
  })

  test('success means scheduling succeeded, not lifecycle completion', async () => {
    spyOn(resumeAgentModule, 'resumeAgentBackground').mockImplementation(
      mock(async () => ({
        agentId: 'agent-lifecycle',
        description: 'Lifecycle worker',
        outputFile: join(tempDir, 'output.txt'),
      })) as never,
    )
    const { context } = createToolUseContext({
      agentNameRegistry: new Map([['worker-one', 'agent-lifecycle']]),
      tasks: {
        'agent-lifecycle': {
          id: 'agent-lifecycle',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-lifecycle',
          agentType: 'general-purpose',
        },
      },
    })

    const result = (await ResumeAgentTool.call(
      { agentId: 'worker-one', prompt: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-lifecycle' } as never,
    )) as { data: ResumeAgentToolOutput }

    expect(result.data).toEqual({
      success: true,
      message: 'Resumed "@worker-one" in the background.',
    })
  })
})
