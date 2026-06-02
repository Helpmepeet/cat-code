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
import { readMailbox } from '../../utils/teammateMailbox.js'
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
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalUserType = process.env.USER_TYPE
  let tempDir: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'send-message-tool-'))
    const sessionId = randomUUID()
    switchSession(sessionId, tempDir)
    process.env.USER_TYPE = 'external'

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
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
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

  test('is enabled in normal sessions for running subagent targets', () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    expect(SendMessageTool.isEnabled?.()).toBe(true)
  })

  test('schema describes running subagent targets', () => {
    const description = SendMessageTool.inputSchema.shape.to.description
    // Must convey the target has to be running, accept name/handle/raw ID, and
    // point at ResumeAgent for stopped targets.
    expect(description).toContain('must be currently running')
    expect(description).toContain('friendly name/alias')
    expect(description).toContain('worker handle')
    expect(description).toContain('raw agent ID')
    expect(description).toContain('use ResumeAgent instead')
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
          'Without Agent Teams, SendMessage can only target running worker handles or agent IDs',
        ),
      },
    })
    expect(resumeAgentBackground).not.toHaveBeenCalled()
  })

  test('queues messages to a running local subagent by registered name', async () => {
    let state = {
      agentNameRegistry: new Map([['worker-one', 'agent-running']]),
      tasks: {
        'agent-running': {
          id: 'agent-running',
          type: 'local_agent',
          status: 'running',
          agentId: 'agent-running',
          agentType: 'general-purpose',
          pendingMessages: [],
        },
      },
    }
    const context = {
      getAppState: () => state,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
    } as never

    const result = await SendMessageTool.call(
      { to: 'worker-one', summary: 'follow up', message: 'go deeper' },
      context,
      undefined as never,
      { requestId: 'req-running' } as never,
    )

    expect(result).toMatchObject({
      data: {
        success: true,
        message:
          'Message queued for delivery to worker-one at its next tool round.',
      },
    })
    expect(state.tasks['agent-running'].pendingMessages).toEqual(['go deeper'])
    expect(resumeAgentBackground).not.toHaveBeenCalled()
  })

  test('queues messages to a running local subagent by displayed @name', async () => {
    let state = {
      agentNameRegistry: new Map([['worker-one', 'agent-running']]),
      tasks: {
        'agent-running': {
          id: 'agent-running',
          type: 'local_agent',
          status: 'running',
          agentId: 'agent-running',
          agentType: 'general-purpose',
          pendingMessages: [],
        },
      },
    }
    const context = {
      getAppState: () => state,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
    } as never

    await expect(
      SendMessageTool.validateInput?.(
        { to: '@worker-one', summary: 'follow up', message: 'go deeper' },
        context,
      ),
    ).resolves.toEqual({ result: true })

    const result = await SendMessageTool.call(
      { to: '@worker-one', summary: 'follow up', message: 'go deeper' },
      context,
      undefined as never,
      { requestId: 'req-running-at' } as never,
    )

    expect(result.data.success).toBe(true)
    expect(state.tasks['agent-running'].pendingMessages).toEqual(['go deeper'])
    expect(resumeAgentBackground).not.toHaveBeenCalled()
  })

  test('queues messages to a running raw agent id before transcript creation', async () => {
    const agentId = createAgentId()
    let state = {
      agentNameRegistry: new Map(),
      tasks: {
        [agentId]: {
          id: agentId,
          type: 'local_agent',
          status: 'running',
          agentId,
          agentType: 'general-purpose',
          pendingMessages: [],
        },
      },
    }
    const context = {
      getAppState: () => state,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
    } as never

    const result = await SendMessageTool.call(
      { to: agentId, summary: 'follow up', message: 'raw follow-up' },
      context,
      undefined as never,
      { requestId: 'req-running-raw' } as never,
    )

    expect(result.data.success).toBe(true)
    expect(state.tasks[agentId].pendingMessages).toEqual(['raw follow-up'])
    expect(resumeAgentBackground).not.toHaveBeenCalled()
  })

  test('falls through to teammate mailbox when Agent Teams are enabled and target is unresolved', async () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
        teamContext: {
          teamName: 'review-team',
          teamFilePath: join(tempDir, 'teams', 'review-team', 'config.json'),
          leadAgentId: 'lead',
          isLeader: true,
          teammates: {
            alice: {
              name: 'alice',
              tmuxSessionName: 'session',
              tmuxPaneId: 'pane',
              cwd: tempDir,
              spawnedAt: Date.now(),
            },
          },
        },
      }),
    } as never

    const result = await SendMessageTool.call(
      { to: 'alice', summary: 'hello', message: 'status?' },
      context,
      undefined as never,
      { requestId: 'req-team' } as never,
    )

    expect(result).toMatchObject({
      data: {
        success: true,
        message: "Message sent to alice's inbox",
      },
    })
    const messages = await readMailbox('alice', 'review-team')
    expect(messages).toMatchObject([
      {
        from: 'team-lead',
        text: 'status?',
        summary: 'hello',
        read: false,
      },
    ])
    expect(resumeAgentBackground).not.toHaveBeenCalled()
  })

  test('returns ResumeAgent guidance for a durable-handle target evicted from task state', async () => {
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

    expect(resumeAgentBackground).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      data: {
        success: false,
        message:
          'Agent "agent-persis..." is stopped. Use ResumeAgent({ agentId: "explore-1", prompt }) to restart it.',
      },
    })
  })

  test('returns ResumeAgent guidance for a stopped in-memory local subagent', async () => {
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

    expect(resumeAgentBackground).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      data: {
        success: false,
        message:
          'Agent "@worker-one" is stopped. Use ResumeAgent({ agentId: "@worker-one", prompt }) to restart it.',
      },
    })
  })

  test('returns ResumeAgent guidance for a prior-session worker handle', async () => {
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

    expect(resumeAgentBackground).not.toHaveBeenCalled()
    expect(result.data).toEqual({
      success: false,
      message:
        'Agent "agent-prior" is stopped. Use ResumeAgent({ agentId: "explore-prior", prompt }) to restart it.',
    })
  })

  test('returns ResumeAgent guidance for a prior-session raw agent id', async () => {
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

    expect(resumeAgentBackground).not.toHaveBeenCalled()
    expect(result.data).toEqual({
      success: false,
      message: `Agent "${priorAgentId.slice(0, 12)}..." is stopped. Use ResumeAgent({ agentId: "${priorAgentId}", prompt }) to restart it.`,
    })
  })
})
