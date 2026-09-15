import { expect, test } from 'bun:test'
import { createTaskStateBase } from '../../src/Task.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { AgentToolResult } from '../../src/tools/AgentTool/agentToolUtils.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  createSidecarWorkersDomain,
  workersSnapshot,
} from './workersDomain.js'

function worker(over: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    ...createTaskStateBase('agent-1', 'local_agent', 'Inspect the module'),
    type: 'local_agent',
    status: 'running',
    agentId: 'agent-1',
    agentName: 'Turing',
    prompt: 'Inspect the module',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...over,
  }
}

function result(text: string): AgentToolResult {
  return {
    agentId: 'agent-1',
    content: [{ type: 'text', text }],
    totalToolUseCount: 0,
    totalDurationMs: 1,
    totalTokens: 1,
  }
}

test('projects only current local-agent tasks and preserves live worker fields', () => {
  const snapshot = workersSnapshot({
    first: worker({
      status: 'completed',
      handoffStatus: 'blocked',
      blockReason: 'The assistant must choose the next step.',
      verdict: 'PARTIAL',
      result: result('The module is partly complete.'),
    }),
    bash: {
      ...createTaskStateBase('bash-1', 'local_bash', 'echo hi'),
      type: 'local_bash',
      status: 'running',
      command: 'echo hi',
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    } as never,
  })

  expect(snapshot).toEqual({
    workers: [
      {
        agentId: 'agent-1',
        handle: 'Turing',
        role: 'general-purpose',
        status: 'completed',
        description: 'Inspect the module',
        isBackgrounded: true,
        handoffStatus: 'blocked',
        blockReason: 'The assistant must choose the next step.',
        verdict: 'PARTIAL',
        resultSummary: 'The module is partly complete.',
      },
    ],
  })
})

test('folds pending workers to running and bounds text-only result summaries', () => {
  const snapshot = workersSnapshot({
    pending: worker({
      status: 'pending',
      result: result('x'.repeat(3_000)),
    }),
  })

  const item = snapshot.workers[0]!
  expect(item.status).toBe('running')
  expect(item.resultSummary).toHaveLength(2_048)
  expect(typeof item.resultSummary).toBe('string')
})

test('omits a result summary when the engine result contains a secret key', () => {
  const unsafeResult = {
    ...result('Do not publish this result.'),
    accessToken: 'secret',
  } as unknown as AgentToolResult
  const snapshot = workersSnapshot({
    unsafe: worker({ result: unsafeResult }),
  })

  expect(snapshot.workers[0]).not.toHaveProperty('resultSummary')
  expect(scanForSecrets(snapshot).ok).toBe(true)
})

test('the domain reads and subscribes to the same app-state store', () => {
  const store = createStore({ ...getDefaultAppState(), tasks: {} })
  const domain = createSidecarWorkersDomain(store)
  let changes = 0
  const unsubscribe = domain.subscribe(() => {
    changes += 1
  })

  store.setState(previous => ({
    ...previous,
    tasks: { one: worker() },
  }))
  expect(changes).toBe(1)
  expect(domain.getSnapshot().workers[0]?.agentId).toBe('agent-1')

  unsubscribe()
})
