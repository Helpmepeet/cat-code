import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { expect, test } from 'bun:test'
import type {
  MemorySnapshot,
  ServerFrame,
  SessionId,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'
import {
  createGoalMemoryState,
  reduceGoalMemoryState,
  selectInstructionFilesByType,
  selectMemoryInstructionCounts,
  selectThreadGoalRows,
  selectThreadGoalSnapshot,
} from './goalMemoryState.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

const GOAL: ThreadGoalSnapshot = {
  threadId: 'thread-1',
  goalId: 'goal-1',
  objective: 'Ship P4-10',
  status: 'active',
  revision: 1,
  continuationTurns: 0,
  maxContinuationTurns: 20,
  statusNote: null,
  tokenBudget: 10_000,
  tokensUsed: 10,
  timeUsedSeconds: 2,
  createdAtMs: 1,
  updatedAtMs: 2,
  summary: 'Goal: active\nObjective: Ship P4-10',
}

const MEMORY: MemorySnapshot = {
  autoMemoryEnabled: true,
  autoMemoryDir: '/config/memory/',
  autoMemoryEntrypoint: '/config/memory/MEMORY.md',
  instructionFiles: [
    { path: '/repo/CLAUDE.md', type: 'Project', contentDiffersFromDisk: false },
    { path: '/user/CLAUDE.md', type: 'User', contentDiffersFromDisk: false },
    { path: '/repo/CLAUDE.local.md', type: 'Local', contentDiffersFromDisk: true },
  ],
  autoMemories: [
    {
      filename: 'feedback_testing.md',
      filePath: '/config/memory/feedback_testing.md',
      mtimeMs: 1,
      description: 'Testing preference',
      type: 'feedback',
    },
  ],
  agentMemories: [],
  notes: [],
}

function goalFrame(sessionId: SessionId, goal: ThreadGoalSnapshot | null): ServerFrame {
  return {
    kind: 'thread-goal.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    goal,
  }
}

function lifecycleFrame(sessionId: SessionId): ServerFrame {
  return {
    kind: 'lifecycle',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    status: 'disconnected',
  }
}

test('reduces goal snapshots by session id', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('a', GOAL),
  })

  expect(selectThreadGoalSnapshot(state, 'a')?.objective).toBe('Ship P4-10')
  expect(selectThreadGoalSnapshot(state, 'missing')).toBeNull()
})

test('retains goals on lifecycle reset', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('a', GOAL),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: lifecycleFrame('a'),
  })

  expect(selectThreadGoalSnapshot(state, 'a')).toEqual(GOAL)
})

test('aggregates roster goals by appSessionId in catalog order', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('app-a', GOAL),
  })
  const secondGoal = { ...GOAL, goalId: 'goal-2', objective: 'Review beta' }
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: goalFrame('app-b', secondGoal),
  })

  const roster = [
    {
      sessionId: 'engine-a',
      appSessionId: 'app-a',
      cwd: '/workspace/alpha',
      displayLabel: 'Alpha session',
    },
    {
      sessionId: 'engine-b',
      appSessionId: 'app-b',
      cwd: '/workspace/beta',
      displayLabel: 'Beta session',
    },
  ] satisfies Array<
    Pick<MergedSessionRow, 'sessionId' | 'appSessionId' | 'cwd' | 'displayLabel'>
  >

  expect(selectThreadGoalRows(state, roster)).toEqual([
    {
      appSessionId: 'app-a',
      cwd: '/workspace/alpha',
      displayLabel: 'Alpha session',
      goal: GOAL,
    },
    {
      appSessionId: 'app-b',
      cwd: '/workspace/beta',
      displayLabel: 'Beta session',
      goal: secondGoal,
    },
  ])
})

test('excludes stale goals, history rows, and roster rows with null goals', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('stale', GOAL),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: goalFrame('cleared', null),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: goalFrame('visible', { ...GOAL, goalId: 'visible-goal' }),
  })

  const roster = [
    {
      sessionId: 'engine-cleared',
      appSessionId: 'cleared',
      cwd: '/workspace/cleared',
      displayLabel: 'Cleared session',
    },
    {
      sessionId: 'engine-history',
      appSessionId: null,
      cwd: '/workspace/history',
      displayLabel: 'History session',
    },
    {
      sessionId: 'engine-visible',
      appSessionId: 'visible',
      cwd: '/workspace/visible',
      displayLabel: 'Visible session',
    },
  ] satisfies Array<
    Pick<MergedSessionRow, 'sessionId' | 'appSessionId' | 'cwd' | 'displayLabel'>
  >

  expect(selectThreadGoalRows(state, roster).map(row => row.displayLabel)).toEqual([
    'Visible session',
  ])
})

test('a fresh null goal snapshot clears a retained goal', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('a', GOAL),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: lifecycleFrame('a'),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: goalFrame('a', null),
  })

  expect(selectThreadGoalSnapshot(state, 'a')).toBeNull()
})

test('preserves state identity for an untracked lifecycle session', () => {
  const state = createGoalMemoryState()

  expect(
    reduceGoalMemoryState(state, {
      type: 'frame',
      frame: lifecycleFrame('untracked'),
    }),
  ).toBe(state)
})

test('selects memory counts and groups', () => {
  expect(selectMemoryInstructionCounts(MEMORY)).toEqual({
    total: 3,
    managed: 0,
    user: 1,
    project: 1,
    local: 1,
    autoMem: 0,
    teamMem: 0,
  })
  expect(selectInstructionFilesByType(MEMORY).map(group => group.type)).toEqual([
    'Project',
    'User',
    'Local',
  ])
})
