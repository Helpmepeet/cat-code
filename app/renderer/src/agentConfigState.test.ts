import { expect, test } from 'bun:test'
import type { AgentConfigSnapshot, ServerFrame, SessionId } from '../../shared/protocol.js'
import {
  createAgentConfigState,
  reduceAgentConfigState,
  selectAgentConfigCounts,
  selectAgentConfigGroups,
  selectAgentConfigSnapshot,
} from './agentConfigState.js'

const SNAPSHOT: AgentConfigSnapshot = {
  definitions: [
    {
      id: 'project:writer',
      agentType: 'writer',
      source: 'projectSettings',
      whenToUse: 'Write things',
      tools: { mode: 'list', names: ['Read'] },
      provider: 'runtime',
      background: false,
      hasInitialPrompt: false,
      hasHooks: false,
      hasMcpServers: false,
      mcpServerRefs: [],
      inlineMcpServerNames: [],
      requiredMcpServers: [],
      missingMcpServers: [],
      active: true,
      available: true,
      editable: false,
      readOnlyReason: 'P4-7 exposes a read-only snapshot; desktop editing waits for a full-fidelity writer.',
      systemPrompt: { available: true, withheldReason: 'secret-boundary' },
    },
    {
      id: 'built-in:writer',
      agentType: 'writer',
      source: 'built-in',
      whenToUse: 'Built in writer',
      tools: { mode: 'all' },
      provider: 'runtime',
      background: false,
      hasInitialPrompt: false,
      hasHooks: false,
      hasMcpServers: false,
      mcpServerRefs: [],
      inlineMcpServerNames: [],
      requiredMcpServers: [],
      missingMcpServers: [],
      active: false,
      overriddenBy: 'projectSettings',
      available: false,
      editable: false,
      readOnlyReason: 'Built-in definitions ship with Cat Code.',
      systemPrompt: { available: true, withheldReason: 'secret-boundary' },
    },
  ],
  failedFiles: [],
  availableMcpServers: [],
  notes: [],
}

function snapshotFrame(sessionId: SessionId, agents: AgentConfigSnapshot): ServerFrame {
  return {
    kind: 'agent-config.snapshot',
    protocolVersion: 1,
    sessionId,
    agents,
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

test('reduces agent config snapshots by session id', () => {
  let state = reduceAgentConfigState(createAgentConfigState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  state = reduceAgentConfigState(state, {
    type: 'frame',
    frame: snapshotFrame('b', { ...SNAPSHOT, definitions: [] }),
  })

  expect(selectAgentConfigSnapshot(state, 'a')?.definitions).toHaveLength(2)
  expect(selectAgentConfigSnapshot(state, 'b')?.definitions).toHaveLength(0)
  expect(selectAgentConfigSnapshot(state, 'missing')).toBeNull()
})

test('clears a known session on lifecycle reset', () => {
  let state = reduceAgentConfigState(createAgentConfigState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  state = reduceAgentConfigState(state, { type: 'frame', frame: lifecycleFrame('a') })
  expect(selectAgentConfigSnapshot(state, 'a')).toBeNull()
})

test('selects counts and source groups', () => {
  expect(selectAgentConfigCounts(SNAPSHOT)).toEqual({
    total: 2,
    active: 1,
    unavailable: 1,
    overridden: 1,
  })
  expect(selectAgentConfigGroups(SNAPSHOT).map(group => group.source)).toEqual([
    'projectSettings',
    'built-in',
  ])
})
