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
import { mkdtempSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  resetStateForTests,
  switchSession,
} from '../../bootstrap/state.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId, asSessionId } from '../../types/ids.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../Tool.js'
import {
  getAgentTranscriptPath,
  getTranscriptPath,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import * as diskOutput from '../../utils/task/diskOutput.js'
import * as agentToolUtils from './agentToolUtils.js'
import {
  _resetAgentLifecycleOwnershipForTest,
  runWithAgentLifecycleOwnership,
} from './agentLifecycleOwnership.js'
import {
  AgentResumeInProgressError,
  resumeAgentBackground,
  TranscriptNotFoundError,
} from './resumeAgent.js'
import { FORK_AGENT } from './forkSubagent.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('resumeAgentBackground', () => {
  const originalCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  let tempDir: string
  let runAsyncAgentLifecycle: ReturnType<typeof spyOn>
  let registerAsyncAgent: ReturnType<typeof spyOn>
  let getTaskOutputPath: ReturnType<typeof spyOn>

  beforeEach(async () => {
    _resetAgentLifecycleOwnershipForTest()
    resetStateForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'resume-agent-'))
    switchSession(asSessionId('session-resume'), tempDir)
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE

    await writeAgentTranscript('agent-resume')
    await writeAgentMetadata(asAgentId('agent-resume'), {
      agentType: 'general-purpose',
      description: 'Continue current objective',
    })

    runAsyncAgentLifecycle = spyOn(
      agentToolUtils,
      'runAsyncAgentLifecycle',
    ).mockImplementation(mock(async () => {}) as never)
    registerAsyncAgent = spyOn(
      localAgentTask,
      'registerAsyncAgent',
    ).mockImplementation(
      mock(({ agentId }) => ({
        agentId,
        abortController: new AbortController(),
      })) as never,
    )
    getTaskOutputPath = spyOn(
      diskOutput,
      'getTaskOutputPath',
    ).mockImplementation(
      mock(taskId => join(tempDir, 'tasks', `${taskId}.output`)) as never,
    )
  })

  afterEach(async () => {
    _resetAgentLifecycleOwnershipForTest()
    await diskOutput._clearOutputsForTest()
    diskOutput._resetTaskOutputDirForTest()
    mock.restore()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    restoreEnv('CLAUDE_CODE_COORDINATOR_MODE', originalCoordinatorMode)
    await rm(tempDir, { recursive: true, force: true })
  })

  test('resumes onto the async lifecycle and records the spawn on the parent transcript', async () => {
    await resumeAgentBackground({
      agentId: 'agent-resume',
      prompt: 'continue',
      canUseTool: (() => undefined) as never,
      toolUseContext: createToolUseContext(),
    })

    expect(registerAsyncAgent).toHaveBeenCalledTimes(1)
    expect(getTaskOutputPath).toHaveBeenCalledWith('agent-resume')
    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
    expect(runAsyncAgentLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-resume',
        parentTranscriptPath: getTranscriptPath(),
        // Durable worker state is coordinator-only, so an ordinary session
        // resumes without any tracking to thread through.
        sessionStateTracking: undefined,
      }),
    )
    const parentTranscript = await readFile(getTranscriptPath(), 'utf-8')
    expect(parentTranscript).toContain('"type":"subagent-spawned"')
    expect(parentTranscript).toContain('"toolUseId":"toolu-resume"')
    expect(parentTranscript).toContain('"agentId":"agent-resume"')
  })

  test('keeps exact parent MCP inputs when resuming a fork', async () => {
    await writeAgentMetadata(asAgentId('agent-resume'), {
      agentType: FORK_AGENT.agentType,
      description: 'Continue current objective',
    })
    const parentTools = [{ name: 'parent-tool' }]
    const parentCommands = [{ name: 'parent-command' }]
    const parentClients = [{ name: 'parent-server', type: 'connected' }]
    const parentResources = {
      'parent-server': [{ uri: 'file://parent', name: 'parent' }],
    }
    const context = createToolUseContext() as unknown as ToolUseContext
    context.renderedSystemPrompt = ['parent prompt'] as never
    let snapshotReads = 0
    Object.assign(context.options, {
      tools: parentTools,
      commands: parentCommands,
      mcpClients: parentClients,
      mcpResources: parentResources,
      getMcpRuntimeSnapshot: () => {
        snapshotReads++
        return {
          tools: [{ name: 'new-tool' }],
          commands: [{ name: 'new-command' }],
          clients: [{ name: 'new-server', type: 'connected' }],
          resources: {},
        } as never
      },
    })
    let childContext: ToolUseContext | undefined
    runAsyncAgentLifecycle.mockImplementation(
      mock(async ({ makeStream }) => {
        const stream = makeStream(({ toolUseContext }) => {
          childContext = toolUseContext
          throw new Error('stop after capturing child context')
        })
        await expect(stream.next()).rejects.toThrow(
          'stop after capturing child context',
        )
      }) as never,
    )

    await resumeAgentBackground({
      agentId: 'agent-resume',
      prompt: 'continue',
      canUseTool: (() => undefined) as never,
      toolUseContext: context,
    })

    expect(snapshotReads).toBe(0)
    expect(childContext?.options.tools).toBe(parentTools)
    expect(childContext?.options.commands).toEqual(parentCommands)
    expect(childContext?.options.mcpClients).toEqual(parentClients)
    expect(childContext?.options.mcpResources).toEqual(parentResources)
  })

  test('holds lifecycle ownership until the detached background run settles, not just through setup', async () => {
    const lifecycle = deferred<void>()
    runAsyncAgentLifecycle.mockImplementation(
      mock(() => lifecycle.promise) as never,
    )
    const resume = () =>
      resumeAgentBackground({
        agentId: 'agent-resume',
        prompt: 'continue',
        canUseTool: (() => undefined) as never,
        toolUseContext: createToolUseContext(),
      })

    await expect(resume()).resolves.toMatchObject({ agentId: 'agent-resume' })
    // Setup for the first call already finished (the promise above
    // resolved), but its lifecycle is still pending — ownership must still
    // be held, unlike the old setup-scoped Set.
    await expect(resume()).rejects.toBeInstanceOf(AgentResumeInProgressError)

    lifecycle.resolve()
    await lifecycle.promise
    // Give the ownership-release .then(release, release) chain a turn to run
    // before probing for release.
    await Promise.resolve()
    await Promise.resolve()

    await expect(resume()).resolves.toMatchObject({ agentId: 'agent-resume' })
  })

  test('rejects resume while a non-resume background lifecycle is still finalizing', async () => {
    const finalizationStarted = deferred<void>()
    const finalizationRelease = deferred<void>()
    const priorLifecycle = runWithAgentLifecycleOwnership(
      'agent-resume',
      async () => {
        finalizationStarted.resolve()
        await finalizationRelease.promise
      },
    )
    await finalizationStarted.promise

    await expect(
      resumeAgentBackground({
        agentId: 'agent-resume',
        prompt: 'continue',
        canUseTool: (() => undefined) as never,
        toolUseContext: createToolUseContext(),
      }),
    ).rejects.toBeInstanceOf(AgentResumeInProgressError)
    expect(registerAsyncAgent).not.toHaveBeenCalled()

    finalizationRelease.resolve()
    await priorLifecycle

    await expect(
      resumeAgentBackground({
        agentId: 'agent-resume',
        prompt: 'continue',
        canUseTool: (() => undefined) as never,
        toolUseContext: createToolUseContext(),
      }),
    ).resolves.toMatchObject({ agentId: 'agent-resume' })
  })

  test('releases lifecycle ownership on setup failure without ever launching a lifecycle', async () => {
    await expect(
      resumeAgentBackground({
        agentId: 'agent-missing-transcript',
        prompt: 'continue',
        canUseTool: (() => undefined) as never,
        toolUseContext: createToolUseContext(),
      }),
    ).rejects.toBeInstanceOf(TranscriptNotFoundError)

    expect(runAsyncAgentLifecycle).not.toHaveBeenCalled()

    // If ownership had leaked, this second call for the same agentId would
    // reject with AgentResumeInProgressError instead of reaching (and
    // failing on) the same missing-transcript setup step again.
    await expect(
      resumeAgentBackground({
        agentId: 'agent-missing-transcript',
        prompt: 'continue',
        canUseTool: (() => undefined) as never,
        toolUseContext: createToolUseContext(),
      }),
    ).rejects.toBeInstanceOf(TranscriptNotFoundError)
  })

  test('releases lifecycle ownership when the detached lifecycle rejects, without an unhandled rejection', async () => {
    const rejecting = deferred<void>()
    runAsyncAgentLifecycle.mockImplementation(
      mock(() => rejecting.promise) as never,
    )

    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      await expect(
        resumeAgentBackground({
          agentId: 'agent-resume',
          prompt: 'continue',
          canUseTool: (() => undefined) as never,
          toolUseContext: createToolUseContext(),
        }),
      ).resolves.toMatchObject({ agentId: 'agent-resume' })

      rejecting.reject(new Error('lifecycle blew up'))
      await rejecting.promise.catch(() => {})
      await Promise.resolve()
      await Promise.resolve()

      await expect(
        resumeAgentBackground({
          agentId: 'agent-resume',
          prompt: 'continue',
          canUseTool: (() => undefined) as never,
          toolUseContext: createToolUseContext(),
        }),
      ).resolves.toMatchObject({ agentId: 'agent-resume' })

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

async function writeAgentTranscript(agentId: string): Promise<void> {
  const transcriptPath = getAgentTranscriptPath(asAgentId(agentId))
  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        isSidechain: true,
        sessionId: getSessionId(),
        agentId,
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'continue' },
      }),
      '',
    ].join('\n'),
    'utf-8',
  )
}

function createToolUseContext() {
  let state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: 'acceptEdits',
    },
    mcp: { tools: [] },
    tasks: {},
    agent: undefined,
    agentDefinitions: { activeAgents: [] },
  }

  return {
    toolUseId: 'toolu-resume',
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
      mainLoopModel: 'gpt-5.6-luna',
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
    },
  } as never
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
