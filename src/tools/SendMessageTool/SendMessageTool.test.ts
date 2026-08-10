import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { recipientNameKey } from '../../utils/recipientIdentity.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import * as teammateMailbox from '../../utils/teammateMailbox.js'
import {
  getInboxPath,
  MailboxWriteError,
  readMailbox,
} from '../../utils/teammateMailbox.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { isDeferredTool } from '../ToolSearchTool/prompt.js'
import * as resumeAgentModule from '../AgentTool/resumeAgent.js'
import * as resolveAgentTargetModule from '../AgentTool/resolveAgentTarget.js'
import { SendMessageTool } from './SendMessageTool.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

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
          model: 'gpt-5.6-luna',
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

  test('without Agent Teams, a structured message to an @-recipient reports the message-shape error, not the recipient-format error', async () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    await expect(
      SendMessageTool.validateInput?.(
        {
          to: '@nonexistent-agent',
          message: { type: 'shutdown_request' },
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

  test('re-reads state after resolution so a message queues to a target that started running mid-resolve', async () => {
    let state = {
      agentNameRegistry: new Map([['worker-one', 'agent-race']]),
      tasks: {
        'agent-race': {
          id: 'agent-race',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-race',
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

    // Hold resolveAgentTarget's return open behind a deferred promise (a
    // barrier, never a timer) so the tool call is suspended after resolving
    // the target but before it re-checks status. While suspended, flip the
    // target to 'running' — simulating a concurrent ResumeAgent completing
    // — then release. The re-read fix must see the fresh 'running' status,
    // not the 'completed' snapshot that existed when resolution began.
    const resolveGate = deferred<void>()
    const realResolveAgentTarget = resolveAgentTargetModule.resolveAgentTarget
    const resolveSpy = spyOn(
      resolveAgentTargetModule,
      'resolveAgentTarget',
    ).mockImplementation(
      mock(async args => {
        const real = await realResolveAgentTarget(args)
        await resolveGate.promise
        return real
      }) as never,
    )

    const resultPromise = SendMessageTool.call(
      { to: 'worker-one', summary: 'follow up', message: 'go deeper' },
      context,
      undefined as never,
      { requestId: 'req-race' } as never,
    )

    state = {
      ...state,
      tasks: {
        ...state.tasks,
        'agent-race': { ...state.tasks['agent-race'], status: 'running' },
      },
    }
    resolveGate.resolve()

    const result = await resultPromise
    expect(result.data).toMatchObject({
      success: true,
      message: 'Message queued for delivery to worker-one at its next tool round.',
    })
    expect(state.tasks['agent-race'].pendingMessages).toEqual(['go deeper'])
    expect(resumeAgentBackground).not.toHaveBeenCalled()
    resolveSpy.mockRestore()
  })

  test('falls through to teammate mailbox when Agent Teams are enabled and target is unresolved', async () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamFilePath = join(tempDir, 'teams', 'review-team', 'config.json')
    // Version-2 team file with a real recipientRecords entry — routing now
    // resolves the roster via readTeamSnapshot(), not just AppState.teamContext.
    mkdirSync(dirname(teamFilePath), { recursive: true })
    writeFileSync(
      teamFilePath,
      JSON.stringify({
        name: 'review-team',
        teamProtocolVersion: 2,
        createdAt: Date.now(),
        leadAgentId: 'lead',
        members: [
          {
            agentId: 'alice@review-team',
            name: 'alice',
            joinedAt: Date.now(),
            tmuxPaneId: 'pane',
            cwd: tempDir,
            subscriptions: [],
          },
        ],
        recipientRecords: [
          {
            allocationId: 'allocation-alice',
            key: 'alice',
            name: 'alice',
            kind: 'teammate',
            agentId: 'alice@review-team',
            sessionId: 'session-1',
            status: 'active',
            launcherPid: process.pid,
            launcherInstanceId: 'test-process',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    )
    createdFiles.push(teamFilePath)
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
        teamContext: {
          teamName: 'review-team',
          teamFilePath,
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
    let state = {
      agentNameRegistry: new Map([['worker-one', 'agent-persistent']]),
      tasks: {
        'agent-persistent': {
          id: 'agent-persistent',
          type: 'local_agent',
          status: 'completed',
          agentId: 'agent-persistent',
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
    expect(result.data).toMatchObject({
      success: false,
      message: expect.stringContaining(
        'Agent "agent-prior" is stopped. Use ResumeAgent({ agentId: "explore-prior", prompt }) to restart it.',
      ),
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
    expect(result.data).toMatchObject({
      success: false,
      message: expect.stringContaining(
        `Agent "${priorAgentId.slice(0, 12)}..." is stopped. Use ResumeAgent({ agentId: "${priorAgentId}", prompt }) to restart it.`,
      ),
    })
  })
})

describe('SendMessageTool deterministic routing and truthful delivery', () => {
  const originalAgentTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'send-message-routing-'))
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    mock.restore()
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
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeMember(
    name: string,
    isActive = true,
  ): TeamFile['members'][number] {
    return {
      agentId: `${name}@review-team`,
      allocationId: `allocation-${name}`,
      name,
      joinedAt: 1,
      tmuxPaneId: `pane-${name}`,
      cwd: tempDir,
      subscriptions: [],
      isActive,
    }
  }

  function createTeamHarness(args: {
    members: TeamFile['members']
    tasks?: Record<string, Partial<LocalAgentTaskState>>
    aliases?: Array<[string, string]>
    pendingControls?: TeamFile['pendingControls']
  }) {
    const teamFile: TeamFile = {
      name: 'review-team',
      teamProtocolVersion: 2,
      createdAt: 1,
      leadAgentId: 'lead',
      members: args.members,
      pendingControls: args.pendingControls ?? [],
      recipientRecords: args.members.map(member => ({
        allocationId: member.allocationId!,
        key: recipientNameKey(member.name),
        name: member.name,
        kind: 'teammate',
        agentId: member.agentId,
        sessionId: 'session-1',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-process',
        createdAt: 1,
        updatedAt: 1,
      })),
    }
    const path = join(tempDir, 'teams', 'review-team', 'config.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(teamFile))
    let state = {
      agentNameRegistry: new Map(args.aliases ?? []),
      tasks: (args.tasks ?? {}) as Record<string, LocalAgentTaskState>,
      teamContext: {
        teamName: 'review-team',
        teamFilePath: path,
        leadAgentId: 'lead',
        isLeader: true,
        teammates: Object.fromEntries(
          args.members.map(member => [
            member.agentId,
            {
              name: member.name,
              tmuxSessionName: 'session',
              tmuxPaneId: member.tmuxPaneId,
              cwd: member.cwd,
              spawnedAt: member.joinedAt,
            },
          ]),
        ),
      },
    }
    return {
      context: {
        getAppState: () => state,
        setAppState: (updater: (prev: typeof state) => typeof state) => {
          state = updater(state)
        },
      } as never,
      getState: () => state,
    }
  }

  async function callSendMessage(
    to: string,
    harness: ReturnType<typeof createTeamHarness>,
  ) {
    return SendMessageTool.call(
      { to, summary: 'follow up', message: 'follow-up' },
      harness.context,
      undefined as never,
      { requestId: `req-${to}` } as never,
    )
  }

  test('propagates plain-send failure without creating an inbox for an absent name', async () => {
    const missingHarness = createTeamHarness({ members: [makeMember('alice')] })
    const missing = await callSendMessage('alic', missingHarness)
    expect(missing.data).toMatchObject({ success: false })
    expect(existsSync(getInboxPath('alic', 'review-team'))).toBe(false)
  })

  test('routes to an idle-but-active teammate', async () => {
    const idleHarness = createTeamHarness({
      members: [makeMember('alice', false)],
    })
    const idle = await callSendMessage('alice', idleHarness)
    expect(idle.data).toMatchObject({ success: true })
  })

  test('reports partial broadcast delivery truthfully', async () => {
    const broadcastHarness = createTeamHarness({
      members: [makeMember('alice'), makeMember('bob'), makeMember('carol')],
    })
    const originalWriteToMailbox = teammateMailbox.writeToMailbox
    const append = spyOn(teammateMailbox, 'writeToMailbox').mockImplementation(
      mock(async args => {
        if (args.recipient.name === 'bob') {
          throw new MailboxWriteError('bob', 'write', new Error('disk full'))
        }
        return originalWriteToMailbox(args)
      }) as never,
    )
    const result = await SendMessageTool.call(
      { to: '*', summary: 'status check', message: 'report status' },
      broadcastHarness.context,
      undefined as never,
      { requestId: 'req-broadcast' } as never,
    )

    expect(result.data).toMatchObject({
      success: false,
      recipients: ['alice', 'carol'],
      failed_recipients: [{ name: 'bob', error: expect.any(String) }],
    })
    expect(append).toHaveBeenCalledTimes(3)
  })

  test('routes a bare legacy-collision name to the teammate, and @name to the local worker', async () => {
    const collisionHarness = createTeamHarness({
      members: [makeMember('researcher')],
      aliases: [['researcher', 'agent-local']],
      tasks: {
        'agent-local': {
          id: 'agent-local',
          type: 'local_agent',
          status: 'running',
          agentId: 'agent-local',
          agentType: 'general-purpose',
          pendingMessages: [],
        },
      },
    })

    const bare = await callSendMessage('researcher', collisionHarness)
    expect(bare.data.message).toContain("researcher's inbox")
    expect(
      (collisionHarness.getState().tasks['agent-local'] as LocalAgentTaskState)
        .pendingMessages,
    ).toEqual([])

    const explicitLocal = await callSendMessage('@researcher', collisionHarness)
    expect(explicitLocal.data.message).toContain('queued for delivery')
    expect(
      (collisionHarness.getState().tasks['agent-local'] as LocalAgentTaskState)
        .pendingMessages,
    ).toEqual(['follow-up'])
  })

  test('fails closed on an ambiguous legacy teammate name collision', async () => {
    const ambiguousHarness = createTeamHarness({
      members: [makeMember('legacy.name'), makeMember('legacy-name')],
    })
    const ambiguous = await callSendMessage('legacy.name', ambiguousHarness)
    expect(ambiguous.data).toMatchObject({ success: false })
    expect(ambiguous.data.message).toContain('ambiguous legacy teammate name')
  })

  describe('structured-message authority matrix', () => {
    afterEach(() => {
      clearDynamicTeamContext()
    })

    test('rejects a shutdown_request from a non-leader sender', async () => {
      const harness = createTeamHarness({
        members: [makeMember('alice'), makeMember('bob')],
      })
      setDynamicTeamContext({
        agentId: 'alice@review-team',
        agentName: 'alice',
        teamName: 'review-team',
        planModeRequired: false,
      })

      const result = await SendMessageTool.call(
        { to: 'bob', message: { type: 'shutdown_request' } },
        harness.context,
        undefined as never,
        { requestId: 'req-1' } as never,
      )

      expect(result.data).toMatchObject({ success: false })
      expect((result.data as { message: string }).message).toContain(
        'Only the team lead can request teammate shutdown',
      )
    })

    test('the team lead can send a shutdown_request, recording a pending control', async () => {
      const harness = createTeamHarness({
        members: [makeMember('alice')],
      })

      const result = await SendMessageTool.call(
        { to: 'alice', message: { type: 'shutdown_request', reason: 'test' } },
        harness.context,
        undefined as never,
        { requestId: 'req-2' } as never,
      )

      expect(result.data).toMatchObject({ success: true })
      const teamFilePath = join(tempDir, 'teams', 'review-team', 'config.json')
      const written = JSON.parse(readFileSync(teamFilePath, 'utf-8')) as TeamFile
      expect(written.pendingControls).toHaveLength(1)
      expect(written.pendingControls?.[0]).toMatchObject({
        requestType: 'shutdown',
        recipientAgentId: 'alice@review-team',
        state: 'written',
      })
    })

    test('rejects a plan_approval_response (approve) sent by a non-leader', async () => {
      const harness = createTeamHarness({
        members: [makeMember('alice')],
      })
      setDynamicTeamContext({
        agentId: 'alice@review-team',
        agentName: 'alice',
        teamName: 'review-team',
        planModeRequired: false,
      })

      await expect(
        SendMessageTool.call(
          {
            to: 'alice',
            message: {
              type: 'plan_approval_response',
              request_id: 'plan-1',
              approve: true,
            },
          },
          harness.context,
          undefined as never,
          { requestId: 'req-3' } as never,
        ),
      ).rejects.toThrow('Only the team lead can approve plans')
    })

    test('handleShutdownApproval requires a successful write before aborting the in-process controller (Task 3 Step 10)', async () => {
      const leaderAgentId = 'lead'
      const aliceAgentId = 'alice@review-team'
      const abortController = new AbortController()
      const task: InProcessTeammateTaskState = {
        type: 'in_process_teammate',
        id: 'teammate-task',
        status: 'running',
        abortController,
        identity: {
          agentId: aliceAgentId,
          agentName: 'alice',
          teamName: 'review-team',
          planModeRequired: false,
          parentSessionId: 'session-lead',
        },
      } as unknown as InProcessTeammateTaskState
      const harness = createTeamHarness({
        members: [makeMember('alice')],
        pendingControls: [
          {
            requestId: 'shutdown-1',
            requestType: 'shutdown',
            senderAgentId: leaderAgentId,
            senderAllocationId: leaderAgentId,
            recipientAgentId: aliceAgentId,
            recipientAllocationId: 'allocation-alice',
            state: 'written',
          },
        ],
        tasks: { 'teammate-task': task as unknown as Partial<LocalAgentTaskState> },
      })

      setDynamicTeamContext({
        agentId: aliceAgentId,
        agentName: 'alice',
        teamName: 'review-team',
        planModeRequired: false,
      })

      const writeSpy = spyOn(
        teammateMailbox,
        'writeControlToMailbox',
      ).mockImplementation(
        mock(async () => {
          throw new MailboxWriteError('team-lead', 'write', new Error('disk full'))
        }) as never,
      )

      const result = await SendMessageTool.call(
        {
          to: TEAM_LEAD_NAME,
          message: { type: 'shutdown_response', request_id: 'shutdown-1', approve: true },
        },
        harness.context,
        undefined as never,
        { requestId: 'req-4' } as never,
      )

      expect(result.data.success).toBe(false)
      expect(abortController.signal.aborted).toBe(false)
      writeSpy.mockRestore()
    })

    test('handleShutdownApproval rejects an unsolicited/stale request id', async () => {
      const aliceAgentId = 'alice@review-team'
      const harness = createTeamHarness({
        members: [makeMember('alice')],
        pendingControls: [],
      })
      setDynamicTeamContext({
        agentId: aliceAgentId,
        agentName: 'alice',
        teamName: 'review-team',
        planModeRequired: false,
      })

      const result = await SendMessageTool.call(
        {
          to: TEAM_LEAD_NAME,
          message: { type: 'shutdown_response', request_id: 'no-such-request', approve: true },
        },
        harness.context,
        undefined as never,
        { requestId: 'req-5' } as never,
      )

      expect(result.data).toMatchObject({ success: false })
      expect((result.data as { message: string }).message).toContain(
        'No outstanding shutdown request',
      )
    })
  })
})
