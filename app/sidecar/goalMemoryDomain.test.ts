import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAgentMemoryDir } from '../../src/tools/AgentTool/agentMemory.js'
import {
  MEMORY_TYPES,
  type MemoryType as AutoMemoryType,
} from '../../src/memdir/memoryTypes.js'
import type { MemoryFileInfo } from '../../src/utils/claudemd.js'
import type { MemoryType as EngineInstructionMemoryType } from '../../src/utils/memory/types.js'
import {
  createThreadGoal,
  formatThreadGoalStatus,
  updateThreadGoalStatus,
  type ThreadGoalStatus,
} from '../../src/utils/threadGoal.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  MemoryInstructionType,
  MemorySnapshotFrame,
  ThreadGoalSnapshotFrame,
} from '../shared/protocol.js'
import { threadGoalSnapshot } from './goalDomain.js'
import { buildMemorySnapshot, readAgentMemories } from './memoryDomain.js'

type AssertAssignable<T extends true> = T
type ProtocolCoversEngineGoalStatuses = AssertAssignable<
  Exclude<ThreadGoalStatus, NonNullable<ThreadGoalSnapshotFrame['goal']>['status']> extends never
    ? true
    : false
>
type EngineCoversProtocolGoalStatuses = AssertAssignable<
  Exclude<NonNullable<ThreadGoalSnapshotFrame['goal']>['status'], ThreadGoalStatus> extends never
    ? true
    : false
>
type ProtocolCoversEngineInstructionTypes = AssertAssignable<
  Exclude<EngineInstructionMemoryType, MemoryInstructionType> extends never ? true : false
>
type EngineCoversProtocolInstructionTypes = AssertAssignable<
  Exclude<MemoryInstructionType, EngineInstructionMemoryType> extends never ? true : false
>
type ProtocolCoversAutoMemoryTypes = AssertAssignable<
  Exclude<
    AutoMemoryType,
    NonNullable<MemorySnapshotFrame['memory']['autoMemories'][number]['type']>
  > extends never
    ? true
    : false
>
void (null as unknown as ProtocolCoversEngineGoalStatuses)
void (null as unknown as EngineCoversProtocolGoalStatuses)
void (null as unknown as ProtocolCoversEngineInstructionTypes)
void (null as unknown as EngineCoversProtocolInstructionTypes)
void (null as unknown as ProtocolCoversAutoMemoryTypes)

test('builds a thread goal display snapshot with the engine summary text', () => {
  const snapshot = threadGoalSnapshot({
    ...createThreadGoal('thread-1', 'Finish P4-10', 50_000, 1),
    goalId: 'goal-1',
    tokensUsed: 1_234,
    timeUsedSeconds: 42,
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

test('covers every engine thread-goal status in snapshot and summary formatting', () => {
  // Expected labels are HARDCODED literals mirroring STATUS_LABELS in
  // src/utils/threadGoal.ts, so an engine label-wording change fails this test
  // loudly. Deriving the expected string via formatThreadGoalStatus() would
  // move both sides together and catch no drift.
  const cases = [
    { status: 'active', label: 'active', reason: 'created' },
    { status: 'waiting', label: 'waiting', reason: 'waiting_on_dependency' },
    { status: 'paused', label: 'paused', reason: 'user_paused' },
    { status: 'blocked', label: 'blocked', reason: 'agent_reported_blocked' },
    { status: 'stalled', label: 'stalled', reason: 'no_progress' },
    {
      status: 'budget_limited',
      label: 'limited by budget',
      reason: 'token_budget_exhausted',
    },
    {
      status: 'usage_limited',
      label: 'limited by usage',
      reason: 'provider_usage_limit',
    },
    { status: 'failed', label: 'failed', reason: 'runtime_error' },
    {
      status: 'complete',
      label: 'complete',
      reason: 'agent_reported_complete',
    },
  ] as const satisfies readonly {
    status: ThreadGoalStatus
    label: string
    reason: string
  }[]

  for (const { status, label, reason } of cases) {
    // Tripwire: the engine's own formatter must still produce the pinned label.
    expect(formatThreadGoalStatus(status)).toBe(label)
    const base = createThreadGoal(
      `thread-${status}`,
      `Goal status ${status}`,
      status === 'budget_limited' ? 100 : undefined,
      1,
    )
    const snapshot = threadGoalSnapshot({
      ...(status === 'active'
        ? base
        : updateThreadGoalStatus(base, status, reason as never, 2)),
      goalId: `goal-${status}`,
      tokensUsed: status === 'budget_limited' ? 100 : 1,
      timeUsedSeconds: 2,
      updatedAtMs: 2,
    })
    expect(snapshot?.status).toBe(status)
    expect(snapshot?.summary).toContain(`Goal: ${label}`)
    // No stopped status may render as the success label.
    if (status !== 'complete') {
      expect(snapshot?.summary).not.toContain('Goal: complete')
    }
  }
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

test('covers every instruction-file and auto-memory type from the engine scanners', () => {
  // Instruction MemoryType: src/utils/memory/types.ts:3-10.
  const instructionTypes = [
    'User',
    'Project',
    'Local',
    'Managed',
    'AutoMem',
    'TeamMem',
  ] as const satisfies readonly MemoryInstructionType[]

  const snapshot = buildMemorySnapshot({
    autoMemoryEnabled: true,
    autoMemoryDir: '/config/memory/',
    autoMemoryEntrypoint: '/config/memory/MEMORY.md',
    instructionFiles: instructionTypes.map(type => ({
      path: `/memory/${type}.md`,
      type,
      content: `${type} body withheld`,
      ...(type === 'Project' ? { parent: '/repo/CLAUDE.md' } : {}),
      ...(type === 'Local' ? { globs: ['app/**'] } : {}),
      contentDiffersFromDisk: type === 'AutoMem',
    })),
    // Auto-memory frontmatter MemoryType: src/memdir/memoryTypes.ts:14-21.
    autoMemories: MEMORY_TYPES.map(type => ({
      filename: `${type}.md`,
      filePath: `/config/memory/${type}.md`,
      mtimeMs: 10,
      description: `${type} description`,
      type,
    })),
  })

  expect(snapshot.instructionFiles.map(file => file.type)).toEqual([...instructionTypes])
  expect(snapshot.autoMemories.map(memory => memory.type)).toEqual([...MEMORY_TYPES])
  expect(snapshot.instructionFiles.find(file => file.type === 'Project')).toMatchObject({
    parent: '/repo/CLAUDE.md',
  })
  expect(snapshot.instructionFiles.find(file => file.type === 'Local')).toMatchObject({
    globs: ['app/**'],
  })
  expect(snapshot.instructionFiles.find(file => file.type === 'AutoMem')).toMatchObject({
    contentDiffersFromDisk: true,
  })
})

/* ── per-agent memory directories (P4-34) ─────────────────────────────────── */

/**
 * A LIVE-PATH test: real directories on disk, resolved by the ENGINE's own
 * `getAgentMemoryDir` rather than by a path this test spells out, and counted by
 * the real `readdir`. A shape-only test would pass against a stub resolver and
 * miss the thing that matters — that the app reports the directory the running
 * agent would actually write to.
 */
test('agent-memory rows carry the engine-resolved directory and a real recursive file count', async () => {
  const home = mkdtempSync(join(tmpdir(), 'p4-34-agent-memory-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const dir = getAgentMemoryDir('Explore', 'user')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'body stays engine-side')
    writeFileSync(join(dir, 'nested', 'note.md'), 'also engine-side')

    const rows = await readAgentMemories([
      { agentType: 'Explore', memory: 'user' },
      // No `memory` declared → the agent has no memory dir and no row.
      { agentType: 'Plan' },
      // Declared but never written to → a real row reading zero, not a drop.
      { agentType: 'Never-Run', memory: 'user' },
    ])

    expect(rows).toEqual([
      { agentType: 'Explore', scope: 'user', directory: dir, fileCount: 2 },
      {
        agentType: 'Never-Run',
        scope: 'user',
        directory: getAgentMemoryDir('Never-Run', 'user'),
        fileCount: 0,
      },
    ])
    // Counts and paths only: no memory body crosses the boundary.
    expect(JSON.stringify(rows)).not.toContain('engine-side')
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(home, { recursive: true, force: true })
  }
})

/**
 * The CC-13 bug class, at its source. `readAgentMemories` runs inside a
 * `Promise.all` whose rejection makes `readMemorySnapshotOnce` return null, and a
 * null snapshot means no `memory.snapshot` frame and a Memory page stuck on its
 * waiting state. So an unreadable directory must resolve, not throw.
 */
test('an unreadable agent directory resolves to an unknown count instead of rejecting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'p4-34-agent-memory-perm-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const readable = getAgentMemoryDir('Explore', 'user')
    mkdirSync(readable, { recursive: true })
    writeFileSync(join(readable, 'MEMORY.md'), 'x')

    // A real EACCES: a directory the process may not list.
    const denied = getAgentMemoryDir('Locked', 'user')
    mkdirSync(denied, { recursive: true })
    writeFileSync(join(denied, 'MEMORY.md'), 'x')
    chmodSync(denied, 0o000)

    const rows = await readAgentMemories([
      { agentType: 'Explore', memory: 'user' },
      { agentType: 'Locked', memory: 'user' },
    ])

    // Neither row is lost, and only the unreadable one loses its count.
    expect(rows.map(row => row.agentType)).toEqual(['Explore', 'Locked'])
    expect(rows[0]?.fileCount).toBe(1)
    expect(rows[1]?.fileCount).toBeNull()
    // Still a real row: scope and path survive, so the reader learns the
    // directory exists and cannot be read.
    expect(rows[1]?.directory).toBe(denied)
    expect(rows[1]?.scope).toBe('user')

    chmodSync(denied, 0o700)
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(home, { recursive: true, force: true })
  }
})

test('a memory frame carrying agent rows is still secretGuard-clean', () => {
  const snapshot = buildMemorySnapshot({
    autoMemoryEnabled: true,
    autoMemoryDir: '/config/memory/',
    autoMemoryEntrypoint: '/config/memory/MEMORY.md',
    instructionFiles: [],
    autoMemories: [],
    agentMemories: [
      {
        agentType: 'Explore',
        scope: 'user',
        directory: '/config/agent-memory/Explore/',
        fileCount: 2,
      },
    ],
  })
  const frame: MemorySnapshotFrame = {
    kind: 'memory.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    memory: snapshot,
  }
  expect(scanForSecrets(frame).ok).toBe(true)
})

test('a snapshot with no memory-carrying agents carries an empty list, never a missing field', () => {
  const snapshot = buildMemorySnapshot({
    autoMemoryEnabled: true,
    autoMemoryDir: '/config/memory/',
    autoMemoryEntrypoint: '/config/memory/MEMORY.md',
    instructionFiles: [],
    autoMemories: [],
  })
  expect(snapshot.agentMemories).toEqual([])
})
