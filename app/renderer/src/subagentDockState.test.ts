import { expect, test } from 'bun:test'
import type { LeaseSnapshot, LiveWorkerItem, TaskSnapshotItem } from '../../shared/protocol.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { createSubagentDockState, reconcileSubagentDockState, selectSubagentDock, type SubagentDockInput, type SubagentDockState } from './subagentDockState.js'
import { MAX_PERSISTED_DOCK_FINISHED, readSubagentDockSessionsFromStorage, writeSubagentDockSessionsToStorage } from './subagentDockPersistence.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'

const worker = (patch: Partial<LiveWorkerItem> = {}): LiveWorkerItem => ({ agentId: 'a', handle: '@Ada', role: 'Explore', status: 'running', description: 'Check paths', ...patch })
const agentRow = (patch: Partial<NestedToolUseRow> = {}): NestedToolUseRow => ({
  kind: 'tool-use', id: 'row-a', sessionId: 'session', frameId: 'frame', messageId: 'message', blockIndex: 0, parentToolUseId: null,
  toolUseId: 'launch-a', toolName: 'Agent', toolFamily: 'agent', input: { description: 'Check paths', subagent_type: 'Explore' },
  status: 'pending', result: null, agentCompletion: null, children: [], ...patch,
})
const task = (patch: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem => ({ id: 'a', type: 'local_agent', status: 'running', label: 'Check paths', startTime: 100, ...patch })
function input(patch: Partial<SubagentDockInput> = {}): SubagentDockInput {
  return { workers: [], tasks: null, transcriptRows: [], leases: null, nowMs: 1000, ...patch }
}
function view(state: SubagentDockState, patch: Partial<SubagentDockInput> = {}) {
  const facts = input(patch)
  const next = reconcileSubagentDockState(state, facts)
  return { state: next, ...selectSubagentDock(next, facts) }
}

test('dock reuses top-level agent candidates while live worker facts still refresh', () => {
  let visits = 0
  const rows = Array.from({ length: 256 }, (_, index) => {
    const row = agentRow({ kind: 'tool-use', toolName: 'Bash', toolFamily: 'bash', toolUseId: `bash-${index}` })
    Object.defineProperty(row, 'kind', { get: () => { visits++; return 'tool-use' } })
    return row
  })
  rows.push(agentRow())
  const first = view(createSubagentDockState(), { transcriptRows: rows, workers: [worker()] })
  const afterFirst = visits
  expect(first.active[0]?.state).toBe('running')
  expect(afterFirst).toBeGreaterThan(0)
  const changedWorker = view(first.state, { transcriptRows: rows, workers: [worker({ status: 'completed' })], nowMs: 2000 })
  expect(changedWorker.active[0]?.state).toBe('completed')
  expect(visits).toBe(afterFirst)
  const changedRows = view(changedWorker.state, { transcriptRows: [...rows, agentRow({ toolUseId: 'launch-b', result: { isError: false, content: 'done', diff: null, agentId: 'b' } })], workers: [worker({ agentId: 'b' })], nowMs: 3000 })
  expect(changedRows.active.some(row => row.agentId === 'b')).toBe(true)
  expect(visits).toBeGreaterThan(afterFirst)
})

// This is the lifecycle owner: snapshots can evict records before parent results
// arrive, and transcript launch acknowledgements must never imply completion.
test('blocked completed workers stay waiting, ordered ahead of live work and unnamed rows lead with their task', () => {
  const result = view(createSubagentDockState(), { workers: [worker({ agentId: 'b' }), worker({ status: 'completed', handoffStatus: 'blocked', blockReason: 'Need a decision', handle: 'a' })] })
  expect(result.active.map(row => [row.agentId, row.state])).toEqual([['a', 'waiting'], ['b', 'running']])
  expect(result.active[0]).toMatchObject({ name: null, task: 'Check paths', stripLines: [null, 'Need a decision'] })
  expect(result.finished).toEqual([])
})

test('foreground disappearance waits for terminal evidence, then settles and retains the result after eviction', () => {
  const runningRow = agentRow({ children: [{ kind: 'assistant-text', id: 'child', sessionId: 'session', frameId: 'child-frame', messageId: 'child-msg', blockIndex: 0, parentToolUseId: 'launch-a', role: 'assistant', content: 'Checking', children: [], model: 'worker-model' }] })
  const start = view(createSubagentDockState(), { workers: [worker()], transcriptRows: [runningRow], tasks: { items: [], subagents: [{ toolUseId: 'launch-a', agentId: 'a', agentName: 'Ada', agentType: 'Explore', isSidechain: true, spawnedAt: 100, isBackgrounded: false }] } })
  expect(start.active[0]?.model).toBe('worker-model')
  const vanished = view(start.state, { nowMs: 1100, transcriptRows: [runningRow] })
  expect(vanished.active.map(row => row.agentId)).toEqual(['a'])
  const terminalRow = agentRow({ status: 'success', result: { isError: false, content: 'Done', diff: null, agentId: 'a', agentUsage: { totalTokens: 2300, toolUses: 2 } } })
  const terminal = view(vanished.state, { nowMs: 1200, transcriptRows: [terminalRow] })
  expect(terminal.active[0]).toMatchObject({ state: 'completed', settling: true })
  expect(terminal.nextUpdateAt).toBe(1900)
  const settled = view(terminal.state, { nowMs: 1900 })
  expect(settled.active).toEqual([])
  expect(settled.finished[0]).toMatchObject({ agentId: 'a', stripLines: ['worker-model · 2 tool calls · 2.3k tokens', null] })
})

test('disappearance without terminal evidence expires without inventing a finished outcome', () => {
  const start = view(createSubagentDockState(), { workers: [worker()] })
  const missing = view(start.state, { nowMs: 1100 })
  expect(missing.nextUpdateAt).toBe(3100)
  expect(view(missing.state, { nowMs: 3100 }).active).toEqual([])
  expect(view(missing.state, { nowMs: 3100 }).finished).toEqual([])
})

for (const [status, delay, state] of [['failed', 1500, 'failed'], ['killed', 700, 'stopped'], ['completed', 700, 'completed']] as const) {
  test(`${status} holds in place for ${delay}ms, then enters Finished without replay on restore`, () => {
    const running = view(createSubagentDockState(), { workers: [worker()] })
    const terminal = view(running.state, { workers: [worker({ status })], nowMs: 2000 })
    expect(terminal.active[0]).toMatchObject({ state, settling: true })
    expect(view(terminal.state, { workers: [worker({ status })], nowMs: 2000 + delay - 1 }).active).toHaveLength(1)
    const finished = view(terminal.state, { workers: [worker({ status })], nowMs: 2000 + delay })
    expect(finished.finished[0]?.state).toBe(state)
    expect(view(createSubagentDockState(Object.values(terminal.state.entries)), { workers: [worker({ status })], nowMs: 2001 }).finished[0]?.state).toBe(state)
  })
}

test('clear stays cleared as transcript evidence arrives, but a resumed background run and its finish show again once', () => {
  const first = view(createSubagentDockState(), { workers: [worker({ status: 'completed' })], tasks: { items: [task({ status: 'completed', endTime: 800 })], subagents: [] } })
  const clearMarkers = [{ agentId: 'a', runKey: first.finished[0]!.runKey }]
  const oldRow = agentRow({ status: 'success', result: { isError: false, content: 'Done', diff: null, agentId: 'a' } })
  const enriched = view(first.state, { workers: [worker({ status: 'completed' })], transcriptRows: [oldRow], clearMarkers })
  expect(enriched.finished).toEqual([])
  const resumed = view(enriched.state, { workers: [worker({ isBackgrounded: true })], tasks: { items: [task({ isBackgrounded: true, resumedAt: 2000 })], subagents: [] }, transcriptRows: [oldRow], clearMarkers, nowMs: 2100 })
  expect(resumed.active).toHaveLength(1)
  expect(resumed.active[0]).toMatchObject({ state: 'resumed', resumedAt: 2000, chipLines: [null, null] })
  const resumeRow = agentRow({ toolUseId: 'resume-a', toolName: 'ResumeAgent', input: { agentId: 'a', prompt: 'Check again' }, status: 'success', result: { isError: false, content: 'Started', diff: null, agentUsage: { totalTokens: 9000, toolUses: 99 } }, agentCompletion: { status: 'completed', summary: 'Done', result: 'Checked', usage: { totalTokens: 500, toolUses: 1, durationMs: 100 } } })
  const done = view(resumed.state, { workers: [worker({ status: 'completed', isBackgrounded: true })], tasks: { items: [task({ status: 'completed', resumedAt: 2000, endTime: 3000 })], subagents: [] }, transcriptRows: [oldRow, resumeRow], clearMarkers, nowMs: 4000, reducedMotion: true })
  expect(done.finished).toHaveLength(1)
  expect(done.finished[0]).toMatchObject({ runKey: 'resume-a', usageLabel: '1 tool call · 500 tokens' })
})

test('capped unordered completions stay cleared after cold reload, while independent later runs remain eligible', () => {
  const rows = Array.from({ length: MAX_PERSISTED_DOCK_FINISHED + 1 }, (_, index) => agentRow({
    id: `row-${index}`, toolUseId: `launch-${index}`, blockIndex: index, status: 'success',
    result: { isError: false, content: 'Done', diff: null, agentId: `agent-${index}` },
  }))
  // The first launch finishes last; the middle launch at index 1 is capped.
  const first = view(createSubagentDockState(), {
    transcriptRows: rows, nowMs: 20_000, reducedMotion: true,
    tasks: { items: rows.map((_, index) => task({ id: `agent-${index}`, status: 'completed', endTime: index === 0 ? 10_000 : 100 + index })), subagents: [] },
  })
  expect(first.finished).toHaveLength(128)
  expect(first.finished[0]).toMatchObject({ agentId: 'agent-0', terminalAt: 10_000 })
  expect(first.state.entries['agent-1']).toBeUndefined()
  const storage = memoryStorage()
  writeSubagentDockSessionsToStorage(storage, { session: {
    finished: Object.values(first.state.entries),
    cleared: first.finished.map(entry => ({ agentId: entry.agentId, runKey: entry.runKey })),
  } })
  const saved = readSubagentDockSessionsFromStorage(memoryStorage(Object.fromEntries(storage.map)))!.session!
  const reload = (patch: Partial<SubagentDockInput> = {}) => view(createSubagentDockState(saved.finished), {
    transcriptRows: rows, clearMarkers: saved.cleared, nowMs: 30_000, reducedMotion: true, ...patch,
  })
  const cold = reload()
  expect(cold.state.entries['agent-1']).toBeUndefined()
  expect(Object.keys(cold.state.entries)).toHaveLength(128)
  expect(cold.state.entries['agent-0']?.terminalAt).toBe(10_000)
  expect(cold.finished).toEqual([])
  expect(view(cold.state, { transcriptRows: rows, clearMarkers: saved.cleared, nowMs: 40_000 }).finished).toEqual([])
  expect(reload({ tasks: { items: [task({ id: 'agent-1', status: 'completed', endTime: 101 })], subagents: [] } }).finished).toEqual([])

  // Later task evidence may arrive with reload or after its first reconciliation.
  for (const prior of [createSubagentDockState(saved.finished), cold.state]) {
    const laterCompletion = view(prior, {
      transcriptRows: rows, clearMarkers: saved.cleared, nowMs: 30_000, reducedMotion: true,
      tasks: { items: [task({ id: 'agent-1', status: 'completed', endTime: 20_000 })], subagents: [] },
    })
    expect(laterCompletion.finished.map(entry => [entry.agentId, entry.terminalAt])).toEqual([['agent-1', 20_000]])
    expect(Object.keys(laterCompletion.state.entries)).toHaveLength(128)
  }

  const newRun = agentRow({ toolUseId: 'resume-1', toolName: 'ResumeAgent', input: { agentId: 'agent-1' }, status: 'success',
    agentCompletion: { status: 'completed', summary: 'Done again', result: null, usage: null } })
  const transcriptRun = reload({ transcriptRows: [...rows, newRun] })
  expect(transcriptRun.finished.map(entry => [entry.agentId, entry.runKey])).toEqual([['agent-1', 'resume-1']])
  expect(Object.keys(transcriptRun.state.entries)).toHaveLength(128)

  const resumedAfterReload = reload({
    workers: [worker({ agentId: 'agent-1', status: 'completed', isBackgrounded: true })],
    tasks: { items: [task({ id: 'agent-1', status: 'completed', resumedAt: 20_000, isBackgrounded: true })], subagents: [] },
  })
  expect(resumedAfterReload.finished.map(entry => [entry.agentId, entry.runKey])).toEqual([['agent-1', 'resume:20000']])

  const resumedFacts = {
    workers: [worker({ agentId: 'agent-1', isBackgrounded: true })],
    tasks: { items: [task({ id: 'agent-1', resumedAt: 20_000, isBackgrounded: true })], subagents: [] },
  }
  const resumed = reload(resumedFacts)
  expect(resumed.active.map(entry => [entry.agentId, entry.state, entry.runKey])).toEqual([['agent-1', 'resumed', 'resume:20000']])
  expect(resumed.finished).toEqual([])
  expect(Object.keys(resumed.state.entries)).toHaveLength(129)
  const resumedCompletion = view(resumed.state, {
    transcriptRows: rows, clearMarkers: saved.cleared, nowMs: 40_000, reducedMotion: true,
    workers: [worker({ agentId: 'agent-1', status: 'completed', isBackgrounded: true })],
    tasks: { items: [task({ id: 'agent-1', status: 'completed', resumedAt: 20_000, endTime: 25_000, isBackgrounded: true })], subagents: [] },
  })
  expect(resumedCompletion.finished.map(entry => [entry.agentId, entry.runKey, entry.terminalAt])).toEqual([['agent-1', 'resume:20000', 25_000]])
  expect(Object.keys(resumedCompletion.state.entries)).toHaveLength(128)
})

const leases: LeaseSnapshot = {
  strategy: 'spread', accounts: [], owners: [{ leaseId: 'lease-a', ownerId: 'a', ownerType: 'subagent', ownerLabel: 'Check paths', accountId: 'account-id', accountAlias: 'Work', strategy: 'spread', state: 'active', createdAt: 500, updatedAt: 500, failoverCount: 1, selectionKind: 'failover', selectionReason: 'moved' }],
}
for (const state of ['running', 'background', 'resumed', 'waiting', 'completed', 'failed', 'stopped'] as const) {
  test(`${state} detail uses its own facts, with model omitted only when visible on row`, () => {
    const row = agentRow({ status: state === 'completed' ? 'success' : 'pending', result: { isError: false, content: '', diff: null, agentId: 'a', agentModel: 'unknown-model', agentAccount: { accountId: 'stamp', accountAlias: 'Recorded' }, agentUsage: { totalTokens: 500, toolUses: 3 } }, input: { run_in_background: state === 'background' || state === 'resumed' }, children: [agentRow({ toolName: 'Read', toolFamily: 'read', input: { file_path: '/tmp/a' } })] })
    const live = worker({ status: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'stopped' ? 'killed' : state === 'waiting' ? 'completed' : 'running', isBackgrounded: state === 'background' || state === 'resumed', ...(state === 'waiting' ? { handoffStatus: 'blocked', blockReason: 'Missing input' } : {}), verdict: 'PASS', resultSummary: 'Checked' })
    const result = view(createSubagentDockState(), { workers: [live], tasks: { items: [task({ resumedAt: state === 'resumed' ? 900 : undefined })], subagents: [] }, transcriptRows: [row], leases })
    const item = [...result.active, ...result.finished][0]!
    expect(item.state).toBe(state)
    const modelOnRow = state === 'running' || state === 'background' || state === 'resumed'
    expect(item.rowModel).toBe(modelOnRow ? 'unknown-model' : null)
    if (modelOnRow) expect(item.stripLines[0]).not.toContain('unknown-model')
    else expect(item.stripLines[0]).toContain('unknown-model')
    expect(item.chipLines[0]).toContain('unknown-model')
    expect(item.chipLines[1]).toBe(state === 'running' ? 'Read /tmp/a' : state === 'background' || state === 'resumed' ? 'held 0s' : state === 'waiting' ? 'Missing input' : state === 'completed' ? 'PASS · Checked' : null)
    expect(item.chipLines[0]).toContain(state === 'completed' ? '3 tool calls' : state === 'running' || state === 'background' || state === 'resumed' ? 'Work' : 'Recorded')
    if (state === 'background' || state === 'resumed') expect(item.chipLines[0]).toContain('moved once')
  })
}

test('background workers without leases show no activity, held duration or invented account', () => {
  const result = view(createSubagentDockState(), { workers: [worker({ isBackgrounded: true })] })
  expect(result.active[0]).toMatchObject({ account: null, stripLines: [null, null], chipLines: [null, null] })
})

// The tasks feed can announce a fresh resume before the new ResumeAgent card
// lands; the old settled card must remain historical through repeated frames.
test('a second resume ignores its first settled ResumeAgent card and returns behind older live workers', () => {
  const oldResume = agentRow({ toolName: 'ResumeAgent', toolUseId: 'resume-old', input: { agentId: 'a' }, status: 'success', agentCompletion: { status: 'failed', summary: 'Failed', result: null, usage: null } })
  const old = view(createSubagentDockState(), { workers: [worker({ status: 'failed' }), worker({ agentId: 'b' })], transcriptRows: [oldResume], tasks: { items: [task({ resumedAt: 500, status: 'failed', endTime: 900 })], subagents: [] } })
  const clearMarkers = [{ agentId: 'a', runKey: 'resume-old' }]
  const resumedFacts = { workers: [worker({ isBackgrounded: true }), worker({ agentId: 'b' })], transcriptRows: [oldResume], tasks: { items: [task({ resumedAt: 2000, isBackgrounded: true })], subagents: [] }, clearMarkers, nowMs: 2100 }
  const resumed = view(old.state, resumedFacts)
  expect(resumed.active.map(row => [row.agentId, row.state])).toEqual([['b', 'running'], ['a', 'resumed']])
  const later = view(resumed.state, { ...resumedFacts, nowMs: 2200 })
  expect(later.active.map(row => [row.agentId, row.state])).toEqual([['b', 'running'], ['a', 'resumed']])
  const finished = view(later.state, { workers: [worker({ status: 'completed', isBackgrounded: true })], transcriptRows: [oldResume], tasks: { items: [task({ resumedAt: 2000, status: 'completed', endTime: 2500 })], subagents: [] }, clearMarkers, nowMs: 3000, reducedMotion: true })
  expect(finished.finished[0]).toMatchObject({ agentId: 'a', state: 'completed', runKey: 'resume:2000' })
  const cleared = [...clearMarkers, { agentId: 'a', runKey: 'resume:2000' }]
  const newResume = agentRow({ ...oldResume, toolUseId: 'resume-new', agentCompletion: { status: 'completed', summary: 'Done', result: 'Checked again', usage: null } })
  const enriched = view(finished.state, { transcriptRows: [oldResume, newResume], clearMarkers: cleared, nowMs: 3100 })
  expect(enriched.finished).toEqual([])
  expect(enriched.active.some(row => row.agentId === 'a')).toBe(false)

})


test('implicit background dispatch keeps its successful launch active until terminal worker evidence', () => {
  const launch = agentRow({ status: 'success', result: { isError: false, content: 'Started', diff: null, agentId: 'a' } })
  const facts = { workers: [worker({ isBackgrounded: true })], tasks: { items: [task({ isBackgrounded: true })], subagents: [] }, transcriptRows: [launch] }
  const running = view(createSubagentDockState(), facts)
  expect(running.active.map(row => row.state)).toEqual(['background'])
  expect(running.finished).toEqual([])
  const missing = view(running.state, { transcriptRows: [launch], nowMs: 1100 })
  expect(missing.active.map(row => row.state)).toEqual(['background'])
  expect(view(missing.state, { transcriptRows: [launch], nowMs: 3100 }).finished).toEqual([])
  const terminal = view(running.state, { ...facts, workers: [worker({ status: 'completed', isBackgrounded: true })], nowMs: 2000, reducedMotion: true })
  expect(terminal.finished.map(row => row.state)).toEqual(['completed'])
})

test('alias resumes use canonical task identity and keep their transcript join after eviction and restore', () => {
  const original = agentRow({ status: 'success', result: { isError: false, content: 'Done', diff: null, agentId: 'a', agentName: 'Ada' } })
  const resume = agentRow({ toolName: 'ResumeAgent', toolUseId: 'resume-alias', input: { agentId: '@Ada' }, status: 'success', agentCompletion: null })
  const facts = { workers: [worker({ isBackgrounded: true })], tasks: { items: [task({ isBackgrounded: true, resumedAt: 2000 })], subagents: [{ toolUseId: 'resume-alias', agentId: 'a', agentName: 'Ada', agentType: 'Explore', isSidechain: true as const, spawnedAt: 2000, isBackgrounded: true }] }, transcriptRows: [original, resume], nowMs: 2100 }
  const running = view(createSubagentDockState(), facts)
  expect(running.active.map(row => [row.agentId, row.state, row.toolUseId])).toEqual([['a', 'resumed', 'resume-alias']])
  const completion = { ...resume, agentCompletion: { status: 'completed' as const, summary: 'Done', result: 'Checked', usage: { toolUses: 1, totalTokens: 500, durationMs: 100 } } }
  const finished = view(running.state, { transcriptRows: [completion], nowMs: 3000, reducedMotion: true })
  expect(finished.active).toEqual([])
  expect(finished.finished.map(row => [row.agentId, row.toolUseId, row.usageLabel])).toEqual([['a', 'resume-alias', '1 tool call · 500 tokens']])
  const restored = view(createSubagentDockState(), { transcriptRows: [original, completion], reducedMotion: true })
  expect(restored.finished.map(row => row.agentId)).toEqual(['a'])
  const unresolved = view(createSubagentDockState(), { transcriptRows: [completion], reducedMotion: true })
  expect(unresolved.finished).toEqual([])
})

test('an exhausted account failover never claims a successful move or a held lease', () => {
  const failedLease: LeaseSnapshot = { ...leases, owners: [{ ...leases.owners[0]!, state: 'failed' }] }
  const result = view(createSubagentDockState(), { workers: [worker({ isBackgrounded: true })], leases: failedLease })
  expect(result.active[0]).toMatchObject({ account: null, chipLines: [null, null], stripLines: [null, null] })
})

test('a rejected resume preserves the cleared finished run and its transcript target', () => {
  const launch = agentRow({ status: 'success', result: { isError: false, content: 'Done', diff: null, agentId: 'a' } })
  const finished = view(createSubagentDockState(), { transcriptRows: [launch], reducedMotion: true })
  const clearMarkers = [{ agentId: 'a', runKey: finished.finished[0]!.runKey }]
  const rejected = agentRow({ toolName: 'ResumeAgent', toolUseId: 'rejected-resume', input: { agentId: 'a' }, status: 'success', result: { isError: false, content: JSON.stringify({ success: false, message: 'No transcript to resume' }), diff: null } })
  const unchanged = view(finished.state, { transcriptRows: [launch, rejected], clearMarkers, nowMs: 2000 })
  expect(unchanged.finished).toEqual([])
  expect(unchanged.state.entries.a).toMatchObject({ runKey: 'launch-a', toolUseId: 'launch-a' })
})
