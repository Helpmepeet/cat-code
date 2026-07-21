import { expect, test } from 'bun:test'
import {
  agentStateMeta,
  agentTypeMeta,
  deriveAgentDisplayVocabulary,
  deriveAgentModeWorkerState,
  deriveAgentState,
  deriveAgentToolState,
  deriveTaskAgentState,
  resolveAgentIdentity,
} from './agentIdentity.js'

test('keeps the prototype label, color, and pip vocabulary for known states', () => {
  expect(agentStateMeta('running')).toMatchObject({
    label: 'Running',
    color: '#60a5fa',
    icon: 'pip-pulse',
  })
  expect(agentStateMeta('needs-you')).toMatchObject({
    label: 'Needs you',
    color: '#fbbf24',
    icon: 'pip-fill',
    attention: true,
  })
  expect(agentStateMeta('result-ready')).toMatchObject({
    label: 'Result ready',
    color: '#4ade80',
    icon: 'pip-ring',
    attention: true,
  })
})

test('maps known real agent types and leaves fixture-only or future types neutral', () => {
  expect(agentTypeMeta('verification')).toMatchObject({
    label: 'Verification',
    color: '#5eead4',
  })
  expect(agentTypeMeta('Explore')).toMatchObject({
    label: 'Explore',
    color: '#7dd3fc',
  })
  expect(agentTypeMeta('agent-mode-coding-worker')).toMatchObject({
    label: 'Coding worker',
    color: '#a78bfa',
    compressedFrom: 'agent-mode-coding-worker',
  })
  expect(agentTypeMeta('Plan')).toMatchObject({
    label: 'Plan',
    color: '#a1a1aa',
  })
  expect(agentTypeMeta(undefined)).toBeNull()
})

test('resolves identity from real worker, local-agent task, teammate, and Agent tool fields', () => {
  expect(
    resolveAgentIdentity({
      agentId: 'agent-123',
      handle: '@Ada',
      role: 'agent-mode-coding-worker',
      description: 'Patch renderer state',
    }),
  ).toEqual({
    hasName: true,
    name: 'Ada',
    handle: '@Ada',
    type: 'agent-mode-coding-worker',
    description: 'Patch renderer state',
    id: 'agent-123',
  })

  expect(
    resolveAgentIdentity({
      type: 'local_agent',
      id: 'task-a1',
      agentId: 'agent-456',
      agentName: 'Grace',
      agentType: 'verification',
      prompt: 'Verify changed files',
    }),
  ).toMatchObject({
    name: 'Grace',
    handle: '@Grace',
    type: 'verification',
    description: 'Verify changed files',
    id: 'agent-456',
  })

  expect(
    resolveAgentIdentity({
      type: 'in_process_teammate',
      identity: {
        agentId: 'researcher@team',
        agentName: 'researcher',
      },
      selectedAgent: undefined,
      prompt: 'Search for source anchors',
    }),
  ).toMatchObject({
    name: 'researcher',
    handle: '@researcher',
    id: 'researcher@team',
    description: 'Search for source anchors',
  })

  expect(
    resolveAgentIdentity({
      toolName: 'Agent',
      status: 'pending',
      subagent_type: 'implementor',
      description: 'Implement the slice',
    }),
  ).toMatchObject({
    hasName: false,
    name: null,
    handle: null,
    type: 'implementor',
    description: 'Implement the slice',
  })
})

test('compresses durable Agent Mode worker sessions using workerUxSummary semantics', () => {
  const base = {
    agentId: 'agent-a',
    handle: 'Ada',
    role: 'agent-mode-coding-worker',
    description: 'Patch renderer state',
    worktreePath: null,
  }

  expect(deriveAgentModeWorkerState({ ...base, status: 'running' })).toBe('running')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      synthesisStatus: 'pending',
    }),
  ).toBe('result-ready')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      synthesisStatus: 'synthesized',
    }),
  ).toBe('reviewed')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      origin: 'prior',
      resumable: true,
    }),
  ).toBe('resumable')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      origin: 'prior',
      resumable: false,
    }),
  ).toBe('stale')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      origin: 'prior',
    }),
  ).toBe('completed')
  expect(
    deriveAgentModeWorkerState({
      ...base,
      status: 'completed',
      origin: 'prior',
      synthesisStatus: 'pending',
    }),
  ).toBe('result-ready')
  expect(deriveAgentModeWorkerState({ ...base, status: 'failed' })).toBe('attention')
  expect(deriveAgentModeWorkerState({ ...base, status: 'killed' })).toBe('attention')
})

test('maps a blocked local_agent task to the solo needs-you state (no orchestrator context here)', () => {
  const blockedTask = {
    type: 'local_agent' as const,
    id: 'task-a1',
    status: 'completed' as const,
    description: 'Need decision',
    agentId: 'agent-a1',
    agentType: 'general-purpose',
    prompt: 'Investigate issue',
    isBackgrounded: true,
    handoffStatus: 'blocked' as const,
  }

  // B6 (2026-07-12 review): this function has no `active`/orchestrator
  // context, so a blocked local_agent task always reads the solo 'needs-you'.
  // The orchestrator-owned neutral 'waiting' state is derived separately by
  // `orchestratorState.ts`'s `orchestratorWorkerState`, which HAS the
  // `active` flag (see orchestratorState.test.ts).
  expect(deriveTaskAgentState(blockedTask)).toBe('needs-you')
})

test('maps real task lifecycle and attention fields without prototype activity fixtures', () => {
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a2',
      status: 'pending',
      description: 'Run in background',
      agentType: 'implementor',
      isBackgrounded: true,
    }),
  ).toBe('background')
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a3',
      status: 'running',
      description: 'Resumed worker',
      agentType: 'general-purpose',
      resumedAt: 123,
    }),
  ).toBe('resumed')
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a3b',
      status: 'running',
      description: 'Backgrounded worker',
      agentType: 'general-purpose',
      isBackgrounded: true,
    }),
  ).toBe('background')
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a3c',
      status: 'running',
      description: 'Backgrounded resumed worker',
      agentType: 'general-purpose',
      isBackgrounded: true,
      resumedAt: 123,
    }),
  ).toBe('background')
  expect(
    deriveTaskAgentState({
      type: 'in_process_teammate',
      id: 'task-t1',
      status: 'running',
      description: 'Teammate',
      identity: { agentName: 'researcher', agentId: 'researcher@team' },
      awaitingPlanApproval: true,
    }),
  ).toBe('needs-you')
  expect(
    deriveTaskAgentState({
      type: 'in_process_teammate',
      id: 'task-t2',
      status: 'running',
      description: 'Teammate',
      identity: { agentName: 'writer', agentId: 'writer@team' },
      isIdle: true,
    }),
  ).toBe('paused')
  expect(
    deriveTaskAgentState({
      type: 'remote_agent',
      id: 'task-r1',
      status: 'running',
      description: 'Remote plan',
      title: 'Remote plan',
      sessionId: 'remote-session',
      ultraplanPhase: 'plan_ready',
    }),
  ).toBe('needs-you')
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a4',
      status: 'killed',
      description: 'Stopped agent',
      agentType: 'Explore',
    }),
  ).toBe('stopped')
  expect(
    deriveTaskAgentState({
      type: 'local_agent',
      id: 'task-a5',
      status: 'future-status',
      description: 'Unknown future status',
      agentType: 'Explore',
    } as never),
  ).toBe('stopped')
})

test('maps Agent tool cards from real tool input and correlation status only', () => {
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'pending',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
    }),
  ).toBe('background')
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'pending',
      subagent_type: 'Explore',
      description: 'Map files',
    }),
  ).toBe('running')
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'success',
      subagent_type: 'Explore',
      description: 'Map files',
    }),
  ).toBe('completed')
  expect(
    deriveAgentToolState({
      toolName: 'Task',
      status: 'error',
      subagent_type: 'general-purpose',
      description: 'Map files',
    }),
  ).toBe('failed')
})

test('returns complete display vocabulary for P4-8 and P4-9 consumers', () => {
  const display = deriveAgentDisplayVocabulary({
    agentId: 'agent-a',
    handle: 'Ada',
    role: 'agent-mode-coding-worker',
    description: 'Patch renderer state',
    status: 'completed',
    synthesisStatus: 'pending',
    worktreePath: null,
  })

  expect(display).toMatchObject({
    identity: {
      handle: '@Ada',
      type: 'agent-mode-coding-worker',
      description: 'Patch renderer state',
    },
    type: {
      label: 'Coding worker',
      color: '#a78bfa',
    },
    state: {
      label: 'Result ready',
      icon: 'pip-ring',
      attention: true,
    },
  })
})

test('declares prototype-only fields that must not become vocabulary inputs', () => {
  expect(
    deriveAgentState({
      agentId: 'agent-a',
      handle: 'Ada',
      role: 'agent-mode-coding-worker',
      description: 'Ignores prototype extras',
      status: 'running',
      worktreePath: null,
      files: ['fake.ts'],
      up: 10,
      down: 3,
      progress: [{ label: 'demo' }],
    }),
  ).toBe('running')
})
