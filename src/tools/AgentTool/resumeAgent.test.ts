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
import { getSessionStatePathFromTranscriptPath } from '../../agent-mode/sessionState.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId, asSessionId } from '../../types/ids.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  getAgentTranscriptPath,
  getTranscriptPath,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import * as diskOutput from '../../utils/task/diskOutput.js'
import * as agentToolUtils from './agentToolUtils.js'
import { resumeAgentBackground } from './resumeAgent.js'

describe('resumeAgentBackground', () => {
  const originalAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
  const originalCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  let tempDir: string
  let runAsyncAgentLifecycle: ReturnType<typeof spyOn>
  let registerAsyncAgent: ReturnType<typeof spyOn>
  let getTaskOutputPath: ReturnType<typeof spyOn>

  beforeEach(async () => {
    resetStateForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'resume-agent-'))
    switchSession(asSessionId('session-resume'), tempDir)
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
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
    await diskOutput._clearOutputsForTest()
    diskOutput._resetTaskOutputDirForTest()
    mock.restore()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    restoreEnv('CLAUDE_CODE_AGENT_MODE', originalAgentMode)
    restoreEnv('CLAUDE_CODE_COORDINATOR_MODE', originalCoordinatorMode)
    await rm(tempDir, { recursive: true, force: true })
  })

  test('passes Agent Mode session state tracking into the async lifecycle', async () => {
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
        sessionStateTracking: {
          sessionId: 'session-resume',
          mode: 'agent',
          objective: 'Continue current objective',
          statePath: getSessionStatePathFromTranscriptPath(getTranscriptPath()),
        },
      }),
    )
    const parentTranscript = await readFile(getTranscriptPath(), 'utf-8')
    expect(parentTranscript).toContain('"type":"subagent-spawned"')
    expect(parentTranscript).toContain('"toolUseId":"toolu-resume"')
    expect(parentTranscript).toContain('"agentId":"agent-resume"')
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
      mainLoopModel: 'gpt-5.3-codex',
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
