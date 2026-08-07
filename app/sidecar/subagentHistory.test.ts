import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
} from '../../src/utils/messages.js'

import { projectBranchFrames, spliceSubagentBranches } from './subagentHistory.js'

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
