import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { isDeferredTool } from '../ToolSearchTool/prompt.js'
import * as resumeAgentModule from '../AgentTool/resumeAgent.js'
import { SendMessageTool } from './SendMessageTool.js'

let resumeAgentBackground: ReturnType<typeof spyOn>

const createdFiles: string[] = []

function getSessionStatePath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId).replace(
    /\.jsonl$/,
    '.agent-mode-state.json',
  )
}

function writeSessionState(sessionId: string, state: unknown): void {
  const path = getSessionStatePath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

function writePriorSessionState(
  projectDir: string,
  sessionId: string,
  state: unknown,
): void {
  const path = join(projectDir, `${sessionId}.agent-mode-state.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

function writePriorAgentTranscript(
  projectDir: string,
  sessionId: string,
  agentId: string,
): void {
  const path = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
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
        sessionId,
        agentId,
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'continue' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: true,
        sessionId,
        agentId,
        timestamp: '2026-05-01T00:00:01.000Z',
        message: {
          id: `msg-${assistantUuid}`,
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.3-codex',
          content: [{ type: 'text', text: 'prior result' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
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

describe('SendMessageTool durable worker handle fallback', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
  const originalAgentTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  let tempDir: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'send-message-tool-'))
    const sessionId = randomUUID()
    switchSession(sessionId, tempDir)

    writeSessionState(sessionId, {
      sessionId,
      mode: 'agent',
      objective: 'Follow-up durable handle resume test',
      activeWorkers: {},
      knownWorkers: {
        'agent-persistent': {
          agentId: 'agent-persistent',
          role: 'explorer',
          description: 'Explore target topic',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-1',
        },
      },
    })

    resumeAgentBackground = spyOn(
      resumeAgentModule,
      'resumeAgentBackground',
    ).mockImplementation(mock(async () => ({
      agentId: 'agent-persistent',
      description: 'Resumed worker',
      outputFile: join(tempDir, 'agent-output.txt'),
    })) as never)
  })

  afterEach(() => {
    mock.restore()
    if (originalAgentMode === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_MODE
    } else {
      process.env.CLAUDE_CODE_AGENT_MODE = originalAgentMode
    }
    if (originalAgentTeams === undefined) {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    } else {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeams
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()
      if (!file) continue
      rmSync(file, { force: true })
    }
    switchSession(originalSessionId, originalProjectDir)
  })

  test('is enabled in Agent Mode without Agent Teams', () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    expect(SendMessageTool.isEnabled?.()).toBe(true)
  })

  test('is enabled in normal sessions for subagent resume by id', () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    expect(SendMessageTool.isEnabled?.()).toBe(true)
  })

  test('schema describes resumable subagent targets', () => {
    expect(SendMessageTool.inputSchema.shape.to.description).toContain(
      'subagent raw agent ID',
    )
    expect(SendMessageTool.inputSchema.shape.to.description).toContain(
      'Agent Mode worker handle',
    )
  })

  test('is not deferred in Agent Mode', () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    expect(isDeferredTool(SendMessageTool)).toBe(false)
  })

  test('without Agent Teams rejects teammate-only routes', async () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    await expect(
      SendMessageTool.validateInput?.(
        { to: '*', summary: 'broadcast', message: 'status?' },
        undefined as never,
      ),
    ).resolves.toMatchObject({
      result: false,
      message: 'broadcast messaging requires Agent Teams',
    })

    await expect(
      SendMessageTool.validateInput?.(
        {
          to: 'team-lead',
          message: {
            type: 'shutdown_response',
            request_id: 'req-1',
            approve: true,
          },
        },
        undefined as never,
      ),
    ).resolves.toMatchObject({
      result: false,
      message: 'structured messages require Agent Teams',
    })
  })

  test('without Agent Teams does not fall through to teammate mailbox', async () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
      }),
    } as never

    const result = await SendMessageTool.call(
      { to: 'missing-worker', summary: 'follow up', message: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-0' } as never,
    )

    expect(result).toMatchObject({
      data: {
        success: false,
        message: expect.stringContaining(
          'Without Agent Teams, SendMessage can only target worker handles or agent IDs',
        ),
      },
    })
  })

  test('resolves durable handle to agent id and resumes in background', async () => {
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
      }),
    } as never

    const result = await SendMessageTool.call(
      { to: 'explore-1', summary: 'follow up', message: 'go deeper' },
      context,
      undefined as never,
      { requestId: 'req-1' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledTimes(1)
    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-persistent',
        prompt: 'go deeper',
        sourceSessionId: getSessionId(),
      }),
    )
    expect(result).toMatchObject({
      data: {
        success: true,
        message: expect.stringContaining(
          'Resumed "Resumed worker" in the background.',
        ),
      },
    })
  })

  test('resumes a stopped in-memory local subagent by registered name', async () => {
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map([['worker-one', 'agent-persistent']]),
        tasks: {
          'agent-persistent': {
            id: 'agent-persistent',
            type: 'local_agent',
            status: 'completed',
            agentId: 'agent-persistent',
            agentType: 'general-purpose',
          },
        },
      }),
    } as never

    const result = await SendMessageTool.call(
      { to: 'worker-one', summary: 'follow up', message: 'continue' },
      context,
      undefined as never,
      { requestId: 'req-stopped' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-persistent',
        prompt: 'continue',
        sourceSessionId: getSessionId(),
      }),
    )
    expect(result).toMatchObject({
      data: {
        success: true,
        message: expect.stringContaining('Resumed "Resumed worker" in the background.'),
      },
    })
  })

  test('resolves prior-session worker handles and resumes from the origin session', async () => {
    const freshSessionId = randomUUID()
    const priorSessionId = randomUUID()
    switchSession(freshSessionId, tempDir)

    writePriorSessionState(tempDir, priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Prior follow-up target',
      activeWorkers: {},
      knownWorkers: {
        'agent-prior': {
          agentId: 'agent-prior',
          role: 'explorer',
          description: 'Explore prior topic',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-prior',
        },
      },
    })
    writePriorAgentTranscript(tempDir, priorSessionId, 'agent-prior')

    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
      }),
    } as never

    const result = await SendMessageTool.call(
      {
        to: 'explore-prior',
        summary: 'follow up',
        message: 'continue prior work',
      },
      context,
      undefined as never,
      { requestId: 'req-2' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-prior',
        prompt: 'continue prior work',
        sourceSessionId: priorSessionId,
      }),
    )
    expect(result.data.success).toBe(true)
  })

  test('resolves prior-session raw agent ids and resumes from the origin session', async () => {
    const freshSessionId = randomUUID()
    const priorSessionId = randomUUID()
    const priorAgentId = createAgentId()
    switchSession(freshSessionId, tempDir)

    writePriorSessionState(tempDir, priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Prior raw-id target',
      activeWorkers: {},
      knownWorkers: {
        [priorAgentId]: {
          agentId: priorAgentId,
          role: 'explorer',
          description: 'Explore prior topic',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-prior',
        },
      },
    })
    writePriorAgentTranscript(tempDir, priorSessionId, priorAgentId)

    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
      }),
    } as never

    const result = await SendMessageTool.call(
      {
        to: priorAgentId,
        summary: 'follow up',
        message: 'continue by raw id',
      },
      context,
      undefined as never,
      { requestId: 'req-3' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: priorAgentId,
        prompt: 'continue by raw id',
        sourceSessionId: priorSessionId,
      }),
    )
    expect(result.data.success).toBe(true)
  })
})
