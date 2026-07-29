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
  agentMemories: [
    {
      agentType: 'Explore',
      scope: 'user',
      directory: '/config/agent-memory/Explore/',
      fileCount: 3,
    },
  ],
  notes: ['Memory bodies stay engine-side.'],
}

test('renders the current thread goal snapshot', () => {
  const html = renderToStaticMarkup(<GoalsPage snapshot={GOAL} />)

  expect(html).toContain('Ship P4-10 Goals + Memory panels')
  expect(html).toContain('25,000')
  expect(html).toContain('1,250')
  expect(html).toContain('Read-only')
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
  expect(html).not.toContain('do not expose')
  expect(html).not.toContain('MOCK')
  // The panel used to render three sentences about what the read withholds and
  // which writers are undesigned, under a heading called "Scope" (CLAUDE.md §7).
  expect(html).not.toContain('Memory bodies stay engine-side')
  expect(html).not.toContain('>Scope<')
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
  // The engine's own type tokens are expanded before they reach the page.
  const LABEL: Record<string, string> = {
    AutoMem: 'Auto memory',
    TeamMem: 'Team memory',
  }
  for (const type of instructionTypes) {
    const label = LABEL[type] ?? type
    expect(html).toContain(label)
    expect(html).toContain(`${label}</span><span class="float-right font-mono text-text-muted">1</span>`)
  }
  expect(html).not.toContain('>AutoMem<')
  expect(html).not.toContain('>TeamMem<')
  for (const label of autoMemoryTypes) {
    expect(html).toContain(`${label}.md`)
  }
})

/* ── agent memory (P4-34) ─────────────────────────────────────────────────── */

test('agent-memory rows show a known role as its chip and an unknown one as its name', () => {
  const memory: MemorySnapshot = {
    ...MEMORY,
    agentMemories: [
      {
        agentType: 'Explore',
        scope: 'user',
        directory: '/config/agent-memory/Explore/',
        fileCount: 4,
      },
      {
        // A user-defined agent outside the known palette: `AgentTypeChip`
        // renders nothing for it, so the row must still name it.
        agentType: 'my-plugin-reviewer',
        scope: 'project',
        directory: '/repo/.cat-code/agent-memory/my-plugin-reviewer/',
        fileCount: 1,
      },
    ],
  }
  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={memory} />)

  expect(html).toContain('Agent memory')
  expect(html).toContain('2 agents')
  expect(html).toContain('/config/agent-memory/Explore/')
  expect(html).toContain('/repo/.cat-code/agent-memory/my-plugin-reviewer/')
  expect(html).toContain('my-plugin-reviewer')
  // Counts are pluralised per row, not once for the section.
  expect(html).toContain('4 files')
  expect(html).toContain('1 file')
})

test('one agent reads as one agent, and none renders no section at all', () => {
  const one = renderToStaticMarkup(
    <MemoryPage
      embedded
      snapshot={{
        ...MEMORY,
        agentMemories: [
          {
            agentType: 'Explore',
            scope: 'local',
            directory: '/repo/.cat-code/agent-memory-local/Explore/',
            fileCount: 0,
          },
        ],
      }}
    />,
  )
  expect(one).toContain('1 agent')
  expect(one).not.toContain('1 agents')
  // A declared scope that has never been written to is a real row reading zero.
  expect(one).toContain('0 files')

  const none = renderToStaticMarkup(
    <MemoryPage embedded snapshot={{ ...MEMORY, agentMemories: [] }} />,
  )
  expect(none).not.toContain('Agent memory')
})

test('renders memory waiting state without fixtures', () => {
  const html = renderToStaticMarkup(<MemoryPage embedded snapshot={null} />)

  expect(html).toContain('No memory loaded')
  expect(html).toContain('Open a session')
  expect(html).not.toContain('MOCK')
  // CLAUDE.md §7 — the empty state must not print internal vocabulary at the
  // user (the copy it replaced named the sidecar and the prototype fixtures).
  for (const leak of ['sidecar', 'prototype', 'redacted', 'snapshot']) {
    expect(html).not.toContain(leak)
  }
})
