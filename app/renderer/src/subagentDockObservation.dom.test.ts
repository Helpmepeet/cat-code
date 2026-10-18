import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { useSubagentDockObservation, readSubagentDockObservation, commitSubagentDockObservation,
  type SubagentDockObservationInput } from './subagentDockObservation.js'
import { useSubagentDock } from './subagentDockController.js'
import { createSubagentDockState, reconcileSubagentDockState, selectSubagentDock } from './subagentDockState.js'
import { SubagentDock } from './SubagentDock.js'
import { MAX_PERSISTED_DOCK_FINISHED, SUBAGENT_DOCK_SESSIONS_STORAGE_KEY, readSubagentDockSessionsFromStorage,
  writeSubagentDockSessionsToStorage } from './subagentDockPersistence.js'
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
let originalLocalStorage: PropertyDescriptor | undefined
beforeAll(async () => {
  harness = await createDomTestHarness()
  originalWindowMatchMedia = window.matchMedia
  originalGlobalMatchMedia = globalThis.matchMedia
  const matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.matchMedia = matchMedia
  globalThis.matchMedia = matchMedia
  // Happy DOM's Storage proxy returns bound methods that bypass spyOn.
  // Keep the real storage and expose stable methods for measured hook calls.
  const storage = window.localStorage
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage), clear: storage.clear.bind(storage),
    key: storage.key.bind(storage), get length() { return storage.length },
  } })
})
afterEach(async () => { await harness.unmountAll(); window.localStorage.clear() })
afterAll(async () => {
  if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage)
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

function persistenceFixture(id: string, durableId: string | null) {
  let transcript = projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: id, engineSessionId: durableId ?? id,
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
  })
  for (const [index, agentId] of ['finished-agent', 'live-agent'].entries()) {
    const messages: SDKMessage[] = [
      { type: 'assistant', uuid: `00000000-0000-4000-8000-${String(index * 2).padStart(12, '0')}`, parent_tool_use_id: null,
        message: { id: `launch-${index}`, role: 'assistant', content: [{ type: 'tool_use', id: `${id}-run-${index}`, name: 'Agent', input: { description: agentId, run_in_background: true } }] } },
      { type: 'user', uuid: `00000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-run-${index}`, content: 'Started', is_error: false }] }, tool_use_result: { agentId } },
    ]
    for (const message of messages) transcript = projectServerFrame(transcript, {
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: id, event: { type: 'message', message },
    })
  }
  const workers: LiveWorkerItem[] = [
    { agentId: 'finished-agent', handle: '@Finished', role: 'Explore', description: 'finished-agent', status: 'completed', isBackgrounded: true },
    { agentId: 'live-agent', handle: '@Live', role: 'Explore', description: 'live-agent', status: 'running', isBackgrounded: true },
  ]
  const items: TaskSnapshotItem[] = workers.map(row => ({
    id: row.agentId, type: 'local_agent', label: row.description!, status: row.status === 'completed' ? 'completed' : 'running',
    startTime: 100, isBackgrounded: true, ...(row.status === 'completed' ? { endTime: 200 } : {}),
  }))
  const input: SubagentDockObservationInput = {
    sessions: [sessionDescriptor(id, { engineSessionId: durableId })], transcript, leases: createLeaseState(),
    workers: reduceWorkersState(createWorkersState(), { type: 'frame', frame: { kind: 'workers.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id, workers: { workers } } }),
    tasks: reduceTasksState(createTasksState(), { type: 'frame', frame: { kind: 'tasks.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id, tasks: { items, subagents: [] } } }),
  }
  return input
}

function PersistencePane({ input }: { input: SubagentDockObservationInput }) {
  const session = input.sessions[0]!
  const { dock, clearFinished } = useSubagentDock(session.appSessionId, session.engineSessionId, {
    workers: input.workers.bySession[session.appSessionId]?.workers ?? [],
    tasks: input.tasks.bySession[session.appSessionId] ?? null,
    transcriptRows: selectNestedTranscriptRows(input.transcript, session.appSessionId), leases: null,
  })
  return createElement('div', null, createElement('button', { onClick: clearFinished }, 'Clear'),
    createElement('output', null, JSON.stringify({ active: dock.active, finished: dock.finished })))
}
function PersistenceShell({ input, observer = true, pane = true }: {
  input: SubagentDockObservationInput; observer?: boolean; pane?: boolean
}) {
  return createElement('div', null,
    observer ? createElement(ObservationOnly, { input }) : null,
    pane ? createElement(PersistencePane, { input }) : null)
}
function ObservationOnly({ input }: { input: SubagentDockObservationInput }) {
  useSubagentDockObservation(input)
  return null
}
function projectText(input: SubagentDockObservationInput, revision: number) {
  const transcript = projectServerFrame(input.transcript, {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: input.sessions[0]!.appSessionId,
    event: { type: 'message', message: {
      type: 'assistant', uuid: `00000000-0000-4000-9000-${String(revision).padStart(12, '0')}`, parent_tool_use_id: null,
      message: { id: `text-${revision}`, role: 'assistant', content: [{ type: 'text', text: `Streaming update ${revision}` }] },
    } },
  })
  expect(transcript).not.toBe(input.transcript)
  return { ...input, transcript }
}
async function expectNoHistoryChurn(update: () => Promise<void>) {
  const read = spyOn(window.localStorage, 'getItem')
  const write = spyOn(window.localStorage, 'setItem')
  try {
    window.localStorage.getItem(SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    await update()
    expect(write.mock.calls.filter(([key]) => key === SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)).toHaveLength(0)
    expect(read.mock.calls.filter(([key]) => key === SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)).toHaveLength(0)
  } finally { read.mockRestore(); write.mockRestore() }
}

test('mounted observer and pane do not reread finished history during projected text updates', async () => {
  let input = persistenceFixture('alias-regression', 'durable-alias-regression')
  const tree = await harness.mount(createElement(PersistenceShell, { input }))
  await tree.render(createElement(PersistenceShell, { input }))
  const display = () => JSON.parse(tree.container.querySelector('output')!.textContent!)
  const finishedDisplay = () => display().finished.map((row: {
    agentId: string; runKey: string; state: string; task: string; terminalAt: number
  }) => ({ agentId: row.agentId, runKey: row.runKey, state: row.state, task: row.task, terminalAt: row.terminalAt }))
  const finished = finishedDisplay()
  expect(finished).toHaveLength(1)
  expect(finished[0].runKey).toBe('alias-regression-run-0')
  expect(display().active.map((row: { agentId: string }) => row.agentId)).toEqual(['live-agent'])
  const saved = readSubagentDockSessionsFromStorage(window.localStorage)
  await expectNoHistoryChurn(async () => {
    for (const revision of [1, 2, 3]) {
      input = projectText(input, revision)
      await tree.render(createElement(PersistenceShell, { input }))
      expect(finishedDisplay()).toEqual(finished)
      expect(display().active.map((row: { agentId: string }) => row.agentId)).toEqual(['live-agent'])
    }
  })
  expect(readSubagentDockSessionsFromStorage(window.localStorage)).toEqual(saved)
})

for (const first of ['observer', 'pane'] as const) test(`${first}-only app alias migration retains Clear markers before attaching both callers`, async () => {
  const id = `migration-${first}`
  let input = persistenceFixture(id, null)
  const sources = {
    workers: input.workers.bySession[id]!.workers, tasks: input.tasks.bySession[id]!,
    transcriptRows: selectNestedTranscriptRows(input.transcript, id), leases: null, nowMs: 300, reducedMotion: true,
  }
  const state = reconcileSubagentDockState(createSubagentDockState(), sources)
  const finished = Object.values(state.entries).filter(row => row.state === 'completed')
  const cleared = [{ agentId: 'older-agent', runKey: 'older-run' }]
  const unrelated = { cleared: [{ agentId: 'unrelated-agent', runKey: 'unrelated-run' }], finished: [] }
  writeSubagentDockSessionsToStorage(window.localStorage, { [id]: { finished, cleared }, unrelated })
  const expected = readSubagentDockSessionsFromStorage(window.localStorage)![id]!
  const mode = { observer: first === 'observer', pane: first === 'pane' }
  const tree = await harness.mount(createElement(PersistenceShell, { input, ...mode }))
  input = { ...input, sessions: [sessionDescriptor(id, { engineSessionId: `durable-${id}` })] }
  await tree.render(createElement(PersistenceShell, { input, ...mode }))
  const saved = readSubagentDockSessionsFromStorage(window.localStorage)!
  expect(saved[id]).toBeUndefined()
  expect(saved[`durable-${id}`]).toEqual(expected)
  expect(saved.unrelated).toEqual(unrelated)
  await tree.render(createElement(PersistenceShell, { input }))
  await tree.render(createElement(PersistenceShell, { input }))
  await expectNoHistoryChurn(async () => {
    for (const revision of [1, 2, 3]) {
      input = projectText(input, revision)
      await tree.render(createElement(PersistenceShell, { input }))
    }
  })
  expect(readSubagentDockSessionsFromStorage(window.localStorage)![`durable-${id}`]).toEqual(expected)
})

test('pane preserves the actual previous durable key during a durable-to-durable transition', async () => {
  const id = 'durable-transition'
  let input = persistenceFixture(id, 'durable-before')
  const tree = await harness.mount(createElement(PersistenceShell, { input, observer: false }))
  await act(async () => { tree.container.querySelector('button')!.click() })
  const before = readSubagentDockSessionsFromStorage(window.localStorage)!['durable-before']!
  expect(before.cleared).toEqual([{ agentId: 'finished-agent', runKey: `${id}-run-0` }])
  input = { ...input, sessions: [sessionDescriptor(id, { engineSessionId: 'durable-after' })] }
  await tree.render(createElement(PersistenceShell, { input, observer: false }))
  const after = readSubagentDockSessionsFromStorage(window.localStorage)!
  expect(after['durable-before']).toBeUndefined()
  expect(after['durable-after']).toEqual(before)
  expect(readSubagentDockObservation(id, 'durable-before', window.localStorage)).toBeNull()
  expect(JSON.parse(tree.container.querySelector('output')!.textContent!).finished).toEqual([])
})

test('Clear markers and unrelated records survive unchanged text and a terminal-field write', async () => {
  const id = 'clear-terminal-write'
  let input = persistenceFixture(id, `durable-${id}`)
  const tree = await harness.mount(createElement(PersistenceShell, { input }))
  await act(async () => { tree.container.querySelector('button')!.click() })
  const unrelated = { cleared: [{ agentId: 'other', runKey: 'other-run' }], finished: [] }
  const saved = readSubagentDockSessionsFromStorage(window.localStorage)!
  writeSubagentDockSessionsToStorage(window.localStorage, { ...saved, unrelated })
  input = projectText(input, 1)
  await tree.render(createElement(PersistenceShell, { input }))
  expect(JSON.parse(tree.container.querySelector('output')!.textContent!).finished).toEqual([])
  const workers = input.workers.bySession[id]!.workers.map(row => row.agentId === 'finished-agent' ? { ...row, description: 'Updated terminal description' } : row)
  input = { ...input, workers: reduceWorkersState(input.workers, { type: 'frame', frame: {
    kind: 'workers.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id, workers: { workers },
  } }) }
  const read = spyOn(window.localStorage, 'getItem')
  const write = spyOn(window.localStorage, 'setItem')
  try {
    await tree.render(createElement(PersistenceShell, { input }))
    expect(read.mock.calls.some(([key]) => key === SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)).toBe(true)
    expect(write.mock.calls.some(([key]) => key === SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)).toBe(true)
  } finally { read.mockRestore(); write.mockRestore() }
  const after = readSubagentDockSessionsFromStorage(window.localStorage)!
  expect(after.unrelated).toEqual(unrelated)
  expect(after[`durable-${id}`]!.cleared).toEqual([{ agentId: 'finished-agent', runKey: `${id}-run-0` }])
  expect(after[`durable-${id}`]!.finished[0]!.task).toBe('Updated terminal description')
  expect(JSON.parse(tree.container.querySelector('output')!.textContent!).finished).toEqual([])
})

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
