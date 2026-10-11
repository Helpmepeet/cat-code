import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { useSubagentDockObservation, readSubagentDockObservation, commitSubagentDockObservation,
  type SubagentDockObservationInput } from './subagentDockObservation.js'
import { useSubagentDock } from './subagentDockController.js'
import { createSubagentDockState, reconcileSubagentDockState, selectSubagentDock } from './subagentDockState.js'
import { SubagentDock } from './SubagentDock.js'
import { MAX_PERSISTED_DOCK_FINISHED, readSubagentDockSessionsFromStorage } from './subagentDockPersistence.js'
import { createWorkersState, reduceWorkersState } from './workersState.js'
import { createTasksState, reduceTasksState } from './tasksState.js'
import { createLeaseState } from './leaseState.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from './transcriptProjector.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { PROTOCOL_VERSION, type LiveWorkerItem, type TaskSnapshotItem } from '../../shared/protocol.js'
import type { SDKMessage } from '@cat-code/engine/session-events'

let harness: DomTestHarness
let originalWindowMatchMedia: typeof window.matchMedia
let originalGlobalMatchMedia: typeof globalThis.matchMedia
beforeAll(async () => {
  harness = await createDomTestHarness()
  originalWindowMatchMedia = window.matchMedia
  originalGlobalMatchMedia = globalThis.matchMedia
  const matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.matchMedia = matchMedia
  globalThis.matchMedia = matchMedia
})
afterEach(async () => { await harness.unmountAll(); window.localStorage.clear() })
afterAll(async () => {
  window.matchMedia = originalWindowMatchMedia
  globalThis.matchMedia = originalGlobalMatchMedia
  await harness.teardown()
})

const sessionId = 'offscreen-session'
const engineId = 'engine-offscreen-session'
function View({ input }: { input: SubagentDockObservationInput }) {
  const { dock, clearFinished } = useSubagentDock(sessionId, engineId, {
    workers: input.workers.bySession[sessionId]?.workers ?? [],
    tasks: input.tasks.bySession[sessionId] ?? null,
    transcriptRows: selectNestedTranscriptRows(input.transcript, sessionId), leases: null,
  })
  return createElement('section', { ref: (element: HTMLElement | null) => {
    if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 600)
  } }, createElement(SubagentDock, { state: dock, collapsed: false, onCollapsedChange() {},
    onClearFinished: clearFinished, onOpenWorker() {}, onOpenWorkers() {} }))
}
function Shell({ input, visible = false }: { input: SubagentDockObservationInput; visible?: boolean }) {
  useSubagentDockObservation(input)
  return visible ? createElement(View, { input }) : null
}
function snapshots(input: SubagentDockObservationInput, workers: LiveWorkerItem[], items: TaskSnapshotItem[]) {
  return { ...input,
    workers: reduceWorkersState(input.workers, { type: 'frame', frame: { kind: 'workers.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId, workers: { workers } } }),
    tasks: reduceTasksState(input.tasks, { type: 'frame', frame: { kind: 'tasks.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId, tasks: { items, subagents: [] } } }),
  }
}
const worker = (status: LiveWorkerItem['status']): LiveWorkerItem => ({ agentId: 'offscreen-agent', handle: '@Ada', role: 'Explore', description: 'Inspect background work', status, isBackgrounded: true })
const task = (patch: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem => ({ id: 'offscreen-agent', type: 'local_agent', label: 'Inspect background work', status: 'running', startTime: 100, isBackgrounded: true, ...patch })

// This workflow owns the missing shell lifetime: no pane exists when the
// terminal worker arrives or is evicted, and no terminal transcript is supplied.
test('offscreen completion survives eviction, Clear, and another resume without unchanged storage churn', async () => {
  window.localStorage.clear()
  let transcript = projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: engineId,
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
  })
  const messages: SDKMessage[] = [
    { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000001', parent_tool_use_id: null,
      message: { id: 'launch-msg', role: 'assistant', content: [{ type: 'tool_use', id: 'offscreen-launch', name: 'Agent', input: { description: 'Inspect background work', run_in_background: true } }] } },
    { type: 'user', uuid: '00000000-0000-4000-8000-000000000002', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'offscreen-launch', content: 'Started', is_error: false }] }, tool_use_result: { agentId: 'offscreen-agent' } },
  ]
  for (const message of messages) transcript = projectServerFrame(transcript, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId, event: { type: 'message', message } })
  let input: SubagentDockObservationInput = {
    sessions: [sessionDescriptor(sessionId), sessionDescriptor('closed-empty')],
    workers: createWorkersState(), tasks: createTasksState(), transcript, leases: createLeaseState(),
  }
  input = snapshots(input, [worker('running')], [task()])
  const tree = await harness.mount(createElement(Shell, { input }))
  expect(tree.container.querySelector('.subagent-dock')).toBeNull()
  expect(readSubagentDockObservation(sessionId, engineId, window.localStorage)?.entries['offscreen-agent']?.state).toBe('background')
  input = snapshots(input, [worker('completed')], [task({ status: 'completed', endTime: 200 })])
  await tree.render(createElement(Shell, { input }))
  const completed = readSubagentDockObservation(sessionId, engineId, window.localStorage)!
  const firstRun = readSubagentDockSessionsFromStorage(window.localStorage)![engineId].finished[0]!
  expect(firstRun).toMatchObject({ agentId: 'offscreen-agent', state: 'completed', runKey: 'offscreen-launch' })
  expect(readSubagentDockSessionsFromStorage(window.localStorage)?.['engine-closed-empty']).toBeUndefined()
  const write = spyOn(window.localStorage, 'setItem')
  const read = spyOn(window.localStorage, 'getItem')
  try {
    input = snapshots(input, [worker('completed')], [task({ status: 'completed', endTime: 200 })])
    await tree.render(createElement(Shell, { input }))
    expect(write).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  } finally { write.mockRestore(); read.mockRestore() }
  input = snapshots(input, [], [])
  await tree.render(createElement(Shell, { input }))
  await tree.render(createElement(Shell, { input, visible: true }))
  expect(tree.container.querySelector('[aria-label="Ada, completed"]')).not.toBeNull()
  const clear = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clear')!
  await act(async () => { clear.click() })
  await tree.render(createElement(Shell, { input }))
  expect(readSubagentDockSessionsFromStorage(window.localStorage)![engineId].cleared).toEqual([{ agentId: 'offscreen-agent', runKey: firstRun.runKey }])
  input = snapshots(input, [worker('running')], [task({ resumedAt: 300 })])
  await tree.render(createElement(Shell, { input }))
  const stale = commitSubagentDockObservation(sessionId, engineId, completed, window.localStorage)
  expect(stale.entries['offscreen-agent']?.state).toBe('resumed')
  input = snapshots(input, [worker('completed')], [task({ resumedAt: 300, status: 'completed', endTime: 400 })])
  await tree.render(createElement(Shell, { input }))
  input = snapshots(input, [], [])
  await tree.render(createElement(Shell, { input, visible: true }))
  expect(tree.container.querySelectorAll('[aria-label="Ada, completed"]')).toHaveLength(1)
  const latest = readSubagentDockSessionsFromStorage(window.localStorage)![engineId]
  expect(latest.finished[0]?.runKey).not.toBe(firstRun.runKey)
  expect(latest.cleared).toEqual([{ agentId: 'offscreen-agent', runKey: firstRun.runKey }])
})

test('bounded finished history stays stable across pane renders, Clear and a resumed evicted agent', async () => {
  const historySessionId = 'bounded-history-session'
  const historyEngineId = 'bounded-history-engine'
  let now = 5000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  try {
    let transcript = projectServerFrame(createTranscriptState(), {
      kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: historySessionId, engineSessionId: historyEngineId,
      payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
    })
    for (let index = 0; index < 129; index++) {
      const messages: SDKMessage[] = [
        { type: 'assistant', uuid: `00000000-0000-4000-8000-${String(index * 2).padStart(12, '0')}`, parent_tool_use_id: null,
          message: { id: `launch-message-${index}`, role: 'assistant', content: [{ type: 'tool_use', id: `launch-${index}`, name: 'Agent', input: { description: `Historical agent ${index}` } }] } },
        { type: 'user', uuid: `00000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `launch-${index}`, content: 'Done', is_error: false }] }, tool_use_result: { agentId: `history-agent-${index}` } },
      ]
      for (const message of messages) transcript = projectServerFrame(transcript, {
        kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: historySessionId, event: { type: 'message', message },
      })
    }
    const activeWorker: LiveWorkerItem = { agentId: 'still-running', handle: '@Active', role: 'Explore', status: 'running', description: 'Ongoing work' }
    function HistoryView({ revision, workers = [activeWorker], tasks = null }: {
      revision: number; workers?: LiveWorkerItem[]; tasks?: { items: TaskSnapshotItem[]; subagents: [] } | null
    }) {
      const { dock, clearFinished } = useSubagentDock(historySessionId, historyEngineId, {
        workers, tasks, transcriptRows: selectNestedTranscriptRows(transcript, historySessionId), leases: null,
      })
      return createElement('div', { 'data-revision': revision },
        createElement('button', { onClick: clearFinished }, 'Clear'),
        createElement('output', null, JSON.stringify({ active: dock.active.map(row => [row.agentId, row.state]), finished: dock.finished.map(row => [row.agentId, row.terminalAt, row.runKey]) })))
    }
    const tree = await harness.mount(createElement(HistoryView, { revision: 0 }))
    now = 6000
    await tree.render(createElement(HistoryView, { revision: 1 }))
    const retained = readSubagentDockObservation(historySessionId, historyEngineId, window.localStorage)!
    // The pre-fix cache forgets agent 128, then stamps it as newly finished here.
    expect(retained.entries['history-agent-128']?.terminalAt).toBe(5000)
    const expectedFinished = Array.from({ length: 128 }, (_, index) => [
      `history-agent-${128 - index}`, 5000, `launch-${128 - index}`,
    ])
    const display = () => JSON.parse(tree.container.querySelector('output')!.textContent!)
    expect(display()).toEqual({ active: [['still-running', 'running']], finished: expectedFinished })
    expect(readSubagentDockSessionsFromStorage(window.localStorage)![historyEngineId].finished).toHaveLength(MAX_PERSISTED_DOCK_FINISHED)
    for (const revision of [2, 3]) {
      now += 1000
      await tree.render(createElement(HistoryView, { revision }))
      expect(display()).toEqual({ active: [['still-running', 'running']], finished: expectedFinished })
    }
    await act(async () => { tree.container.querySelector('button')!.click() })
    expect(display()).toEqual({ active: [['still-running', 'running']], finished: [] })
    now = 9000
    await tree.render(createElement(HistoryView, { revision: 4 }))
    expect(display().finished).toEqual([])

    const resumeMessage: SDKMessage = {
      type: 'assistant', uuid: '00000000-0000-4000-8000-000000001000', parent_tool_use_id: null,
      message: { id: 'resume-message', role: 'assistant', content: [{ type: 'tool_use', id: 'resume-0', name: 'ResumeAgent', input: { agentId: 'history-agent-0', prompt: 'Continue' } }] },
    }
    transcript = projectServerFrame(transcript, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: historySessionId, event: { type: 'message', message: resumeMessage } })
    const resumedWorker: LiveWorkerItem = { agentId: 'history-agent-0', handle: '@Resumed', role: 'Explore', status: 'running', description: 'Continue', isBackgrounded: true }
    const resumedTask: TaskSnapshotItem = { id: 'history-agent-0', type: 'local_agent', label: 'Continue', status: 'running', startTime: 100, resumedAt: 9000, isBackgrounded: true }
    await tree.render(createElement(HistoryView, { revision: 5, workers: [activeWorker, resumedWorker], tasks: { items: [resumedTask], subagents: [] } }))
    expect(display()).toEqual({ active: [['still-running', 'running'], ['history-agent-0', 'resumed']], finished: [] })
    now = 10000
    await tree.render(createElement(HistoryView, { revision: 6, workers: [activeWorker, { ...resumedWorker, status: 'completed' }], tasks: { items: [{ ...resumedTask, status: 'completed', endTime: 10000 }], subagents: [] } }))
    expect(display()).toEqual({ active: [['still-running', 'running']], finished: [['history-agent-0', 10000, 'resume-0']] })
    now = 11000
    await tree.render(createElement(HistoryView, { revision: 7 }))
    expect(display()).toEqual({ active: [['still-running', 'running']], finished: [['history-agent-0', 10000, 'resume-0']] })
    const saved = readSubagentDockSessionsFromStorage(window.localStorage)![historyEngineId]
    const restoredInput = { workers: [], tasks: null, transcriptRows: selectNestedTranscriptRows(transcript, historySessionId), leases: null, clearMarkers: saved.cleared, nowMs: 12000, reducedMotion: true }
    const restored = reconcileSubagentDockState(createSubagentDockState(saved.finished), restoredInput)
    expect(selectSubagentDock(restored, restoredInput).finished.map(row => [row.agentId, row.terminalAt, row.runKey])).toEqual([['history-agent-0', 10000, 'resume-0']])
    expect(restored.entries['history-agent-1']).toBeUndefined()
  } finally { clock.mockRestore() }
})
