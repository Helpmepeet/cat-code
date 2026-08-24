import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/sdk'
import type { ThreadGoalSnapshot } from '../../shared/protocol.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import { SDK_MESSAGE_FIXTURE } from './sdkMessageFixtures.js'
import {
  buildSessionMetadataView,
  selectMessageMetadata,
  selectMessageRefs,
} from './messageMetadata.js'

function findSystem(subtype: string): SDKMessage {
  const sample = SDK_MESSAGE_FIXTURE.system.find(s => s.message.subtype === subtype)
  if (!sample) throw new Error(`no system fixture for ${subtype}`)
  return sample.message
}

const assistant: SDKMessage = {
  ...SDK_MESSAGE_FIXTURE.assistant[0]!.message,
  uuid: 'a1',
  requestId: 'req_1',
  timestamp: '2026-07-11T10:00:00Z',
  parent_tool_use_id: 'toolu_parent',
}
const result: SDKMessage = { ...SDK_MESSAGE_FIXTURE.result[0]!.message, uuid: 'r1' }
const compact: SDKMessage = {
  ...findSystem('compact_boundary'),
  uuid: '0-0-0-0-c1',
  compact_metadata: {
    trigger: 'auto',
    pre_tokens: 167034,
    messages_summarized: 34,
    preserved_segment: {
      head_uuid: 'head-1',
      anchor_uuid: 'anchor-1',
      tail_uuid: 'tail-1',
    },
  },
}
const streamEvent: SDKMessage = SDK_MESSAGE_FIXTURE.stream_event[0]!.message

function log(messages: SDKMessage[]): RawMessageSessionLog {
  return {
    inputEnabled: true,
    messages,
    retainedBytes: 0,
    truncated: false,
    error: null,
    messageBytes: [],
  }
}

describe('selectMessageRefs', () => {
  test('lists turn messages with role + preview, excluding stream_event deltas', () => {
    const refs = selectMessageRefs(log([assistant, streamEvent, result, compact]))
    const roles = refs.map(r => r.role)
    expect(roles).toEqual(['assistant', 'result', 'system'])
    expect(refs.every(r => typeof r.preview === 'string' && r.preview.length > 0)).toBe(true)
    // The assistant fixture's first text block flows into the preview.
    expect(refs[0]!.preview).toContain("I'll read the config")
  })

  test('skips messages without a uuid', () => {
    const noUuid: SDKMessage = { ...SDK_MESSAGE_FIXTURE.assistant[1]!.message, uuid: undefined }
    expect(selectMessageRefs(log([noUuid])).length).toBe(0)
  })
})

describe('selectMessageMetadata', () => {
  test('assistant: model / messageId / requestId / timestamp / parentToolUseId', () => {
    const meta = selectMessageMetadata(log([assistant]), 'a1')
    expect(meta).not.toBeNull()
    expect(meta!.role).toBe('assistant')
    expect(meta!.model).toBe('claude-sonnet-5')
    expect(meta!.messageId).toBe('msg_01Fix001')
    expect(meta!.requestId).toBe('req_1')
    expect(meta!.timestamp).toBe('2026-07-11T10:00:00Z')
    expect(meta!.parentToolUseId).toBe('toolu_parent')
    // inner message.usage is surfaced.
    expect(meta!.usage?.inputTokens).toBe(1200)
  })

  test('result: cost / duration / usage / stopReason', () => {
    const meta = selectMessageMetadata(log([result]), 'r1')
    expect(meta!.totalCostUsd).toBeCloseTo(0.0421)
    expect(meta!.durationMs).toBe(5321)
    expect(meta!.usage?.inputTokens).toBe(1200)
    expect(meta!.usage?.outputTokens).toBe(96)
    expect(meta!.stopReason).toBe('end_turn')
  })

  test('system compact_boundary: all real compaction metadata', () => {
    const meta = selectMessageMetadata(log([compact]), '0-0-0-0-c1')
    expect(meta!.compaction).not.toBeNull()
    expect(meta!.compaction!.trigger).toBe('auto')
    expect(meta!.compaction!.preTokens).toBe(167034)
    expect(meta!.compaction!.messagesSummarized).toBe(34)
    expect(meta!.compaction!.preservedSegment).toEqual({
      headUuid: 'head-1',
      tailUuid: 'tail-1',
    })
  })

  test('joins a nested message to source-backed subagent identity by parent tool use id', () => {
    const meta = selectMessageMetadata(log([assistant]), 'a1', [{
      toolUseId: 'toolu_parent',
      agentId: 'agent-7',
      agentName: 'Ritchie',
      agentType: 'verification',
      isSidechain: true,
      spawnedAt: 100,
    }])
    expect(meta!.subagent).toEqual({
      toolUseId: 'toolu_parent',
      agentId: 'agent-7',
      agentName: 'Ritchie',
      agentType: 'verification',
      isSidechain: true,
      spawnedAt: 100,
    })
  })

  test('unknown uuid → null; null uuid → null', () => {
    expect(selectMessageMetadata(log([assistant]), 'nope')).toBeNull()
    expect(selectMessageMetadata(log([assistant]), null)).toBeNull()
  })

  test('a message missing every optional field degrades to nulls, never throws', () => {
    const bare: SDKMessage = { ...findSystem('init'), uuid: '0-0-0-0-bare' }
    const meta = selectMessageMetadata(log([bare]), '0-0-0-0-bare')
    expect(meta).not.toBeNull()
    expect(meta!.requestId).toBeNull()
    expect(meta!.totalCostUsd).toBeNull()
  })
})

describe('buildSessionMetadataView', () => {
  const goal: ThreadGoalSnapshot = {
    threadId: 't1',
    goalId: 'g1',
    objective: 'Ship P4-6b',
    status: 'active',
    revision: 1,
    continuationTurns: 0,
    maxContinuationTurns: 20,
    statusNote: null,
    tokensUsed: 1000,
    timeUsedSeconds: 90,
    createdAtMs: 0,
    updatedAtMs: 1,
    summary: '',
  }
  const row: MergedSessionRow = {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w',
    cwdExists: true,
    title: 't',
    displayLabel: 't',
    live: true,
    restorable: false,
    parked: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    gitBranch: null,
    tag: 'auth',
    mode: 'agent',
    agentSetting: null,
    prNumber: null,
    prRepository: null,
  }

  test('assembles session view from the existing read-seams', () => {
    const view = buildSessionMetadataView({
      sessionId: 'engine-1',
      row,
      permissionMode: 'acceptEdits',
      threadGoal: goal,
    })
    expect(view).toEqual({
      sessionId: 'engine-1',
      mode: 'agent',
      permissionMode: 'acceptEdits',
      tag: 'auth',
      threadGoal: goal,
    })
  })

  test('degrades cleanly when the row + goal are absent', () => {
    const view = buildSessionMetadataView({
      sessionId: 'engine-1',
      row: null,
      permissionMode: null,
      threadGoal: null,
    })
    expect(view.mode).toBeNull()
    expect(view.tag).toBeNull()
    expect(view.threadGoal).toBeNull()
  })
})
