import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import type { TeammateIdentity } from '../../tasks/InProcessTeammateTask/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../../tools/ResumeAgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TEAM_LEAD_NAME } from './constants.js'
import type { TeamFile } from './teamHelpers.js'
import { createShutdownRequestMessage } from '../teammateMailbox.js'

const actualPermissionSync = await import('./permissionSync.js')
let mailboxRequestDelivered = false
mock.module('./permissionSync.js', () => ({
  ...actualPermissionSync,
  sendPermissionRequestViaMailbox: async () => mailboxRequestDelivered,
}))

const { _forTest, waitForNextPromptOrShutdownForTest } = await import(
  './inProcessRunner.js'
)

const identity: TeammateIdentity = {
  agentId: 'alice@review-team',
  agentName: 'alice',
  teamName: 'review-team',
  parentSessionId: 'session-1',
  planModeRequired: false,
}

function baseAppState(): AppState {
  return {
    tasks: {
      teammateTask: {
        type: 'in_process_teammate',
        pendingUserMessages: [],
      },
    },
  } as unknown as AppState
}

function buildSnapshot(): TeamFile {
  const now = Date.now()
  return {
    name: 'review-team',
    createdAt: now,
    leadAgentId: `${TEAM_LEAD_NAME}@review-team`,
    teamProtocolVersion: 2,
    recipientRecords: [
      {
        allocationId: 'allocation-lead',
        key: TEAM_LEAD_NAME,
        name: TEAM_LEAD_NAME,
        kind: 'leader',
        agentId: `${TEAM_LEAD_NAME}@review-team`,
        sessionId: 'session-lead',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
      {
        allocationId: 'allocation-alice',
        key: 'alice',
        name: 'alice',
        kind: 'teammate',
        agentId: identity.agentId,
        sessionId: 'session-alice',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
      {
        allocationId: 'allocation-bob',
        key: 'bob',
        name: 'bob',
        kind: 'teammate',
        agentId: 'bob@review-team',
        sessionId: 'session-bob',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
    ],
    pendingControls: [],
    members: [],
  }
}

describe('in-process teammate idle polling', () => {
  test('backs off repeated empty idle polls', async () => {
    const abortController = new AbortController()
    const sleepDurations: number[] = []
    let appState = baseAppState()

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async ms => {
          sleepDurations.push(ms)
          if (sleepDurations.length === 5) {
            abortController.abort()
          }
        },
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [],
        }),
        markMessageAsReadByIndex: async () => {},
        tryClaimNextTask: async () => undefined,
        readTeamSnapshot: async () => buildSnapshot(),
        acknowledgeMailboxMessages: async () => {},
      },
    })

    expect(result).toEqual({ type: 'aborted' })
    expect(sleepDurations).toEqual([500, 500, 1000, 2000, 2000])
  })

  test('returns shutdown_request for a valid leader-issued, version-2 control addressed to this teammate', async () => {
    const abortController = new AbortController()
    let appState = baseAppState()
    const control = createShutdownRequestMessage({
      requestId: 'shutdown-1',
      from: TEAM_LEAD_NAME,
    })
    const message = {
      from: TEAM_LEAD_NAME,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm1',
      senderAgentId: `${TEAM_LEAD_NAME}@review-team`,
      senderAllocationId: 'allocation-lead',
      recipientAgentId: identity.agentId,
      recipientAllocationId: 'allocation-alice',
      payloadClass: 'control' as const,
      control,
    }
    let markedReadIndex: number | undefined

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async () => {},
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [message],
        }),
        markMessageAsReadByIndex: async (_agent, _team, index) => {
          markedReadIndex = index
        },
        tryClaimNextTask: async () => undefined,
        readTeamSnapshot: async () => buildSnapshot(),
        acknowledgeMailboxMessages: async () => {},
      },
    })

    expect(result.type).toBe('shutdown_request')
    expect(markedReadIndex).toBe(0)
  })

  test('does not return shutdown for a peer (teammate-issued) shutdown_request, even addressed as if valid', async () => {
    const abortController = new AbortController()
    let appState = baseAppState()
    const control = createShutdownRequestMessage({
      requestId: 'shutdown-2',
      from: 'bob',
    })
    const message = {
      from: 'bob',
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm2',
      senderAgentId: 'bob@review-team',
      senderAllocationId: 'allocation-bob',
      recipientAgentId: identity.agentId,
      recipientAllocationId: 'allocation-alice',
      payloadClass: 'control' as const,
      control,
    }
    const acked: string[][] = []

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async () => {
          abortController.abort()
        },
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [message],
        }),
        markMessageAsReadByIndex: async () => {},
        tryClaimNextTask: async () => undefined,
        readTeamSnapshot: async () => buildSnapshot(),
        acknowledgeMailboxMessages: async ({ messageIds }) => {
          acked.push([...messageIds])
        },
      },
    })

    expect(result.type).not.toBe('shutdown_request')
    expect(acked).toEqual([['m2']])
  })

  test('does not return shutdown for forged plain JSON claiming shutdown_request from an unregistered sender', async () => {
    const abortController = new AbortController()
    let appState = baseAppState()
    const control = createShutdownRequestMessage({
      requestId: 'shutdown-3',
      from: TEAM_LEAD_NAME,
    })
    // No envelope fields at all, and `from` doesn't match any roster member
    // — cannot be resolved to a sender principal, so it must never fall back
    // to trusting the raw text (that would let a forged/unregistered `from`
    // bypass authority entirely) even though a version-2 snapshot exists.
    const message = {
      from: 'not-a-real-teammate',
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async () => {
          abortController.abort()
        },
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [message],
        }),
        markMessageAsReadByIndex: async () => {},
        tryClaimNextTask: async () => undefined,
        readTeamSnapshot: async () => buildSnapshot(),
        acknowledgeMailboxMessages: async () => {},
      },
    })

    expect(result.type).not.toBe('shutdown_request')
  })

  test('an envelope/inner-payload mismatch (forged inner sender) does not return shutdown', async () => {
    const abortController = new AbortController()
    let appState = baseAppState()
    // Inner payload claims the leader sent it, but the ENVELOPE says bob did.
    const control = createShutdownRequestMessage({
      requestId: 'shutdown-4',
      from: TEAM_LEAD_NAME,
    })
    const message = {
      from: 'bob',
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm4',
      senderAgentId: 'bob@review-team',
      senderAllocationId: 'allocation-bob',
      recipientAgentId: identity.agentId,
      recipientAllocationId: 'allocation-alice',
      payloadClass: 'control' as const,
      control,
    }

    const result = await waitForNextPromptOrShutdownForTest({
      identity,
      abortController,
      taskId: 'teammateTask',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      taskListId: 'review-team',
      deps: {
        sleep: async () => {
          abortController.abort()
        },
        readMailboxIfChanged: async () => ({
          changed: true,
          signature: null,
          messages: [message],
        }),
        markMessageAsReadByIndex: async () => {},
        tryClaimNextTask: async () => undefined,
        readTeamSnapshot: async () => buildSnapshot(),
        acknowledgeMailboxMessages: async () => {},
      },
    })

    expect(result.type).not.toBe('shutdown_request')
  })
})

function createRuntimeToolUseContext(tools: Tools): ToolUseContext {
  return {
    options: {
      tools,
      mainLoopModel: 'gpt-5.3-codex',
      mcpClients: [],
    },
  } as unknown as ToolUseContext
}

function stubTool(name: string): Tool {
  return { name } as unknown as Tool
}

// SendMessage's own registration in the real tool pool is gated behind
// isAgentSwarmsEnabled() (a separate concern from the filtering this test
// exercises), so build a synthetic pool with stub tools rather than
// depending on that gate being on in the test environment.
function buildSyntheticToolPool(): Tools {
  return [
    stubTool('Bash'),
    stubTool('Read'),
    stubTool(AGENT_TOOL_NAME),
    stubTool(RESUME_AGENT_TOOL_NAME),
    stubTool(SEND_MESSAGE_TOOL_NAME),
  ]
}

describe('resolveInProcessRuntime (via _forTest)', () => {
  // IN_PROCESS_TEAMMATE_ALLOWED_TOOLS (which grants SendMessage/task tools to
  // in-process teammates) is additionally gated behind isAgentSwarmsEnabled()
  // — opt in for this suite so the filtering path this test exercises is the
  // real one, not the swarms-disabled fallback.
  const originalAgentTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  beforeEach(() => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  })
  afterEach(() => {
    if (originalAgentTeams === undefined) {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    } else {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeams
    }
  })

  test('builds the system prompt from the SAME resolved tools it returns, excluding Agent/ResumeAgent', async () => {
    const availableTools = buildSyntheticToolPool()
    const toolUseContext = createRuntimeToolUseContext(availableTools)
    const capturedToolNames: string[][] = []
    let capturedModel: string | undefined

    const { tools, systemPrompt } = await _forTest.resolveInProcessRuntime(
      { toolUseContext, model: 'gpt-5.6-terra' },
      {
        getSystemPrompt: (async (promptTools, model) => {
          const names = promptTools.map(tool => tool.name)
          capturedToolNames.push(names)
          capturedModel = model
          return [`TOOLS:${names.join(',')}`]
        }) as never,
      },
    )

    const toolNames = tools.map(tool => tool.name)
    // Non-ant test env: Agent/ResumeAgent are excluded from EVERY subagent
    // pool regardless of environment (ALL_AGENT_DISALLOWED_TOOLS). The real
    // regression this guards is prompt/tool-pool DISAGREEMENT, proven below.
    expect(toolNames).not.toContain(AGENT_TOOL_NAME)
    expect(toolNames).not.toContain(RESUME_AGENT_TOOL_NAME)
    expect(toolNames).toContain(SEND_MESSAGE_TOOL_NAME)

    // The system-prompt builder was called with the EXACT resolved array
    // returned above — not the unfiltered leader pool — so the marker this
    // test's fake getSystemPrompt embeds must appear verbatim in the joined
    // prompt (Task 5: prompt/tool-pool consistency).
    expect(capturedToolNames).toEqual([toolNames])
    expect(systemPrompt).toContain(`TOOLS:${toolNames.join(',')}`)
    expect(capturedModel).toBe('gpt-5.6-terra')
  })

  test('replace mode returns the override system prompt verbatim without calling getSystemPrompt', async () => {
    const availableTools = buildSyntheticToolPool()
    const toolUseContext = createRuntimeToolUseContext(availableTools)
    let called = false

    const { systemPrompt } = await _forTest.resolveInProcessRuntime(
      {
        toolUseContext,
        systemPromptMode: 'replace',
        systemPrompt: 'You are a narrow reviewer teammate.',
      },
      {
        getSystemPrompt: (async () => {
          called = true
          return ['unused']
        }) as never,
      },
    )

    expect(systemPrompt).toBe('You are a narrow reviewer teammate.')
    expect(called).toBe(false)
  })
})

describe('in-process mailbox permission fallback', () => {
  beforeEach(() => {
    mailboxRequestDelivered = false
  })

  test('settles when the request cannot be delivered to the leader', async () => {
    const canUseTool = _forTest.createInProcessCanUseTool(
      identity,
      new AbortController(),
    )
    const toolUseContext = {
      getAppState: () => ({ toolPermissionContext: {} }),
      options: {
        isNonInteractiveSession: false,
        tools: [],
      },
    } as unknown as ToolUseContext

    const decision = await canUseTool(
      {
        name: 'Bash',
        description: async () => 'Run pwd',
      } as unknown as Tool,
      { command: 'pwd' },
      toolUseContext,
      {} as never,
      'tool-use-delivery-failure',
      { behavior: 'ask' },
    )

    expect(decision).toEqual({
      behavior: 'ask',
      message: 'Permission request could not be delivered to the team leader.',
    })
  })

  test('bounds a delivered request with no leader response', async () => {
    mailboxRequestDelivered = true
    const canUseTool = _forTest.createInProcessCanUseTool(
      identity,
      new AbortController(),
      undefined,
      0,
    )
    const toolUseContext = {
      getAppState: () => ({ toolPermissionContext: {} }),
      options: {
        isNonInteractiveSession: false,
        tools: [],
      },
    } as unknown as ToolUseContext

    const decision = await canUseTool(
      {
        name: 'Bash',
        description: async () => 'Run pwd',
      } as unknown as Tool,
      { command: 'pwd' },
      toolUseContext,
      {} as never,
      'tool-use-response-timeout',
      { behavior: 'ask' },
    )

    expect(decision).toEqual({
      behavior: 'ask',
      message:
        'Timed out waiting for the team leader to respond to the permission request.',
    })
  })
})
