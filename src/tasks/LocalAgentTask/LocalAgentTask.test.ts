import { beforeEach, describe, expect, test } from 'bun:test'

import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  createCodexLeaseForTest,
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import {
  appendLocalAgentSystemMessage,
  completeAgentTask,
  markAgentTaskResumed,
  unregisterAgentForeground,
  registerAgentForeground,
} from './LocalAgentTask.js'
import { getPillLabel, pillNeedsCta } from '../pillLabel.js'
import {
  getTaskStatusIcon,
  shouldHideTasksFooter,
} from '../../components/tasks/taskStatusUtils.js'

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

describe('LocalAgentTask foreground cleanup', () => {
  let appState: AppState

  const setAppState = (updater: (prev: AppState) => AppState) => {
    appState = updater(appState)
  }

  beforeEach(() => {
    appState = getDefaultAppState()
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
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
    registerAgentForeground({
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
        model: 'gpt-5.4',
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
})
