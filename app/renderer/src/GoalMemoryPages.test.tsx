import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  MemorySnapshot,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'
import type { ThreadGoalRow } from './goalMemoryState.js'
import { GoalsPage } from './GoalsPage.js'
import { MemoryPage } from './MemoryPage.js'

const GOAL: ThreadGoalSnapshot = {
  threadId: 'thread-1',
  goalId: 'goal-1',
  objective: 'Ship P4-10 Goals + Memory panels',
  status: 'active',
  revision: 1,
  continuationTurns: 0,
  maxContinuationTurns: 20,
  statusNote: null,
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
  { ...GOAL, status: 'waiting', summary: 'Goal: waiting' },
  { ...GOAL, status: 'paused', summary: 'Goal: paused' },
  { ...GOAL, status: 'blocked', summary: 'Goal: blocked' },
  { ...GOAL, status: 'stalled', summary: 'Goal: stalled' },
  { ...GOAL, status: 'budget_limited', summary: 'Goal: limited by budget' },
  { ...GOAL, status: 'usage_limited', summary: 'Goal: limited by usage' },
  { ...GOAL, status: 'failed', summary: 'Goal: failed' },
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

function goalRow(
  goal: ThreadGoalSnapshot,
  appSessionId: string,
  displayLabel: string,
  cwd: string,
): ThreadGoalRow {
  return { appSessionId, cwd, displayLabel, goal }
}

test('renders two sessions with labels, workspaces, objectives, and counts', () => {
  const html = renderToStaticMarkup(
    <GoalsPage
      rows={[
        goalRow(GOAL, 'app-alpha', 'Alpha session', '/workspace/alpha'),
        goalRow(
          {
            ...GOAL,
            goalId: 'goal-2',
            objective: 'Review beta workspace',
            status: 'complete',
            summary: 'Goal: complete\nObjective: Review beta workspace',
          },
          'app-beta',
          'Beta session',
          '/workspace/beta',
        ),
      ]}
    />,
  )

  expect(html).toContain('One goal per session across all sessions')
  expect(html).toContain('1 ongoing')
  expect(html).toContain('1 complete')
  expect(html).toContain('Alpha session')
  expect(html).toContain('/workspace/alpha')
  expect(html).toContain('Beta session')
  expect(html).toContain('/workspace/beta')
  expect(html).toContain('Ship P4-10 Goals + Memory panels')
  expect(html).toContain('Review beta workspace')
  expect(html).toContain('25,000')
  expect(html).toContain('1,250')
  expect(html).toContain('Read-only')
  expect(html).toContain('/goal')
  expect(html).not.toContain('app-alpha')
  expect(html).not.toContain('app-beta')
})

test('renders every thread-goal status label and summary', () => {
  const labels: Record<ThreadGoalSnapshot['status'], string> = {
    active: 'active',
    waiting: 'waiting',
    paused: 'paused',
    blocked: 'blocked',
    stalled: 'stalled',
    budget_limited: 'budget limited',
    usage_limited: 'usage limited',
    failed: 'failed',
    complete: 'complete',
  }
  for (const goal of GOAL_BY_STATUS) {
    const html = renderToStaticMarkup(
      <GoalsPage rows={[goalRow(goal, 'app-status', 'Status session', '/workspace/status')]} />,
    )
    expect(html).toContain(labels[goal.status])
    expect(html).toContain(goal.summary)
  }
})

test('renders the global empty goal state without fixtures', () => {
  const html = renderToStaticMarkup(<GoalsPage rows={[]} />)

  expect(html).toContain('No session goals')
  expect(html).not.toContain('MOCK')
})

test('wires the Goals page to the roster selector and keeps MetadataInspector active-scoped', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const goalsStart = source.indexOf(": activeView === 'goals' ?")
  const accountsStart = source.indexOf(": activeView === 'accounts' ?", goalsStart)
  const goalsBranch = source.slice(goalsStart, accountsStart)

  expect(goalsStart).toBeGreaterThanOrEqual(0)
  expect(accountsStart).toBeGreaterThan(goalsStart)
  expect(goalsBranch).toContain('selectThreadGoalRows(goalMemory, sessionCatalogRows)')
  expect(goalsBranch).not.toContain('selectThreadGoalSnapshot')
  expect(source).toContain('selectThreadGoalSnapshot(goalMemory, activeSessionId)')
})

test('renders memory metadata without file contents', () => {
  const html = renderToStaticMarkup(<MemoryPage snapshot={MEMORY} />)

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

test('P4-57 renders a keyboard-reachable copy button for every displayed memory path row', () => {
  const html = renderToStaticMarkup(<MemoryPage snapshot={MEMORY} />)

  for (const label of [
    'Copy auto-memory directory path',
    'Copy auto-memory entrypoint path',
    'Copy instruction file path',
    'Copy auto-memory file path',
    'Copy agent memory directory path',
  ]) {
    expect(html).toContain(`aria-label="${label}"`)
  }
  expect(html.match(/type="button"/g)).toHaveLength(6)
  expect(html).toContain(MEMORY.autoMemoryDir)
  expect(html).toContain(MEMORY.autoMemoryEntrypoint)
  expect(html).toContain(MEMORY.autoMemories[0]!.filePath)
  expect(html).toContain(MEMORY.agentMemories[0]!.directory)
})

test('P4-57 wires every memory copy payload directly from its trusted snapshot path', () => {
  // SSR can prove the buttons and text nodes, but it cannot click them or observe
  // clipboard writes and confirmation timing. Pin the non-DOM payload wiring at
  // source, following the TranscriptView copy-control precedent.
  const source = readFileSync(new URL('./MemoryPage.tsx', import.meta.url), 'utf8')
  const flat = source.replace(/\s+/g, ' ')

  expect(flat).toContain('path={snapshot.autoMemoryDir}')
  expect(flat).toContain('path={snapshot.autoMemoryEntrypoint}')
  expect(flat).toContain('path={file.path}')
  expect(flat).toContain('path={memory.filePath}')
  expect(flat).toContain('path={agent.directory}')
  expect(flat).toContain("import { PathCopyButton } from './PathCopyButton.js'")
  expect(flat).not.toContain('function PathCopyButton')
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

  const html = renderToStaticMarkup(<MemoryPage snapshot={memory} />)
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

test('agent-memory rows name both a known role and a user-defined one, each as a chip', () => {
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
        agentType: 'my-plugin-reviewer',
        scope: 'project',
        directory: '/repo/.cat-code/agent-memory/my-plugin-reviewer/',
        fileCount: 1,
      },
    ],
  }
  const html = renderToStaticMarkup(<MemoryPage snapshot={memory} />)

  expect(html).toContain('Agent memory')
  expect(html).toContain('2 agents')
  expect(html).toContain('/config/agent-memory/Explore/')
  expect(html).toContain('/repo/.cat-code/agent-memory/my-plugin-reviewer/')
  // A role outside the known palette is NOT dropped and NOT plain text: it gets
  // the same chip, labelled with the type, because `agentTypeMeta` synthesises a
  // neutral meta rather than returning null. Both names must therefore appear
  // inside a chip element, not merely somewhere in the markup.
  const chips = [...html.matchAll(/<span class="[^"]*uppercase[^"]*">([^<]*)<\/span>/g)].map(
    match => match[1],
  )
  expect(chips).toContain('Explore')
  expect(chips).toContain('my-plugin-reviewer')
  // Counts are pluralised per row, not once for the section.
  expect(html).toContain('4 files')
  expect(html).toContain('1 file')
})

/**
 * The CC-13 bug class: one unreadable directory used to reject the whole
 * snapshot read, so the sidecar sent no frame and this page sat on its waiting
 * state forever, taking the instruction files and auto-memories with it.
 */
test('an unreadable agent directory costs that row its count, not the page', () => {
  const html = renderToStaticMarkup(
    <MemoryPage
      snapshot={{
        ...MEMORY,
        agentMemories: [
          {
            agentType: 'Explore',
            scope: 'project',
            directory: '/repo/.cat-code/agent-memory/Explore/',
            fileCount: null,
          },
        ],
      }}
    />,
  )
  // The row is present, scoped and named, and does not claim zero files.
  expect(html).toContain('/repo/.cat-code/agent-memory/Explore/')
  expect(html).toContain('unreadable')
  expect(html).not.toContain('0 files')
  // And the sections that have nothing to do with agent memory still render.
  expect(html).toContain('/repo/CLAUDE.md')
  expect(html).toContain('feedback_testing.md')
  expect(html).not.toContain('No memory loaded')
})

test('one agent reads as one agent, and none renders no section at all', () => {
  const one = renderToStaticMarkup(
    <MemoryPage
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
    <MemoryPage snapshot={{ ...MEMORY, agentMemories: [] }} />,
  )
  expect(none).not.toContain('Agent memory')
})

test('renders memory waiting state without fixtures', () => {
  const html = renderToStaticMarkup(<MemoryPage snapshot={null} />)

  expect(html).toContain('No memory loaded')
  expect(html).toContain('Open a session')
  expect(html).not.toContain('MOCK')
  // CLAUDE.md §7 — the empty state must not print internal vocabulary at the
  // user (the copy it replaced named the sidecar and the prototype fixtures).
  for (const leak of ['sidecar', 'prototype', 'redacted', 'snapshot']) {
    expect(html).not.toContain(leak)
  }
})
