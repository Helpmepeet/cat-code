import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getSessionId } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState } from '../../Task.js'
import {
  createCodexLeaseForTest,
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  snapshotLeaseAccount,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import {
  _setWebSocketFactoryForTest,
  clearWebSocketSession,
  ensureWebSocketSession,
} from '../../services/api/codex-websocket-transport.js'
import {
  appendLocalAgentSystemMessage,
  completeAgentTask,
  enqueueAgentNotification,
  markAgentTaskResumed,
  queuePendingMessageIfRunning,
  unregisterAgentForeground,
  registerAgentForeground,
} from './LocalAgentTask.js'
import { formatBlockedHandoff } from '../../tools/AskParentSessionTool/AskParentSessionTool.js'
import { getPillLabel, pillNeedsCta } from '../pillLabel.js'
import {
  getTaskStatusIcon,
  shouldHideTasksFooter,
} from '../../components/tasks/taskStatusUtils.js'
import {
  dequeue,
  getCommandsByMaxPriority,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? `access-${overrides.accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt:
      'usageFetchedAt' in overrides ? overrides.usageFetchedAt : Date.now(),
  }
}

class FakeWebSocket {
  static OPEN = 1

  readyState = FakeWebSocket.OPEN
  closeCalls = 0
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  open(): void {
    for (const listener of this.listeners.get('open') ?? []) listener()
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }
}

describe('LocalAgentTask foreground cleanup', () => {
  let appState: AppState

  const setAppState = (updater: (prev: AppState) => AppState) => {
    appState = updater(appState)
  }

  beforeEach(() => {
    appState = getDefaultAppState()
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    resetCommandQueue()
  })

  afterEach(() => {
    _setWebSocketFactoryForTest(null)
  })

  test('unregisterAgentForeground releases the foreground agent codex lease', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main', lastUsedAt: 0 }),
        buildPoolAccount({ accountId: 'worker-a', lastUsedAt: 100 }),
      ],
    })

    const agentId = 'sync-agent-1'
    registerAgentForeground({
      agentId,
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })
    createCodexLeaseForTest({
      ownerId: agentId,
      ownerType: 'subagent',
      ownerLabel: 'Sync foreground agent',
    })

    expect(getCodexLeaseForOwner(agentId)).toBeDefined()
    expect(appState.tasks[agentId]).toBeDefined()

    unregisterAgentForeground(agentId, setAppState)

    expect(getCodexLeaseForOwner(agentId)).toBeUndefined()
    expect(appState.tasks[agentId]).toBeUndefined()
  })

  test('unregisterAgentForeground hands back the account it just released', () => {
    // The regression this protects: the account is readable ONLY in the instant
    // before the release, because `releaseCodexLease` deletes the entry rather
    // than marking it. Returning it from the release is what makes the caller's
    // ordering impossible to get wrong, so this asserts the value AND the
    // deletion together — a return that arrived after the delete would be
    // undefined here.
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main', lastUsedAt: 0 }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'scout', lastUsedAt: 100 }),
      ],
    })

    const agentId = 'sync-agent-account'
    registerAgentForeground({
      agentId,
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })
    const lease = createCodexLeaseForTest({
      ownerId: agentId,
      ownerType: 'subagent',
      ownerLabel: 'Sync foreground agent',
    })

    const released = unregisterAgentForeground(agentId, setAppState)

    expect(released).toEqual({
      accountId: lease.accountId,
      accountAlias: lease.accountId === 'worker-a' ? 'scout' : 'main',
    })
    expect(getCodexLeaseForOwner(agentId)).toBeUndefined()
    expect(snapshotLeaseAccount(agentId)).toBeUndefined()
  })

  test('unregisterAgentForeground reports no account when nothing was leased', () => {
    // An Anthropic-path worker registers a foreground task and no lease. The
    // release must not invent one, or the card would name an account the run
    // never touched.
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [buildPoolAccount({ accountId: 'main-account', alias: 'main', lastUsedAt: 0 })],
    })

    const agentId = 'sync-agent-no-lease'
    registerAgentForeground({
      agentId,
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })

    expect(unregisterAgentForeground(agentId, setAppState)).toBeUndefined()
  })

  test('markAgentTaskResumed tracks visible resume state on local agent tasks', () => {
    registerAgentForeground({
      agentId: 'sync-agent-2',
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })

    markAgentTaskResumed('sync-agent-2', setAppState)

    expect(appState.tasks['sync-agent-2']).toMatchObject({
      type: 'local_agent',
      resumedAt: expect.any(Number),
    })
  })

  test('appendLocalAgentSystemMessage adds visible status to the local transcript', () => {
    registerAgentForeground({
      agentId: 'sync-agent-3',
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })

    appendLocalAgentSystemMessage(
      'sync-agent-3',
      'Resuming @worker...',
      'info',
      setAppState,
    )

    const task = appState.tasks['sync-agent-3']
    expect(task).toMatchObject({ type: 'local_agent' })
    if (task?.type !== 'local_agent') throw new Error('expected local agent')
    expect(task.messages?.at(-1)).toMatchObject({
      type: 'system',
      subtype: 'informational',
      content: 'Resuming @worker...',
      level: 'info',
      isMeta: false,
    })
  })

  test('registerAgentForeground stores the resolved friendly agent name', () => {
    const registration = registerAgentForeground({
      agentId: 'sync-agent-4',
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'implementor',
        agentType: 'implementor',
        prompt: 'test prompt',
      },
      agentName: 'Curie',
      setAppState,
    })

    expect(appState.tasks['sync-agent-4']).toMatchObject({
      type: 'local_agent',
      agentName: 'Curie',
      agentType: 'implementor',
    })
    expect(
      (appState.tasks['sync-agent-4'] as { abortController?: AbortController })
        .abortController,
    ).toBe(registration.abortController)
  })

  test('completeAgentTask records blocked handoff metadata from the result', () => {
    registerAgentForeground({
      agentId: 'sync-agent-5',
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'implementor',
        agentType: 'implementor',
        prompt: 'test prompt',
      },
      agentName: 'Curie',
      setAppState,
    })

    completeAgentTask(
      {
        agentId: 'sync-agent-5',
        agentType: 'implementor',
        agentName: 'Curie',
        model: 'gpt-5.6-luna',
        content: [
          {
            type: 'text',
            text:
              'I need a decision before editing.\n\n' +
              'status: blocked\n\n' +
              'Changed files:\n' +
              '- none\n\n' +
              'Checks run:\n' +
              '- none\n\n' +
              'Open questions / blockers:\n' +
              '- Should I update the public API too?',
          },
        ],
        totalToolUseCount: 0,
        totalDurationMs: 100,
        totalTokens: 10,
      },
      setAppState,
    )

    expect(appState.tasks['sync-agent-5']).toMatchObject({
      type: 'local_agent',
      status: 'completed',
      handoffStatus: 'blocked',
      blockReason: 'Should I update the public API too?',
    })
  })

  // The handoff runAgent writes when a worker calls ask_parent_session has to
  // land here the same way a model-written one does: extractHandoffStatus and
  // extractBlockReason read the RESULT TEXT, so a constructed result that
  // drifts from that skeleton would show as an ordinary completion with the
  // question buried in it.
  test('completeAgentTask reads the harness-written escalation handoff', () => {
    registerAgentForeground({
      agentId: 'sync-agent-escalated',
      description: 'Sync foreground agent',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'general-purpose',
        agentType: 'general-purpose',
        prompt: 'test prompt',
      },
      agentName: 'Wilkes',
      setAppState,
    })

    completeAgentTask(
      {
        agentId: 'sync-agent-escalated',
        agentType: 'general-purpose',
        agentName: 'Wilkes',
        model: 'gpt-5.6-luna',
        content: [
          {
            type: 'text',
            text: formatBlockedHandoff({
              kind: 'question',
              message: 'Which components does Q to S cover?',
              evidence: ['ToolSearch select:Agent returned nothing'],
            }),
          },
        ],
        totalToolUseCount: 1,
        totalDurationMs: 100,
        totalTokens: 10,
      },
      setAppState,
    )

    expect(appState.tasks['sync-agent-escalated']).toMatchObject({
      type: 'local_agent',
      status: 'completed',
      handoffStatus: 'blocked',
      blockReason: 'Which components does Q to S cover?',
    })
  })

  test('completeAgentTask clears the finished agent WebSocket session', async () => {
    const agentId = 'sync-agent-ws-cleanup'
    const conversationId = `${getSessionId()}/${agentId}`
    let socket: FakeWebSocket | undefined
    _setWebSocketFactoryForTest(() => {
      socket = new FakeWebSocket()
      queueMicrotask(() => socket?.open())
      return socket as never
    })
    await ensureWebSocketSession(conversationId, { Authorization: 'Bearer test' })
    registerAgentForeground({
      agentId,
      description: 'Finish websocket agent',
      prompt: 'test prompt',
      selectedAgent: { name: 'general-purpose', prompt: 'test prompt' },
      setAppState,
    })

    completeAgentTask(
      {
        agentId,
        content: [{ type: 'text', text: 'done' }],
        totalToolUseCount: 0,
        totalDurationMs: 1,
        totalTokens: 1,
      },
      setAppState,
    )

    expect(socket?.closeCalls).toBe(1)
    clearWebSocketSession(conversationId)
  })

  test('local agent pill label shows name role blocked state and CTA', () => {
    const task = {
      ...appState.tasks['missing'],
      id: 'sync-agent-6',
      type: 'local_agent',
      status: 'completed',
      description: 'Sync foreground agent',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      agentId: 'sync-agent-6',
      prompt: 'test prompt',
      agentName: 'Curie',
      agentType: 'implementor',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
      handoffStatus: 'blocked',
      blockReason: 'Need a decision.',
    } as const

    expect(getPillLabel([task])).toBe(
      `${getTaskStatusIcon('completed', { awaitingApproval: true })} @Curie · implementor — needs input`,
    )
    expect(pillNeedsCta([task])).toBe(true)
  })

  test('verification pill label includes terminal verdict', () => {
    const task = {
      ...appState.tasks['missing'],
      id: 'sync-agent-7',
      type: 'local_agent',
      status: 'completed',
      description: 'Verification agent',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      agentId: 'sync-agent-7',
      prompt: 'test prompt',
      agentName: 'Noether',
      agentType: 'verification',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
      verdict: 'FAIL',
    } as const

    expect(getPillLabel([task])).toBe(
      `${getTaskStatusIcon('failed')} @Noether · verification — FAIL`,
    )
  })

  test('two terminal local agent pill labels keep friendly names and suffixes', () => {
    const blockedTask = {
      ...appState.tasks['missing'],
      id: 'sync-agent-8',
      type: 'local_agent',
      status: 'completed',
      description: 'Implementor agent',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: true,
      agentId: 'sync-agent-8',
      prompt: 'test prompt',
      agentName: 'Curie',
      agentType: 'implementor',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
      handoffStatus: 'blocked',
      blockReason: 'Need a decision.',
    } as const
    const verificationTask = {
      ...appState.tasks['missing'],
      id: 'sync-agent-9',
      type: 'local_agent',
      status: 'completed',
      description: 'Verification agent',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: true,
      agentId: 'sync-agent-9',
      prompt: 'test prompt',
      agentName: 'Noether',
      agentType: 'verification',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
      verdict: 'PARTIAL',
    } as const

    expect(getPillLabel([blockedTask, verificationTask])).toBe(
      `${getTaskStatusIcon('completed', { awaitingApproval: true })} @Curie · implementor — needs input · ${getTaskStatusIcon('completed', { awaitingApproval: true })} @Noether · verification — PARTIAL`,
    )
  })

  test('blocked terminal local agents keep task footer visible in spinner tree mode', () => {
    const task = {
      ...appState.tasks['missing'],
      id: 'sync-agent-10',
      type: 'local_agent',
      status: 'completed',
      description: 'Implementor agent',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: true,
      agentId: 'sync-agent-10',
      prompt: 'test prompt',
      agentName: 'Curie',
      agentType: 'implementor',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
      handoffStatus: 'blocked',
      blockReason: 'Need a decision.',
    } as const

    expect(shouldHideTasksFooter({ [task.id]: task }, true)).toBe(false)
  })

  test('agent notifications prefer the friendly agent name in the visible summary', () => {
    registerAgentForeground({
      agentId: 'sync-agent-11',
      description: 'Check renderer paths',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'general-purpose',
        agentType: 'general-purpose',
        prompt: 'test prompt',
      },
      agentName: 'Ada',
      setAppState,
    })

    enqueueAgentNotification({
      taskId: 'sync-agent-11',
      description: 'Check renderer paths',
      status: 'completed',
      setAppState,
    })

    const queued = dequeue()
    expect(queued?.origin).toMatchObject({
      kind: 'task-notification',
      summary: 'Agent @Ada completed',
    })
  })

  test('local agent completion notifications keep default later priority', () => {
    registerAgentForeground({
      agentId: 'sync-agent-12',
      description: 'Inspect sessions page',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'Explore',
        agentType: 'Explore',
        prompt: 'test prompt',
      },
      agentName: 'Ada',
      setAppState,
    })

    enqueueAgentNotification({
      taskId: 'sync-agent-12',
      description: 'Inspect sessions page',
      status: 'completed',
      setAppState,
    })

    const nextCommands = getCommandsByMaxPriority('next')
    const laterCommands = getCommandsByMaxPriority('later')

    expect(nextCommands).toHaveLength(0)
    expect(laterCommands).toHaveLength(1)
    expect(laterCommands[0]?.mode).toBe('task-notification')
    expect(laterCommands[0]?.priority).toBe('later')
    expect(laterCommands[0]?.value).toContain('Agent @Ada completed')
  })

  test('failed and killed local agent notifications keep default priority', () => {
    registerAgentForeground({
      agentId: 'sync-agent-13',
      description: 'Inspect failed path',
      prompt: 'test prompt',
      selectedAgent: { name: 'Explore', prompt: 'test prompt' },
      agentName: 'Ada',
      setAppState,
    })
    registerAgentForeground({
      agentId: 'sync-agent-14',
      description: 'Inspect killed path',
      prompt: 'test prompt',
      selectedAgent: { name: 'Explore', prompt: 'test prompt' },
      agentName: 'Ada',
      setAppState,
    })

    enqueueAgentNotification({
      taskId: 'sync-agent-13',
      description: 'Inspect failed path',
      status: 'failed',
      error: 'Test failure',
      setAppState,
    })
    enqueueAgentNotification({
      taskId: 'sync-agent-14',
      description: 'Inspect killed path',
      status: 'killed',
      setAppState,
    })

    expect(getCommandsByMaxPriority('next')).toHaveLength(0)
  })
})

describe('queuePendingMessageIfRunning', () => {
  test('atomically queues only for a running task, leaving a stopped task untouched', () => {
    let appState = {
      tasks: {
        running: {
          id: 'running',
          type: 'local_agent',
          status: 'running',
          agentId: 'running',
          agentType: 'general-purpose',
          pendingMessages: [],
        },
        stopped: {
          id: 'stopped',
          type: 'local_agent',
          status: 'completed',
          agentId: 'stopped',
          agentType: 'general-purpose',
          pendingMessages: [],
        },
      },
    } as unknown as AppState
    const setAppState: SetAppState = updater => {
      appState = updater(appState)
    }
    const runningId = 'running'
    const stoppedId = 'stopped'

    expect(queuePendingMessageIfRunning(runningId, 'follow-up', setAppState)).toBe(true)
    expect(appState.tasks[runningId].pendingMessages).toEqual(['follow-up'])
    expect(queuePendingMessageIfRunning(stoppedId, 'late', setAppState)).toBe(false)
    expect(appState.tasks[stoppedId].pendingMessages).toEqual([])
  })

  test('returns false for a missing task without throwing', () => {
    let appState = { tasks: {} } as unknown as AppState
    const setAppState: SetAppState = updater => {
      appState = updater(appState)
    }

    expect(queuePendingMessageIfRunning('nonexistent', 'hello', setAppState)).toBe(false)
  })

  test('never queues to a running main-session task', () => {
    let appState = {
      tasks: {
        main: {
          id: 'main',
          type: 'local_agent',
          status: 'running',
          agentId: 'main',
          agentType: 'main-session',
          pendingMessages: [],
        },
      },
    } as unknown as AppState
    const setAppState: SetAppState = updater => {
      appState = updater(appState)
    }

    expect(queuePendingMessageIfRunning('main', 'hello', setAppState)).toBe(false)
    expect(appState.tasks.main.pendingMessages).toEqual([])
  })
})
