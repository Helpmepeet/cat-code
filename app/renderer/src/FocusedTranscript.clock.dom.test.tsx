import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { FocusedTranscript } from './FocusedTranscript.js'
import { deriveFocusedTranscript, type FocusedTurnItem } from './focusedTranscriptLayout.js'
import type { FocusedLiveState, NestedTranscriptRow } from './transcriptProjector.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
let now = 10000
let timers: Set<() => void>
let clock: ReturnType<typeof spyOn>
let interval: ReturnType<typeof spyOn>
let clear: ReturnType<typeof spyOn>
beforeAll(async () => { harness = await createDomTestHarness() })
beforeEach(() => {
  now = 10000
  timers = new Set()
  clock = spyOn(Date, 'now').mockImplementation(() => now)
  interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    timers.add(callback)
    return callback as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  clear = spyOn(globalThis, 'clearInterval').mockImplementation(timer => { timers.delete(timer as unknown as () => void) })
})
afterEach(async () => {
  await harness.unmountAll()
  clock.mockRestore()
  interval.mockRestore()
  clear.mockRestore()
})
afterAll(async () => { await harness.teardown() })
const source = (id: string) => ({ id, sessionId: 'clock', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const user: NestedTranscriptRow = { ...source('user'), kind: 'user-text', role: 'user', content: 'Check', isReplay: false }
const prose: NestedTranscriptRow = { ...source('update'), kind: 'assistant-text', role: 'assistant', content: 'Checking' }
const reasoning: NestedTranscriptRow = { ...source('reasoning'), kind: 'thinking', reasoningKind: 'summary', content: 'Tracing' }
const call: NestedTranscriptRow = { ...source('call'), kind: 'tool-use', toolUseId: 'call', toolName: 'Bash', toolFamily: 'bash', input: { command: 'check', timeout: 10000 }, status: 'pending', agentCompletion: null, result: null }
function turn(rows: NestedTranscriptRow[]) {
  return deriveFocusedTranscript(rows, true).find((item): item is FocusedTurnItem => item.kind === 'focused-turn')!
}
async function tick(ms: number) {
  now += ms
  await act(async () => { for (const callback of [...timers]) callback() })
}
function counters(model: FocusedTurnItem) {
  let segments = 0
  let rows = 0
  let thoughts = 0
  const observed = { ...model, get segments() { segments++; return model.segments } }
  const renderRows = () => { rows++; return <span>static rows</span> }
  const renderReasoning = () => { thoughts++; return <span>static reasoning</span> }
  return { observed, renderRows, renderReasoning, counts: () => [segments, rows, thoughts] }
}
const live: FocusedLiveState = { activities: {}, preparing: {}, awaitingApproval: {}, lastVisibleChangeAt: 10000, streaming: false }

test('call clock advances gates and timeout metadata without remapping segments or invoking static renderers', async () => {
  const c = counters(turn([user, prose, reasoning, call]))
  const state: FocusedLiveState = { ...live, activities: { call: { type: 'tool.activity', toolUseId: 'call', phase: 'executing', startedAt: 10000, output: 'working', totalLines: 1 } } }
  const tree = await harness.mount(<FocusedTranscript turn={c.observed} liveState={state} renderRows={c.renderRows} renderReasoning={c.renderReasoning} />)
  const counts = c.counts()
  expect(counts.every(count => count > 0)).toBe(true)
  expect(tree.container.querySelector('.focused-live-out')).toBeNull()
  await tick(2000)
  expect(tree.container.querySelector('.focused-live-out')?.textContent).toBe('working1 lines')
  expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('2s')
  await tick(4000)
  expect(tree.container.querySelector('.focused-meta-limit')?.textContent).toBe(' of 10s')
  expect(c.counts()).toEqual(counts)
})

test('quiet thinking clock changes its wording without invoking static renderers', async () => {
  const c = counters(turn([user, prose, reasoning]))
  const tree = await harness.mount(<FocusedTranscript turn={c.observed} liveState={live} renderRows={c.renderRows} renderReasoning={c.renderReasoning} />)
  const counts = c.counts()
  await tick(1000)
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking')
  await tick(2000)
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking3s')
  expect(c.counts()).toEqual(counts)
})

test('approval-only calls do not run an elapsed clock', async () => {
  const c = counters(turn([user, call]))
  const state: FocusedLiveState = { ...live, activities: { call: { type: 'tool.activity', toolUseId: 'call', phase: 'reviewing', startedAt: 10000 } }, awaitingApproval: { call: true } }
  await harness.mount(<FocusedTranscript turn={c.observed} liveState={state} renderRows={c.renderRows} renderReasoning={c.renderReasoning} />)
  expect(timers.size).toBe(0)
})

test('background retention expires without remapping segments or keeping an idle clock', async () => {
  const c = counters(turn([user, prose, { ...call, status: 'success' }]))
  const tasks = { items: [], focusedBashJobs: [{ id: 'job', toolUseId: 'call', label: 'Check', status: 'completed' as const, startTime: 5000, endTime: 10000 }] }
  // Streaming suppresses quiet thinking so this fixture measures only retention.
  const tree = await harness.mount(<FocusedTranscript turn={c.observed} liveState={{ ...live, streaming: true }} tasks={tasks} renderRows={c.renderRows} renderReasoning={c.renderReasoning} />)
  const counts = c.counts()
  expect(tree.container.querySelector('.focused-bg')?.textContent).toBe('&Checkfinished')
  await tick(3000)
  expect(tree.container.querySelector('.focused-bg')).not.toBeNull()
  await tick(1000)
  expect(tree.container.querySelector('.focused-bg')).toBeNull()
  expect(c.counts()).toEqual(counts)
  expect(timers.size).toBe(0)
})

test('an expired replacement background job stays hidden after the retention clock stops', async () => {
  const c = counters(turn([user, prose, { ...call, status: 'success' }]))
  const state = { ...live, streaming: true }
  const job = { id: 'first', toolUseId: 'call', label: 'First', status: 'completed' as const, startTime: 5000, endTime: 10000 }
  const view = (entry: typeof job) => <FocusedTranscript turn={c.observed} liveState={state} tasks={{ items: [], focusedBashJobs: [entry] }} renderRows={c.renderRows} renderReasoning={c.renderReasoning} />
  const tree = await harness.mount(view(job))
  expect(tree.container.querySelector('.focused-bg')?.textContent).toBe('&Firstfinished')
  await tick(4000)
  expect(tree.container.querySelector('.focused-bg')).toBeNull()
  expect(timers.size).toBe(0)

  now = 30000
  await tree.render(view({ ...job, id: 'replacement', label: 'Replacement', endTime: 20000 }))
  expect(tree.container.querySelector('.focused-bg')?.textContent ?? null).toBeNull()
  expect(timers.size).toBe(0)
})

test('streaming a tail rerenders only changed static segments and keeps latest and reasoning gates current', async () => {
  const speech: NestedTranscriptRow = { ...call, id: 'speech', toolUseId: 'speech', toolName: 'SendToPeer', status: 'success' }
  const tail: NestedTranscriptRow = { ...prose, id: 'tail', content: 'First tail' }
  const prefix = [user, prose, speech, reasoning]
  const rowCalls: string[] = []
  const reasoningCalls: boolean[] = []
  const renderRows = (rows: readonly NestedTranscriptRow[], narration: boolean) => {
    rowCalls.push(`${rows[0]!.id}:${narration}`)
    return <span>{rows[0]!.kind === 'assistant-text' ? rows[0]!.content : 'speech'}</span>
  }
  const renderReasoning = (_rows: readonly NestedTranscriptRow[], live: boolean) => {
    reasoningCalls.push(live)
    return <span data-test-reasoning-live={String(live)}>reasoning</span>
  }
  const view = (model: FocusedTurnItem) => <FocusedTranscript turn={model} renderRows={renderRows} renderReasoning={renderReasoning} />
  const initial = turn([...prefix, tail])
  const tree = await harness.mount(view(initial))
  expect(rowCalls).toEqual(['update:true', 'speech:false', 'tail:true'])
  expect(reasoningCalls).toEqual([false])
  rowCalls.length = 0
  reasoningCalls.length = 0

  const changed = turn([...prefix, { ...tail, content: 'Second tail' }])
  expect(changed.segments[0]).toBe(initial.segments[0])
  expect(changed.segments[1]).toBe(initial.segments[1])
  expect(changed.segments[2]).toBe(initial.segments[2])
  await tree.render(view(changed))
  expect(rowCalls).toEqual(['tail:true'])
  expect(reasoningCalls).toEqual([])
  expect(tree.container.querySelector('[data-latest]')?.textContent).toBe('Second tail')
  rowCalls.length = 0

  const next = { ...prose, id: 'next', content: 'New latest' }
  const appended = turn([...prefix, changed.rows.at(-1)!, next])
  await tree.render(view(appended))
  expect(rowCalls).toEqual(['next:true'])
  expect(tree.container.querySelectorAll('[data-latest]').length).toBe(1)
  expect(tree.container.querySelector('[data-latest]')?.textContent).toBe('New latest')
  expect(reasoningCalls).toEqual([])
  rowCalls.length = 0

  // A stable reasoning segment must still invalidate when it becomes the live tail.
  const reasoningTail = turn(prefix)
  expect(reasoningTail.segments[2]).toBe(initial.segments[2])
  await tree.render(view(reasoningTail))
  expect(rowCalls).toEqual([])
  expect(reasoningCalls).toEqual([true])
  expect(tree.container.querySelector('[data-test-reasoning-live]')?.getAttribute('data-test-reasoning-live')).toBe('true')
  expect(tree.container.querySelector('[data-latest]')?.textContent).toBe('Checking')
  await tree.render(view({ ...reasoningTail, answering: true }))
  expect(reasoningCalls).toEqual([true, false])
  await tree.render(view({ ...reasoningTail, live: false }))
  expect(reasoningCalls).toEqual([true, false])
  expect(tree.container.querySelector('[data-latest]')).toBeNull()
  expect(rowCalls).toEqual([])
})
