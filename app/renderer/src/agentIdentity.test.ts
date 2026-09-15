import { expect, test } from 'bun:test'
import {
  agentFacePulse,
  agentStateMeta,
  agentTypeMeta,
  deriveAgentDisplayVocabulary,
  deriveWorkerState,
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
  expect(agentTypeMeta('coding-worker')).toMatchObject({
    label: 'Coding worker',
    color: '#a78bfa',
  })
  expect(agentTypeMeta('Plan')).toMatchObject({
    label: 'Plan',
    color: '#a1a1aa',
  })
  expect(agentTypeMeta(undefined)).toBeNull()
})

test('treats prototype-chain agent types as neutral without changing known metadata', () => {
  expect(agentTypeMeta('verification')).toMatchObject({
    label: 'Verification',
    tone: 'teal',
    color: '#5eead4',
  })
  expect(agentTypeMeta('toString')).toEqual({
    key: 'toString',
    label: 'toString',
    tone: 'neutral',
    color: '#a1a1aa',
    soft: 'rgba(161,161,170,0.08)',
    line: 'rgba(161,161,170,0.22)',
  })
  expect(agentTypeMeta('__proto__')).toEqual({
    key: '__proto__',
    label: '__proto__',
    tone: 'neutral',
    color: '#a1a1aa',
    soft: 'rgba(161,161,170,0.08)',
    line: 'rgba(161,161,170,0.22)',
  })
})

test('resolves identity from real worker, local-agent task, teammate, and Agent tool fields', () => {
  expect(
    resolveAgentIdentity({
      agentId: 'agent-123',
      handle: '@Ada',
      role: 'coding-worker',
      description: 'Patch renderer state',
    }),
  ).toEqual({
    hasName: true,
    name: 'Ada',
    type: 'coding-worker',
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
    type: 'implementor',
    description: 'Implement the slice',
  })
})

test('identity offers no at-signed form of a name, whatever the wire sent', () => {
  // Operator ruling, 2026-08-21: the at-sign is engine mention syntax and never
  // reaches the screen. The resolver is the choke point, so it must not hand any
  // caller a prefixed string to render — an unused `handle` field is one edit
  // away from being printed again.
  for (const source of [{ handle: '@Ada' }, { handle: 'Ada' }, { agentName: '@Grace' }]) {
    const identity = resolveAgentIdentity(source)
    expect(identity.name).not.toContain('@')
    expect(Object.values(identity).filter(value => typeof value === 'string')).not.toContain(
      `@${identity.name}`,
    )
  }
})

test('compresses live worker sessions from status, handoff and backgrounding alone', () => {
  const base = {
    agentId: 'agent-a',
    handle: 'Ada',
    role: 'coding-worker',
    description: 'Patch renderer state',
  }

  expect(deriveWorkerState({ ...base, status: 'running' })).toBe('running')
  // A blocked handoff outranks every other input: the worker is parked waiting
  // on its parent loop, whatever its own run status says.
  expect(
    deriveWorkerState({
      ...base,
      status: 'running',
      handoffStatus: 'blocked',
    }),
  ).toBe('waiting')
  expect(
    deriveWorkerState({
      ...base,
      status: 'completed',
      handoffStatus: 'blocked',
    }),
  ).toBe('waiting')
  expect(
    deriveWorkerState({
      ...base,
      status: 'running',
      isBackgrounded: true,
    }),
  ).toBe('background')
  expect(
    deriveWorkerState({
      ...base,
      status: 'completed',
      handoffStatus: 'done',
    }),
  ).toBe('completed')
  expect(deriveWorkerState({ ...base, status: 'failed' })).toBe('failed')
  expect(deriveWorkerState({ ...base, status: 'killed' })).toBe('stopped')
})

test('maps a blocked local_agent task to waiting-on-the-assistant, never to needs-you', () => {
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

  // A blocked subagent waits on the assistant that delegated it: its result text
  // is queued to the parent conversation and drained into a fresh turn with no
  // human action. This returned the amber 'needs-you' until 2026-08-09, which
  // told the user to answer a handoff already addressed to the model.
  expect(deriveTaskAgentState(blockedTask)).toBe('waiting')
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

test('a backgrounded agent stays background until its real completion lands, never fake-completed off the launch ack', () => {
  // The launch itself resolves with a `success` tool_result the instant the
  // background run is scheduled (`AgentTool.tsx` "Return async_launched result
  // immediately") — that is NOT the agent finishing.
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'success',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
    }),
  ).toBe('background')
  // A launch that fails synchronously still reports failed immediately.
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'error',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
    }),
  ).toBe('failed')
  // Once the real task-notification lands, the completion's own outcome wins,
  // regardless of the stale launch-ack tool status.
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'success',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
      hasCompletion: true,
      completionStatus: 'completed',
    }),
  ).toBe('completed')
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'success',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
      hasCompletion: true,
      completionStatus: 'failed',
    }),
  ).toBe('failed')
  expect(
    deriveAgentToolState({
      toolName: 'Agent',
      status: 'success',
      subagent_type: 'Explore',
      description: 'Map files',
      run_in_background: true,
      hasCompletion: true,
      completionStatus: 'killed',
    }),
  ).toBe('stopped')
})

test('returns complete display vocabulary for P4-8 and P4-9 consumers', () => {
  const display = deriveAgentDisplayVocabulary({
    agentId: 'agent-a',
    handle: 'Ada',
    role: 'coding-worker',
    description: 'Patch renderer state',
    status: 'completed',
    handoffStatus: 'done',
  })

  expect(display).toMatchObject({
    identity: {
      name: 'Ada',
      type: 'coding-worker',
      description: 'Patch renderer state',
    },
    type: {
      label: 'Coding worker',
      color: '#a78bfa',
    },
    state: {
      label: 'Completed',
      icon: 'pip-fill',
      attention: false,
    },
  })
})

test('declares prototype-only fields that must not become vocabulary inputs', () => {
  expect(
    deriveAgentState({
      agentId: 'agent-a',
      handle: 'Ada',
      role: 'coding-worker',
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

/* ── the face's identity half (2026-08-21 ruling) ─────────────────────────── */

test('the pulse is the only state left on the face', () => {
  // Motion is the card's only at-a-glance mark of a live worker, and a launch
  // record is not a live worker: it reports that a run began.
  expect(agentFacePulse('running', { isLaunchRecord: false })).toBe(true)
  expect(agentFacePulse('running', { isLaunchRecord: true })).toBe(false)
  for (const state of ['completed', 'background', 'failed', 'stopped'] as const) {
    expect(agentFacePulse(state, { isLaunchRecord: false })).toBe(false)
  }
})



