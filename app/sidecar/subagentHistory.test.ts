import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSessionId, getSessionProjectDir, switchSession } from '../../src/bootstrap/state.js'
import { asAgentId, asSessionId } from '../../src/types/ids.js'
import { getAgentTranscriptPathForSession, writeAgentMetadata } from '../../src/utils/sessionStorage.js'

import { MAX_HISTORY_REPLAY_BYTES, MAX_HISTORY_REPLAY_FRAMES } from '../shared/limits.js'

import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
} from '../../src/utils/messages.js'

import { stampSubagentFrames, toSDKMessages } from '../../src/utils/messages/mappers.js'
import {
  loadBranchesWithinBudget,
  projectBranchFrames,
  spliceSubagentBranches,
  splitAgentRuns,
  withRestoredSubagentHistory,
} from './subagentHistory.js'

function spawnFrame(toolUseId: string, uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: { description: 'audit the launcher' },
        },
      ],
    },
  }
}

function plainFrame(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text: uuid }] },
  }
}

function branchFrame(parentToolUseId: string, uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: 'text', text: uuid }] },
  }
}

const uuidsOf = (frames: readonly SDKMessage[]) => frames.map(frame => frame.uuid)

describe('restored subagent branches', () => {
  test('splices a branch directly after the tool_use that spawned it', () => {
    const history = [plainFrame('before'), spawnFrame('tu-1', 'spawn'), plainFrame('after')]

    const spliced = spliceSubagentBranches(history, [
      {
        parentToolUseId: 'tu-1',
        frames: [branchFrame('tu-1', 'child-1'), branchFrame('tu-1', 'child-2')],
      },
    ])

    // Immediately after the parent, not appended at the end: the replay cap
    // keeps a newest-first contiguous tail, so a trailing branch would outrank
    // the parent's own recent turns.
    expect(uuidsOf(spliced)).toEqual([
      'before',
      'spawn',
      'child-1',
      'child-2',
      'after',
    ])
  })

  test('drops a branch whose parent frame is not in the restored window', () => {
    const history = [plainFrame('only')]

    const spliced = spliceSubagentBranches(history, [
      { parentToolUseId: 'tu-missing', frames: [branchFrame('tu-missing', 'orphan')] },
    ])

    // An orphaned child renders at TOP LEVEL in the projector, which would
    // interleave subagent rows into the main transcript (the D2 failure).
    expect(uuidsOf(spliced)).toEqual(['only'])
  })

  test('keeps each branch under its own parent when several agents ran', () => {
    const history = [spawnFrame('tu-a', 'spawn-a'), spawnFrame('tu-b', 'spawn-b')]

    const spliced = spliceSubagentBranches(history, [
      { parentToolUseId: 'tu-b', frames: [branchFrame('tu-b', 'b-child')] },
      { parentToolUseId: 'tu-a', frames: [branchFrame('tu-a', 'a-child')] },
    ])

    expect(uuidsOf(spliced)).toEqual(['spawn-a', 'a-child', 'spawn-b', 'b-child'])
  })

  test('merges two branches that share one parent tool_use', () => {
    const history = [spawnFrame('tu-1', 'spawn')]

    const spliced = spliceSubagentBranches(history, [
      { parentToolUseId: 'tu-1', frames: [branchFrame('tu-1', 'first')] },
      { parentToolUseId: 'tu-1', frames: [branchFrame('tu-1', 'second')] },
    ])

    expect(uuidsOf(spliced)).toEqual(['spawn', 'first', 'second'])
  })

  test('splices a branch once even when its parent id repeats in history', () => {
    const history = [spawnFrame('tu-1', 'spawn'), spawnFrame('tu-1', 'spawn-again')]

    const spliced = spliceSubagentBranches(history, [
      { parentToolUseId: 'tu-1', frames: [branchFrame('tu-1', 'child')] },
    ])

    expect(uuidsOf(spliced)).toEqual(['spawn', 'child', 'spawn-again'])
  })

  test('returns history unchanged when the session has no subagents', () => {
    const history = [plainFrame('a'), spawnFrame('tu-1', 'spawn')]

    expect(uuidsOf(spliceSubagentBranches(history, []))).toEqual(['a', 'spawn'])
  })

  test('drops a frame that cannot carry a parent id, instead of splicing it bare', () => {
    // A subagent compacts independently, and `toSDKMessages` emits its boundary
    // as a `system` frame with nowhere to put `parent_tool_use_id`. Splicing it
    // would drop an unparented row into the MAIN transcript, reading as though
    // the parent session had compacted.
    const frames = projectBranchFrames(
      [
        createAssistantMessage({ content: 'worker turn' }),
        createCompactBoundaryMessage('manual', 316_672),
      ],
      'tu-1',
      'Ada',
    )

    expect(frames).toHaveLength(1)
    expect(frames.every(frame => frame.type === 'assistant' || frame.type === 'user')).toBe(true)
  })

  test('stamps the parent id and the meta sidecar name onto every kept frame', () => {
    const frames = projectBranchFrames(
      [createAssistantMessage({ content: 'worker turn' })],
      'tu-1',
      'Ada',
    )

    expect(frames[0]?.parent_tool_use_id).toBe('tu-1')
    expect(frames[0]?.agent_name).toBe('Ada')
  })

  test('omits the name when the meta sidecar has none, rather than stamping empty', () => {
    const frames = projectBranchFrames(
      [createAssistantMessage({ content: 'worker turn' })],
      'tu-1',
      undefined,
    )

    expect(frames[0]?.parent_tool_use_id).toBe('tu-1')
    expect('agent_name' in (frames[0] ?? {})).toBe(false)
  })

  test('drops frames the parent transcript already carries', () => {
    // A fork agent's inherited context is written into its sidechain with the
    // SAME uuids as the parent transcript (sessionStorage.ts:1681). The renderer
    // would discard the duplicates, but only after they spent replay budget.
    const inherited = createAssistantMessage({ content: 'inherited turn' })
    const own = createAssistantMessage({ content: 'worker turn' })

    const frames = projectBranchFrames(
      [inherited, own],
      'tu-1',
      'Ada',
      new Set([inherited.uuid]),
    )

    expect(frames).toHaveLength(1)
    expect(frames[0]?.uuid).toBe(own.uuid)
  })

  test('stops reading reachable sidechains as soon as the replay budget is full', async () => {
    const calls: string[] = []
    const { branches, unavailableParentToolUseIds } = await loadBranchesWithinBudget(
      'session' as never,
      [
        { agentId: 'first' as never, parentToolUseId: 'tu-1', agentName: undefined },
        { agentId: 'never-read' as never, parentToolUseId: 'tu-2', agentName: undefined },
      ],
      1,
      new Set(),
      async (_sessionId, agentId) => {
        calls.push(agentId as string)
        return { messages: [createAssistantMessage({ content: 'one frame' })], bytesRead: 100, truncated: false } as never
      },
    )

    expect(calls).toEqual(['first'])
    expect(branches).toHaveLength(1)
    expect(unavailableParentToolUseIds).toEqual(['tu-2'])
  })

  test('skips an oversized branch but still reads a later branch that fits', async () => {
    const calls: string[] = []
    const { branches, unavailableParentToolUseIds } = await loadBranchesWithinBudget(
      'session' as never,
      [
        { agentId: 'oversized' as never, parentToolUseId: 'tu-large', agentName: undefined },
        { agentId: 'small' as never, parentToolUseId: 'tu-small', agentName: undefined },
      ],
      1,
      new Set(),
      async (_sessionId, agentId) => {
        calls.push(agentId as string)
        return {
          bytesRead: 100,
          truncated: false,
          messages: agentId === ('oversized' as never)
            ? [
                createAssistantMessage({ content: 'too much 1' }),
                createAssistantMessage({ content: 'too much 2' }),
              ]
            : [createAssistantMessage({ content: 'fits' })],
        } as never
      },
    )

    expect(calls).toEqual(['oversized', 'small'])
    expect(branches.map(branch => branch.parentToolUseId)).toEqual(['tu-small'])
    expect(unavailableParentToolUseIds).toEqual(['tu-large'])
  })

  test('rejected branches spend the aggregate source byte budget', async () => {
    const calls: string[] = []
    const { branches, unavailableParentToolUseIds } = await loadBranchesWithinBudget(
      'session',
      [
        { agentId: 'oversized' as never, parentToolUseId: 'large', agentName: undefined },
        { agentId: 'never-read' as never, parentToolUseId: 'small', agentName: undefined },
      ],
      1,
      new Set(),
      async (_sessionId, agentId) => {
        calls.push(String(agentId))
        return {
          messages: [createAssistantMessage({ content: 'a' }), createAssistantMessage({ content: 'b' })],
          bytesRead: MAX_HISTORY_REPLAY_BYTES,
          truncated: false,
        } as never
      },
    )
    expect(calls).toEqual(['oversized'])
    expect(branches).toEqual([])
    expect(unavailableParentToolUseIds).toEqual(['large', 'small'])
  })

  test('rejected branches also spend the aggregate message work budget', async () => {
    const calls: string[] = []
    const { branches, unavailableParentToolUseIds } = await loadBranchesWithinBudget(
      'session',
      [
        { agentId: 'many' as never, parentToolUseId: 'many', agentName: undefined },
        { agentId: 'never-read' as never, parentToolUseId: 'small', agentName: undefined },
      ],
      1,
      new Set(),
      async (_sessionId, agentId) => {
        calls.push(String(agentId))
        return {
          messages: Array.from({ length: MAX_HISTORY_REPLAY_FRAMES }, () => createAssistantMessage({ content: 'a' })),
          bytesRead: 100,
          truncated: false,
        } as never
      },
    )
    expect(calls).toEqual(['many'])
    expect(branches).toEqual([])
    expect(unavailableParentToolUseIds).toEqual(['many', 'small'])
  })

  test('a branch cannot spend more than the projected byte budget', async () => {
    const { branches, unavailableParentToolUseIds } = await loadBranchesWithinBudget(
      'session',
      [{ agentId: 'large' as never, parentToolUseId: 'large', agentName: undefined }],
      2,
      new Set(),
      async () => ({
        messages: [createAssistantMessage({ content: 'x'.repeat(MAX_HISTORY_REPLAY_BYTES) })],
        bytesRead: 100,
        truncated: false,
      }) as never,
    )
    expect(branches).toEqual([])
    expect(unavailableParentToolUseIds).toEqual(['large'])
  })

  test('ignores non-tool_use content when looking for a parent', () => {
    const history = [plainFrame('text-only')]

    const spliced = spliceSubagentBranches(history, [
      { parentToolUseId: 'text-only', frames: [branchFrame('text-only', 'child')] },
    ])

    // The join is on the tool_use block id, never on a frame uuid that happens
    // to match.
    expect(uuidsOf(spliced)).toEqual(['text-only'])
  })
})

// Exercises the real bounded reader and metadata join: complete parent history
// must not advertise an omitted worker as having no steps.
describe('restored subagent history availability', () => {
  const originalId = getSessionId()
  const originalProject = getSessionProjectDir()
  let directory: string
  let sessionId: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cc-subagent-availability-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), directory)
  })
  afterEach(() => {
    switchSession(originalId, originalProject)
    rmSync(directory, { recursive: true, force: true })
  })

  async function branch(agent: string, parent: string, messages: string[], inheritedUuid?: string): Promise<void> {
    const agentId = asAgentId(agent)
    await writeAgentMetadata(agentId, {
      agentType: 'Explore', parentSessionId: sessionId, parentToolUseId: parent,
      spawnedAt: '2026-10-09T00:00:00.000Z',
    })
    const path = getAgentTranscriptPathForSession(sessionId, agentId)
    mkdirSync(dirname(path), { recursive: true })
    const uuids = messages.map((_, index) => index === 0 && inheritedUuid ? inheritedUuid : randomUUID())
    writeFileSync(path, messages.map((text, index) => JSON.stringify({
      type: 'assistant', agentId, sessionId, isSidechain: true,
      uuid: uuids[index], parentUuid: index === 0 ? null : uuids[index - 1],
      timestamp: '2026-10-09T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })).join('\n') + '\n')
  }

  test('a reachable worker omitted by the byte cap is identified without truncating parent history', async () => {
    await branch('large', 'tu-large', ['x'.repeat(MAX_HISTORY_REPLAY_BYTES + 1024), 'recent work'])
    await branch('unreachable', 'tu-absent', ['not in this restored window'])
    const history = [spawnFrame('tu-large', 'spawn'), plainFrame('completed')]
    const restored = await withRestoredSubagentHistory(sessionId, history)
    expect(restored.unavailableParentToolUseIds).toEqual(['tu-large'])
    expect(restored.history).toEqual(history)
  })

  test('exhausted replay headroom identifies reachable workers without reading their steps', async () => {
    await branch('worker', 'tu-worker', ['saved work'])
    const history = [spawnFrame('tu-worker', 'spawn'), ...Array.from(
      { length: MAX_HISTORY_REPLAY_FRAMES - 1 }, (_, index) => plainFrame(`row-${index}`),
    )]
    const restored = await withRestoredSubagentHistory(sessionId, history)
    expect(restored.unavailableParentToolUseIds).toEqual(['tu-worker'])
    expect(restored.history).toHaveLength(MAX_HISTORY_REPLAY_FRAMES)
  })

  test('empty workers and unreachable branches are not reported as omitted steps', async () => {
    await branch('empty', 'tu-empty', [])
    await branch('inherited', 'tu-inherited', ['parent context'], 'inherited-uuid')
    await branch('unreachable', 'tu-absent', ['unreachable steps'])
    const history = [spawnFrame('tu-empty', 'spawn'), spawnFrame('tu-inherited', 'inherited-spawn'), plainFrame('inherited-uuid')]
    const restored = await withRestoredSubagentHistory(sessionId, history)
    expect(restored.unavailableParentToolUseIds).toEqual([])
    expect(restored.history).toEqual(history)
  })
})

describe('subagent run ownership on restore', () => {
  const step = (uuid: string) => ({ uuid }) as never

  test('cuts one sidechain into the original run and each resume', () => {
    const segments = splitAgentRuns(
      ['p1', 'a1', 'p2', 'a2', 'p3', 'a3'].map(step),
      [
        { parentToolUseId: 'tu-original', firstMessageUuid: 'p1' },
        { parentToolUseId: 'tu-resume-a', firstMessageUuid: 'p2' },
        { parentToolUseId: 'tu-resume-b', firstMessageUuid: 'p3' },
      ],
      'tu-resume-b',
    )
    expect(segments.map(segment => [segment.parentToolUseId, segment.messages.map(m => (m as { uuid: string }).uuid)]))
      .toEqual([['tu-original', ['p1', 'a1']], ['tu-resume-a', ['p2', 'a2']], ['tu-resume-b', ['p3', 'a3']]])
  })

  test('a file without run records keeps every step under its one recorded card', () => {
    const segments = splitAgentRuns(['a', 'b'].map(step), undefined, 'tu-latest')
    expect(segments).toEqual([{ parentToolUseId: 'tu-latest', messages: ['a', 'b'].map(step) }])
  })

  test('a legacy first run owns the steps before the first recorded start', () => {
    const segments = splitAgentRuns(
      ['old', 'old-answer', 'p2', 'a2'].map(step),
      [{ parentToolUseId: 'tu-legacy' }, { parentToolUseId: 'tu-resume', firstMessageUuid: 'p2' }],
      'tu-resume',
    )
    expect(segments.map(segment => [segment.parentToolUseId, segment.messages.length]))
      .toEqual([['tu-legacy', 2], ['tu-resume', 2]])
  })

  test('restore stamps a stored message exactly as live publication stamps it', () => {
    const stored = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'weighing it', signature: 'sig' },
        { type: 'text', text: 'checking the file' },
        { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/tmp/a' } },
      ] as never,
    })
    const live = stampSubagentFrames(toSDKMessages([stored]), 'tu-agent', 'Ada')
    const restored = projectBranchFrames([stored], 'tu-agent', 'Ada')
    expect(live as SDKMessage[]).toEqual(restored)
    expect(live).toHaveLength(1)
    expect(live[0]!.uuid).toBe(stored.uuid)
  })
})

describe('restored resumed runs through the real reader', () => {
  const originalId = getSessionId()
  const originalProject = getSessionProjectDir()
  let directory: string
  let sessionId: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cc-subagent-runs-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), directory)
  })
  afterEach(() => {
    switchSession(originalId, originalProject)
    rmSync(directory, { recursive: true, force: true })
  })

  test('each run returns under its own card after a restore', async () => {
    const agentId = asAgentId('resumed-twice')
    const texts = ['original prompt', 'original work', 'resume A prompt', 'resume A work', 'resume B prompt', 'resume B work']
    const uuids = texts.map(() => randomUUID())
    await writeAgentMetadata(agentId, {
      agentType: 'Explore', parentSessionId: sessionId, parentToolUseId: 'tu-resume-b',
      spawnedAt: '2026-10-17T00:00:00.000Z', agentName: 'Ada',
      runs: [
        { parentToolUseId: 'tu-original', firstMessageUuid: uuids[0]! },
        { parentToolUseId: 'tu-resume-a', firstMessageUuid: uuids[2]! },
        { parentToolUseId: 'tu-resume-b', firstMessageUuid: uuids[4]! },
      ],
    })
    const path = getAgentTranscriptPathForSession(sessionId, agentId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, texts.map((text, index) => JSON.stringify({
      type: 'assistant', agentId, sessionId, isSidechain: true,
      uuid: uuids[index], parentUuid: index === 0 ? null : uuids[index - 1],
      timestamp: '2026-10-17T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })).join('\n') + '\n')
    const history = [
      spawnFrame('tu-original', 'spawn-original'),
      spawnFrame('tu-resume-a', 'spawn-resume-a'),
      spawnFrame('tu-resume-b', 'spawn-resume-b'),
    ]

    const restored = await withRestoredSubagentHistory(sessionId, history)

    expect(restored.history.map(frame => [frame.uuid, 'parent_tool_use_id' in frame ? frame.parent_tool_use_id ?? null : null]))
      .toEqual([
        ['spawn-original', null],
        [uuids[0], 'tu-original'], [uuids[1], 'tu-original'],
        ['spawn-resume-a', null],
        [uuids[2], 'tu-resume-a'], [uuids[3], 'tu-resume-a'],
        ['spawn-resume-b', null],
        [uuids[4], 'tu-resume-b'], [uuids[5], 'tu-resume-b'],
      ])
    expect(restored.unavailableParentToolUseIds).toEqual([])
  })

  test('a run whose card is outside the restored window spends no replay budget', async () => {
    const agentId = asAgentId('earlier-run-out-of-window')
    const uuids = [randomUUID(), randomUUID()]
    await writeAgentMetadata(agentId, {
      agentType: 'Explore', parentSessionId: sessionId, parentToolUseId: 'tu-recent',
      spawnedAt: '2026-10-17T00:00:00.000Z',
      runs: [
        { parentToolUseId: 'tu-old', firstMessageUuid: uuids[0]! },
        { parentToolUseId: 'tu-recent', firstMessageUuid: uuids[1]! },
      ],
    })
    const path = getAgentTranscriptPathForSession(sessionId, agentId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, ['old run step', 'recent run step'].map((text, index) => JSON.stringify({
      type: 'assistant', agentId, sessionId, isSidechain: true,
      uuid: uuids[index], parentUuid: index === 0 ? null : uuids[index - 1],
      timestamp: '2026-10-17T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })).join('\n') + '\n')
    // Exactly one frame of headroom: the recent run fits only if the old run is not charged.
    const history = [spawnFrame('tu-recent', 'spawn-recent'), ...Array.from(
      { length: MAX_HISTORY_REPLAY_FRAMES - 2 }, (_, index) => plainFrame(`row-${index}`),
    )]

    const restored = await withRestoredSubagentHistory(sessionId, history)

    expect(restored.unavailableParentToolUseIds).toEqual([])
    expect(restored.history.filter(frame => 'parent_tool_use_id' in frame && frame.parent_tool_use_id === 'tu-recent').map(frame => frame.uuid))
      .toEqual([uuids[1]])
  })
})
