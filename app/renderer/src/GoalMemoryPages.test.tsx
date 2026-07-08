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

const GOAL_BY_STATUS: ThreadGoalSnapshot[] = [
  { ...GOAL, status: 'active', summary: 'Goal: active' },
  { ...GOAL, status: 'paused', summary: 'Goal: paused' },
  { ...GOAL, status: 'budget_limited', summary: 'Goal: limited by budget' },
  { ...GOAL, status: 'complete', summary: 'Goal: complete' },
]

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

test('renders every thread-goal status label and summary', () => {
  for (const goal of GOAL_BY_STATUS) {
    const html = renderToStaticMarkup(<GoalsPage snapshot={goal} />)
    const label = goal.status === 'budget_limited' ? 'budget limited' : goal.status
    expect(html).toContain(label)
    expect(html).toContain(goal.summary)
  }
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

test('renders every memory instruction and auto-memory type', () => {
  const instructionTypes = [
    'Managed',
    'User',
    'Project',
    'Local',
    'AutoMem',
    'TeamMem',
  ] as const satisfies readonly MemorySnapshot['instructionFiles'][number]['type'][]
  const autoMemoryTypes = [
    'user',
    'feedback',
    'project',
    'reference',
  ] as const satisfies readonly NonNullable<MemorySnapshot['autoMemories'][number]['type']>[]
  const memory: MemorySnapshot = {
    ...MEMORY,
    instructionFiles: instructionTypes.map(type => ({
      path: `/memory/${type}.md`,
      type,
      contentDiffersFromDisk: type === 'AutoMem',
    })),
    autoMemories: autoMemoryTypes.map(type => ({
      filename: `${type}.md`,
      filePath: `/config/memory/${type}.md`,
      mtimeMs: 1,
      description: `${type} description`,
      type,
    })),
  }

  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={memory} />)
  for (const label of instructionTypes) {
    expect(html).toContain(label)
    expect(html).toContain(`${label}</span><span class="float-right font-mono text-text-muted">1</span>`)
  }
  for (const label of autoMemoryTypes) {
    expect(html).toContain(`${label}.md`)
  }
})

test('renders memory waiting state without fixtures', () => {
  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={null} />)

  expect(html).toContain("Waiting for the engine&#x27;s memory snapshot")
  expect(html).not.toContain('MOCK')
})
