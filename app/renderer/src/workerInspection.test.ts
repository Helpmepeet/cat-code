import { expect, test } from 'bun:test'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'
import { agentTranscriptStateWord, type AgentStateKey } from './agentIdentity.js'
import {
  groupWorkersByRole,
  selectWorkerResult,
  selectWorkerStopTargetId,
  workerRoleGroupLabel,
} from './workerInspection.js'

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'agent_a',
    handle: '@scout',
    role: 'coding-worker',
    status: 'running',
    description: 'audit the auth path',
    origin: 'current',
    ...over,
  }
}

test('known orchestrator roles lead, unknown roles keep their first-seen order', () => {
  const groups = groupWorkersByRole([
    worker({ agentId: '1', role: 'Explore' }),
    worker({ agentId: '2', role: 'verification' }),
    worker({ agentId: '3', role: 'coding-worker' }),
    worker({ agentId: '4', role: 'implementor' }),
    worker({ agentId: '5', role: 'coding-worker' }),
  ])
  expect(groups.map(group => group.role)).toEqual([
    'coding-worker',
    'verification',
    'Explore',
    'implementor',
  ])
  expect(groups[0]!.workers.map(w => w.agentId)).toEqual(['3', '5'])
})

test('an unknown role is grouped and labelled, never dropped', () => {
  // A non-orchestrator session's workers carry arbitrary real agent types; losing
  // one would make the roster silently under-report the swarm.
  const groups = groupWorkersByRole([worker({ role: 'my-custom-agent' })])
  expect(groups).toHaveLength(1)
  expect(groups[0]!.role).toBe('my-custom-agent')
  expect(groups[0]!.label).toBe('my-custom-agent')
})

test('a null role falls back to the general-purpose bucket', () => {
  const groups = groupWorkersByRole([worker({ role: null }), worker({ role: '' })])
  expect(groups).toHaveLength(1)
  expect(groups[0]!.role).toBe('general-purpose')
  expect(groups[0]!.workers).toHaveLength(2)
})

test('the group caption uses the SHARED vocabulary and pluralises', () => {
  expect(workerRoleGroupLabel('coding-worker', 1)).toBe('Coding worker')
  expect(workerRoleGroupLabel('coding-worker', 3)).toBe('Coding workers')
  expect(workerRoleGroupLabel('verification', 2)).toBe('Verifications')
})

test('an empty roster produces no groups', () => {
  expect(groupWorkersByRole([])).toEqual([])
})

test('stop targets a RUNNING current-session worker only, by its agentId', () => {
  expect(selectWorkerStopTargetId(worker())).toBe('agent_a')
  expect(selectWorkerStopTargetId(worker({ status: 'completed' }))).toBeNull()
  expect(selectWorkerStopTargetId(worker({ status: 'failed' }))).toBeNull()
  expect(selectWorkerStopTargetId(worker({ status: 'killed' }))).toBeNull()
  // A worker marked prior has no live task in this process.
  expect(selectWorkerStopTargetId(worker({ origin: 'prior' }))).toBeNull()
})

test('a blocked worker is still stoppable (it is running, waiting on a handoff)', () => {
  expect(
    selectWorkerStopTargetId(
      worker({ handoffStatus: 'blocked', blockReason: 'needs a decision' }),
    ),
  ).toBe('agent_a')
})

test('Q2 result: a verdict wins, then an output summary, else nothing', () => {
  expect(selectWorkerResult(worker({ verdict: 'PASS' }))).toEqual({
    label: 'Verdict',
    text: 'PASS',
  })
  expect(
    selectWorkerResult(worker({ verdict: 'FAIL', outputSummary: 'two tests red' })),
  ).toEqual({ label: 'Verdict', text: 'FAIL: two tests red' })
  expect(selectWorkerResult(worker({ outputSummary: 'wrote the adapter' }))).toEqual({
    label: 'Result',
    text: 'wrote the adapter',
  })
  // No engine-backed conclusion means no section, never a placeholder.
  expect(selectWorkerResult(worker())).toBeNull()
})

test('the compressed state word covers every AgentStateKey and stays lowercase', () => {
  const keys: AgentStateKey[] = [
    'running',
    'background',
    'completed',
    'failed',
    'stopped',
    'waiting',
    'needs-you',
    'paused',
    'result-ready',
    'reviewed',
    'attention',
    'resumable',
    'stale',
    'resumed',
  ]
  for (const key of keys) {
    const word = agentTranscriptStateWord(key)
    expect(word.length).toBeGreaterThan(0)
    expect(word).toBe(word.toLowerCase())
    expect(word).not.toContain('—')
  }
  // The compression the prototype's list mode applies.
  expect(agentTranscriptStateWord('completed')).toBe('done')
  expect(agentTranscriptStateWord('reviewed')).toBe('done')
  expect(agentTranscriptStateWord('result-ready')).toBe('done')
  expect(agentTranscriptStateWord('waiting')).toBe('needs input')
  expect(agentTranscriptStateWord('background')).toBe('running')
})
