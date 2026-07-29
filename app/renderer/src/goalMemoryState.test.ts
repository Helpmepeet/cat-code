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
  selectMemorySnapshot,
  selectThreadGoalSnapshot,
} from './goalMemoryState.js'

const GOAL: ThreadGoalSnapshot = {
  threadId: 'thread-1',
  goalId: 'goal-1',
  objective: 'Ship P4-10',
  status: 'active',
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
    protocolVersion: 1,
    sessionId,
    goal,
  }
}

function memoryFrame(sessionId: SessionId, memory: MemorySnapshot): ServerFrame {
  return {
    kind: 'memory.snapshot',
    protocolVersion: 1,
    sessionId,
    memory,
  }
}

function lifecycleFrame(sessionId: SessionId): ServerFrame {
  return {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId,
    status: 'disconnected',
  }
}

test('reduces goal and memory snapshots by session id', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('a', GOAL),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: memoryFrame('a', MEMORY),
  })

  expect(selectThreadGoalSnapshot(state, 'a')?.objective).toBe('Ship P4-10')
  expect(selectMemorySnapshot(state, 'a')?.autoMemories).toHaveLength(1)
  expect(selectThreadGoalSnapshot(state, 'missing')).toBeNull()
  expect(selectMemorySnapshot(state, 'missing')).toBeNull()
})

test('clears known snapshots on lifecycle reset', () => {
  let state = reduceGoalMemoryState(createGoalMemoryState(), {
    type: 'frame',
    frame: goalFrame('a', GOAL),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: memoryFrame('a', MEMORY),
  })
  state = reduceGoalMemoryState(state, {
    type: 'frame',
    frame: lifecycleFrame('a'),
  })

  expect(selectThreadGoalSnapshot(state, 'a')).toBeNull()
  expect(selectMemorySnapshot(state, 'a')).toBeNull()
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
