import { expect, test } from 'bun:test'
import type { MemoryFileInfo } from '../../src/utils/claudemd.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  MemorySnapshotFrame,
  ThreadGoalSnapshotFrame,
} from '../shared/protocol.js'
import { threadGoalSnapshot } from './goalDomain.js'
import { buildMemorySnapshot } from './memoryDomain.js'

test('builds a thread goal display snapshot with the engine summary text', () => {
  const snapshot = threadGoalSnapshot({
    threadId: 'thread-1',
    goalId: 'goal-1',
    objective: 'Finish P4-10',
    status: 'active',
    tokenBudget: 50_000,
    tokensUsed: 1_234,
    timeUsedSeconds: 42,
    createdAtMs: 1,
    updatedAtMs: 2,
  })

  expect(snapshot).toMatchObject({
    threadId: 'thread-1',
    goalId: 'goal-1',
    objective: 'Finish P4-10',
    status: 'active',
    tokenBudget: 50_000,
    tokensUsed: 1_234,
    timeUsedSeconds: 42,
  })
  expect(snapshot?.summary).toContain('Objective: Finish P4-10')
  expect(snapshot?.summary).toContain('Token budget: 50,000')

  const frame: ThreadGoalSnapshotFrame = {
    kind: 'thread-goal.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    goal: snapshot,
  }
  expect(scanForSecrets(frame).ok).toBe(true)
})

test('builds a memory metadata snapshot without exposing file contents', () => {
  const instructionFiles: MemoryFileInfo[] = [
    {
      path: '/repo/CLAUDE.md',
      type: 'Project',
      content: 'do not expose this body',
    },
    {
      path: '/repo/.cat-code/rules/testing.md',
      type: 'Project',
      content: 'do not expose this rule body',
      globs: ['app/**'],
      contentDiffersFromDisk: true,
    },
  ]

  const snapshot = buildMemorySnapshot({
    autoMemoryEnabled: true,
    autoMemoryDir: '/config/projects/repo/memory/',
    autoMemoryEntrypoint: '/config/projects/repo/memory/MEMORY.md',
    instructionFiles,
    autoMemories: [
      {
        filename: 'feedback_testing.md',
        filePath: '/config/projects/repo/memory/feedback_testing.md',
        mtimeMs: 123,
        description: 'Testing preference',
        type: 'feedback',
      },
    ],
  })

  const serialized = JSON.stringify(snapshot)
  expect(serialized).not.toContain('do not expose')
  expect(snapshot.instructionFiles[0]).toEqual({
    path: '/repo/CLAUDE.md',
    type: 'Project',
    contentDiffersFromDisk: false,
  })
  expect(snapshot.instructionFiles[1]).toMatchObject({
    path: '/repo/.cat-code/rules/testing.md',
    globs: ['app/**'],
    contentDiffersFromDisk: true,
  })
  expect(snapshot.autoMemories[0]).toMatchObject({
    filename: 'feedback_testing.md',
    description: 'Testing preference',
    type: 'feedback',
  })

  const frame: MemorySnapshotFrame = {
    kind: 'memory.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    memory: snapshot,
  }
  expect(scanForSecrets(frame).ok).toBe(true)
})
