import { expect, test } from 'bun:test'
import {
  agentFaceExpression,
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
  expect(deriveAgentModeWorkerState({ ...base, status: 'failed' })).toBe('failed')
  expect(deriveAgentModeWorkerState({ ...base, status: 'killed' })).toBe('stopped')
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

/* ── the face's state half (2026-08-19 subagent card) ─────────────────────── */

test('colour and expression are the state, and the pulse is only ever a running one', () => {
  expect(agentFaceExpression('running', { isLaunchRecord: false })).toEqual({
    eyes: 'open',
    tone: 'info',
    pulse: true,
  })
  expect(agentFaceExpression('completed', { isLaunchRecord: false })).toEqual({
    eyes: 'shut',
    tone: 'success',
    pulse: false,
  })
  // Failed and Stopped are told by colour alone — no sad face, no wince.
  expect(agentFaceExpression('failed', { isLaunchRecord: false })).toEqual({
    eyes: 'open',
    tone: 'danger',
    pulse: false,
  })
  expect(agentFaceExpression('stopped', { isLaunchRecord: false })).toEqual({
    eyes: 'open',
    tone: 'warning',
    pulse: false,
  })
})

test('eyes are state only — a nameless worker is featureless in its AXES, not shut', () => {
  // "Featureless" is `axesForName(null)`: no mouth, no marking, nothing to
  // individuate. Its EYES still follow the state, because otherwise "nobody has
  // told us who this is yet" and "this one is facing away" draw the same
  // picture. The design source draws the nameless running card wide awake.
  expect(agentFaceExpression('running', { isLaunchRecord: false }).eyes).toBe('open')
  expect(agentFaceExpression('completed', { isLaunchRecord: false }).eyes).toBe('shut')
  expect(agentFaceExpression('background', { isLaunchRecord: false }).eyes).toBe('closed')
})

test('a background launch that ERRORED reads as the failure it is, not as backgrounded', () => {
  // `deriveAgentToolState` returns `failed` for a launch whose tool_result came
  // back an error. Colouring it teal put "went to the background" on the face
  // beside line 2's "Failed".
  expect(agentFaceExpression('failed', { isLaunchRecord: true })).toEqual({
    eyes: 'open',
    tone: 'danger',
    pulse: false,
  })
})

test('a backgrounded worker faces away, and a launch RECORD is teal rather than blue', () => {
  // Both say "backgrounded" on the card, so the colour is what separates "this
  // is all we were ever told" from "this one is genuinely under way".
  const launch = agentFaceExpression('background', { isLaunchRecord: true })
  const resumed = agentFaceExpression('background', { isLaunchRecord: false })
  expect(launch).toEqual({ eyes: 'closed', tone: 'launch', pulse: false })
  expect(resumed).toEqual({ eyes: 'closed', tone: 'info', pulse: false })
})
