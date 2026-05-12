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
  markAgentTaskResumed,
  unregisterAgentForeground,
  registerAgentForeground,
} from './LocalAgentTask.js'

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
    turnsUsed: overrides.turnsUsed ?? 0,
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
})
