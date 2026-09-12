import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { join } from 'path'
import { tmpdir } from 'os'
import {
  resetStateForTests,
  setSessionProvider,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message as MessageType } from '../../types/message.js'
import {
  registerCodexLease,
  resetCodexLeaseManagerForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import {
  _resetAgentLifecycleOwnershipForTest,
  isAgentLifecycleOwned,
} from './agentLifecycleOwnership.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function poolAccount(accountId: string): PoolAccount {
  return {
    accountId,
    accessToken: `token-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 5 * 60_000,
    source: 'config',
    status: 'healthy',
    lastUsedAt: 0,
    credentialGeneration: 0,
    credentialGenerationState: 'legacy_unbound',
    usageFetchedAt: Date.now(),
  }
}

function assistantTerminal(model: string): MessageType {
  return {
    type: 'assistant',
    uuid: 'a0000000-0000-4000-8000-000000000001',
    requestId: 'req_terminal',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_terminal',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as MessageType
}

/**
 * Drive the real terminal gate: register a live lease for the worker, run the
 * lifecycle to completion, and read the account off the stored task result.
 */
async function runTerminal({
  taskId,
  model,
  mainLoopProvider,
  getWorktreeResult = async () => ({}),
}: {
  taskId: string
  model: string
  mainLoopProvider: 'openai' | 'firstParty' | undefined
  getWorktreeResult?: (
    appState: AppState,
  ) => Promise<{ worktreePath?: string; worktreeBranch?: string }>
}): Promise<{ accountId?: string } | undefined> {
  let appState: AppState = getDefaultAppState()
  appState = {
    ...appState,
    tasks: {
      ...appState.tasks,
      [taskId]: {
        type: 'local_agent',
        id: taskId,
        agentId: taskId,
        status: 'running',
        description: 'terminal account gate',
        prompt: 'go',
        agentType: 'general-purpose',
        startTime: Date.now(),
        retain: false,
        retrieved: false,
        isBackgrounded: true,
        pendingMessages: [],
        diskLoaded: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  }
  const rootSetAppState = (f: (prev: AppState) => AppState): void => {
    appState = f(appState)
  }

  const toolUseContext = {
    options: {
      tools: [],
      mainLoopModel: model,
      ...(mainLoopProvider ? { mainLoopProvider } : {}),
    },
    abortController: new AbortController(),
    toolUseId: 'toolu_terminal',
    getAppState: () => appState,
    setAppState: rootSetAppState,
  } as unknown as ToolUseContext

  await runAsyncAgentLifecycle({
    taskId,
    abortController: toolUseContext.abortController,
    // eslint-disable-next-line @typescript-eslint/require-await
    makeStream: async function* () {
      yield assistantTerminal(model)
    },
    metadata: {
      prompt: 'go',
      resolvedAgentModel: model,
      isBuiltInAgent: true,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: true,
    },
    description: 'terminal account gate',
    toolUseContext,
    rootSetAppState,
    agentIdForCleanup: taskId,
    enableSummarization: false,
    getWorktreeResult: () => getWorktreeResult(appState),
    parentTranscriptPath: join(tmpdir(), 'catcode-terminal-account.jsonl'),
    parentSessionId: 'session-terminal-account',
  })

  const task = appState.tasks[taskId] as
    | { result?: { account?: { accountId?: string } } }
    | undefined
  return task?.result?.account
}

describe('runAsyncAgentLifecycle terminal Codex account stamp', () => {
  beforeEach(() => {
    _resetAgentLifecycleOwnershipForTest()
    resetStateForTests()
    resetCodexLeaseManagerForTest()
    resetCodexAccountPoolForTest()
  })

  afterEach(() => {
    _resetAgentLifecycleOwnershipForTest()
    resetCodexLeaseManagerForTest()
    resetCodexAccountPoolForTest()
    setSessionProvider(null)
    resetStateForTests()
  })

  test('stamps the leased account on a Codex worker whose model is not gpt-prefixed', async () => {
    // A gpt worker spawning a background child hands the child
    // mainLoopProvider='openai' while the parent session stays on Anthropic
    // (runAgent.ts:764). The child leases and spends a Codex account, so the
    // stored result has to name it. Reading the process-global provider here
    // instead of the worker's own answers 'firstParty' and drops a true stamp.
    seedCodexAccountPoolForTest({
      accounts: [poolAccount('acct-1')],
      activeAccountId: 'acct-1',
    })
    setSessionProvider('firstParty')
    registerCodexLease({
      ownerId: 'agent_codex_child',
      ownerType: 'subagent',
      ownerLabel: 'terminal account gate',
    })

    const account = await runTerminal({
      taskId: 'agent_codex_child',
      model: 'claude-sonnet-5',
      mainLoopProvider: 'openai',
    })

    expect(account?.accountId).toBe('acct-1')
  })

  test('stamps nothing on an Anthropic worker inside a Codex session', async () => {
    // The other direction of the same gate. Registration is gated identically,
    // so an Anthropic worker normally holds no lease to snapshot; the lease is
    // planted here so the terminal gate is what the assertion reads, not the
    // absence of an account.
    seedCodexAccountPoolForTest({
      accounts: [poolAccount('acct-1')],
      activeAccountId: 'acct-1',
    })
    setSessionProvider('openai')
    registerCodexLease({
      ownerId: 'agent_anthropic_child',
      ownerType: 'subagent',
      ownerLabel: 'terminal account gate',
    })

    const account = await runTerminal({
      taskId: 'agent_anthropic_child',
      model: 'claude-sonnet-5',
      mainLoopProvider: 'firstParty',
    })

    expect(account).toBeUndefined()
  })

  test('holds lifecycle ownership after status publication until finalization settles', async () => {
    const finalizationStarted = deferred<void>()
    const finalizationRelease = deferred<void>()
    let statusDuringFinalization: string | undefined
    const lifecycle = runTerminal({
      taskId: 'agent_finalizing',
      model: 'claude-sonnet-5',
      mainLoopProvider: 'firstParty',
      getWorktreeResult: async appState => {
        statusDuringFinalization = appState.tasks.agent_finalizing?.status
        finalizationStarted.resolve()
        await finalizationRelease.promise
        return {}
      },
    })

    await finalizationStarted.promise
    expect(statusDuringFinalization).toBe('completed')
    expect(isAgentLifecycleOwned('agent_finalizing')).toBe(true)

    finalizationRelease.resolve()
    await lifecycle
    expect(isAgentLifecycleOwned('agent_finalizing')).toBe(false)
  })
})
