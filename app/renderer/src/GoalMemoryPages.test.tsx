import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  MemorySnapshot,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'
import { GoalsPage } from './GoalsPage.js'
import { MemoryPage } from './MemoryPage.js'

const GOAL: ThreadGoalSnapshot = {
  threadId: 'thread-1',
  goalId: 'goal-1',
  objective: 'Ship P4-10 Goals + Memory panels',
  status: 'active',
  tokenBudget: 25_000,
  tokensUsed: 1_250,
  timeUsedSeconds: 30,
  createdAtMs: 1,
  updatedAtMs: 2,
  summary:
    'Goal: active\nObjective: Ship P4-10 Goals + Memory panels\nToken budget: 25,000\nTokens used: 1,250\nTime used: 30s',
}

const MEMORY: MemorySnapshot = {
  autoMemoryEnabled: true,
  autoMemoryDir: '/config/projects/repo/memory/',
  autoMemoryEntrypoint: '/config/projects/repo/memory/MEMORY.md',
  instructionFiles: [
    { path: '/repo/CLAUDE.md', type: 'Project', contentDiffersFromDisk: false },
    {
      path: '/repo/.cat-code/rules/migration.md',
      type: 'Project',
      globs: ['app/**'],
      contentDiffersFromDisk: false,
    },
  ],
  autoMemories: [
    {
      filename: 'feedback_testing.md',
      filePath: '/config/projects/repo/memory/feedback_testing.md',
      mtimeMs: 1,
      description: 'Testing preference',
      type: 'feedback',
    },
  ],
  notes: ['Memory bodies stay engine-side.'],
}

test('renders the current thread goal snapshot', () => {
  const html = renderToStaticMarkup(<GoalsPage snapshot={GOAL} />)

  expect(html).toContain('Ship P4-10 Goals + Memory panels')
  expect(html).toContain('25,000')
  expect(html).toContain('1,250')
  expect(html).toContain('Read-only snapshot')
  expect(html).toContain('/goal')
})

test('renders the empty goal state without fixtures', () => {
  const html = renderToStaticMarkup(<GoalsPage snapshot={null} />)

  expect(html).toContain('No active thread goal')
  expect(html).not.toContain('MOCK')
})

test('renders memory metadata without file contents', () => {
  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={MEMORY} />)

  expect(html).toContain('instruction files')
  expect(html).toContain('/repo/CLAUDE.md')
  expect(html).toContain('feedback_testing.md')
  expect(html).toContain('Testing preference')
  expect(html).toContain('Memory bodies stay engine-side')
  expect(html).not.toContain('do not expose')
  expect(html).not.toContain('MOCK')
})

test('renders memory waiting state without fixtures', () => {
  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={null} />)

  expect(html).toContain("Waiting for the engine&#x27;s memory snapshot")
  expect(html).not.toContain('MOCK')
})
