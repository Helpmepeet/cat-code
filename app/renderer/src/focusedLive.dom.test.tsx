import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptView } from './TranscriptView.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { createTranscriptState, projectServerFrame, selectFocusedLiveState, type TranscriptState } from './transcriptProjector.js'
import type { ServerFrame, TasksSnapshot } from '../../shared/protocol.js'

let harness: DomTestHarness
let now = 10000
let clock: ReturnType<typeof spyOn>
let intervals: Map<ReturnType<typeof setInterval>, { callback: () => void; delay: number }>
let intervalSpy: ReturnType<typeof spyOn>
let clearIntervalSpy: ReturnType<typeof spyOn>
beforeAll(async () => { harness = await createDomTestHarness() })
beforeEach(() => {
  intervals = new Map()
  let id = 0
  intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    const timer = ++id as unknown as ReturnType<typeof setInterval>
    intervals.set(timer, { callback, delay })
    return timer
  }) as typeof setInterval)
  clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(timer => {
    intervals.delete(timer as ReturnType<typeof setInterval>)
  })
})
afterEach(async () => {
  await harness.unmountAll()
  clock?.mockRestore()
  intervalSpy.mockRestore()
  clearIntervalSpy.mockRestore()
})
afterAll(async () => { await harness.teardown() })
function start() {
  now = 10000
  clock = spyOn(Date, 'now').mockImplementation(() => now)
  return message(projectServerFrame(createTranscriptState(), { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', engineSessionId: 'engine', payload: {
    type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: true, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  } }), { type: 'user', uuid: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Check it' } })
}
function message(state: TranscriptState, message: unknown) {
  return projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', event: { type: 'message', message } } as ServerFrame)
}
function calls(state: TranscriptState, ids: string[]) {
  return message(state, { type: 'assistant', uuid: `calls-${ids}`, parent_tool_use_id: null, message: { id: `msg-${ids}`, role: 'assistant', content: ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id, timeout: 120000 } })) } })
}
function activity(state: TranscriptState, id: string, phase: 'reviewing' | 'executing', extra = {}) {
  return projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', event: { type: 'tool.activity', toolUseId: id, phase, startedAt: now, ...extra } })
}
function finish(state: TranscriptState, id: string, error = false, content = 'completed output') {
  return message(state, { type: 'user', uuid: `result-${id}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] } })
}
function view(state: TranscriptState, mode: TranscriptMode = 'focused', tasks: TasksSnapshot | null = null, live = true, cwd: string | null = null) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptView state={state} activeSessionId="live" turnLive={live} focusedTasks={tasks} cwd={cwd} /></TranscriptModeContext.Provider>
}
const visibleText = (node: Element | null) => node ? [...node.querySelectorAll(':scope > *:not([aria-hidden="true"])')].map(child => child.textContent).join('') : ''
async function tick() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 270)) })
  await act(async () => { for (const timer of intervals.values()) timer.callback() })
}
async function click(element: Element | null) { expect(element).not.toBeNull(); await act(async () => { (element as HTMLElement).click() }) }

function mockVisibility(get: () => DocumentVisibilityState) {
  const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get })
  return () => {
    if (previous) Object.defineProperty(document, 'visibilityState', previous)
    else Reflect.deleteProperty(document, 'visibilityState')
  }
}

test('live clock uses one-second ticks, suspends hidden work, catches up on resume and cleans up', async () => {
  let visibility: DocumentVisibilityState = 'visible'
  const restoreVisibility = mockVisibility(() => visibility)
  const dispatchVisibility = async () => {
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  }
  try {
    const state = activity(calls(start(), ['running']), 'running', 'executing', { output: 'first', totalLines: 1 })
    const tree = await harness.mount(view(state))
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([1000])
    now += 1000
    await act(async () => { for (const timer of intervals.values()) timer.callback() })
    expect(tree.container.querySelector('.focused-meta')).toBeNull()
    now += 1000
    await act(async () => { for (const timer of intervals.values()) timer.callback() })
    expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('2s')
    expect(tree.container.querySelector('.focused-live-out')?.textContent).toBe('first1 lines')
    visibility = 'hidden'
    await dispatchVisibility()
    expect(intervals.size).toBe(0)
    now += 8000
    expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('2s')
    // Stream events are not blocked by document visibility or timer cadence.
    await tree.render(view(activity(state, 'running', 'executing', { startedAt: 10000, output: 'new output', totalLines: 2 })))
    expect(tree.container.querySelector('.focused-live-out')?.textContent).toBe('new output2 lines')
    expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('10s')
    now += 5000
    visibility = 'visible'
    await dispatchVisibility()
    expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('15s')
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([1000])
    await dispatchVisibility()
    expect(intervals.size).toBe(1)
    await tree.render(view(state, 'focused', null, false))
    expect(intervals.size).toBe(0)
    await dispatchVisibility()
    expect(intervals.size).toBe(0)
    await tree.render(view(state))
    expect(intervals.size).toBe(1)
    await tree.unmount()
    expect(intervals.size).toBe(0)
    await dispatchVisibility()
    expect(intervals.size).toBe(0)
  } finally {
    restoreVisibility()
  }
})

test('a turn mounted hidden starts its clock only when visible', async () => {
  let visibility: DocumentVisibilityState = 'hidden'
  const restoreVisibility = mockVisibility(() => visibility)
  try {
    const tree = await harness.mount(view(start()))
    expect(intervals.size).toBe(0)
    now += 3000
    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(visibleText(tree.container.querySelector('.focused-thinking .focused-ticker'))).toBe('Thinking it over')
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([1000])
  } finally {
    restoreVisibility()
  }
})

test('rolling work keeps the first running command ahead of later queued calls and counts only finished calls', async () => {
  let state = activity(calls(start(), ['test-first', 'done', 'queued-a', 'queued-b', 'queued-c']), 'test-first', 'executing')
  state = finish(state, 'done')
  const tree = await harness.mount(view(state))
  const head = tree.container.querySelector('.focused-step-head')!
  expect(visibleText(head)).toContain('Ran 1 command')
  const lines = [...tree.container.querySelectorAll('.focused-call-row')].map(row => row.textContent)
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('Running test-first')
  expect(lines[1]).toContain('Ran done')
  expect(lines[2]).toContain('Queued queued-a')
  state = message(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'next-command' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'preparing-command', name: 'Bash', input: {} } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"prepared-command' } } })
  await tree.render(view(state))
  await tick()
  const withPreparing = [...tree.container.querySelectorAll('.focused-call:not([aria-hidden="true"]) .focused-call-row')].map(row => row.textContent)
  expect(withPreparing).toHaveLength(3)
  expect(withPreparing[0]).toContain('Running test-first')
  expect(withPreparing[1]).toContain('Ran done')
  expect(withPreparing[2]).toContain('Preparing prepared-command')
  await click(head)
  expect(visibleText(head)).toContain('Ran 1 command')
  expect(tree.container.querySelector('.focused-step-body [data-tool-row]')).not.toBeNull()
  expect(tree.container.querySelector('.focused-call:not([aria-hidden="true"])')).toBeNull()
  await tick()
  expect(tree.container.querySelector('.focused-call')).toBeNull()
})

test('review clocks restart for execution, survive remount, and gate raw output and the timeout limit', async () => {
  let state = calls(start(), ['test-first', 'queued'])
  let tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Queued test-first')
  expect(tree.container.querySelector('.focused-step-head')?.hasAttribute('data-running')).toBe(false)
  expect(tree.container.querySelector('.focused-call-row .focused-live-verb')).toBeNull()
  await tree.unmount()
  state = activity(state, 'test-first', 'reviewing')
  now = 40000
  tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Reviewing test-first30s')
  expect(tree.container.querySelector('.focused-call-row')?.textContent).toContain('Queued queued')
  expect(tree.container.querySelector('.focused-live-out')).toBeNull()
  state = activity(state, 'test-first', 'executing', { output: 'noise\n<div>raw DOM</div>\n', totalLines: 412000, timeoutMs: 120000 })
  await tree.unmount()
  tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Running test-first')
  expect(tree.container.querySelector('.focused-meta')).toBeNull()
  expect(tree.container.querySelector('.focused-live-out')).toBeNull()
  now = 41500
  await tick()
  expect(tree.container.querySelector('.focused-live-out')?.textContent).toBe('<div>raw DOM</div>412k lines')
  now = 105000
  await tree.unmount()
  tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head .focused-meta')?.textContent).toBe('1m 5s of 2m')
  await tree.render(view(finish(state, 'test-first')))
  expect(tree.container.querySelector('.focused-head-out')).toBeNull()
})

test('preparing arguments grow as streaming state and the real call replaces them without a duplicate', async () => {
  let state = start()
  const stream = (event: unknown) => { state = message(state, { type: 'stream_event', event, parent_tool_use_id: null }) }
  stream({ type: 'message_start', message: { id: 'forming' } })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'patch', name: 'apply_patch', input: '' } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '*** Begin Patch\n*** Add File: src/new.ts\n+one' } })
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Preparing src/new.ts +1')
  expect(tree.container.querySelector('.focused-caret')).not.toBeNull()
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '\n+two\n*** End Patch' } })
  await tree.render(view(state))
  expect(visibleText(tree.container.querySelector('.focused-step-head'))).toContain('+2')
  state = message(state, { type: 'assistant', uuid: 'patch-real', parent_tool_use_id: null, message: { id: 'forming', role: 'assistant', content: [{ type: 'tool_use', id: 'patch', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: src/new.ts\n+one\n+two\n*** End Patch' } }] } })
  expect(Object.values(selectFocusedLiveState(state, 'live')!.preparing)).toHaveLength(0)
  await tree.render(view(state))
  expect(tree.container.querySelectorAll('.focused-step')).toHaveLength(1)
  expect(tree.container.querySelector('.focused-caret')).toBeNull()
})

test('streamed tool targets update in place in both the head and rolling calls', async () => {
  for (const rolling of [false, true]) {
    for (const [name, field, chunks] of [
      ['Bash', 'command', ['bun ', 'test ', 'src/loader']],
      ['Read', 'file_path', ['/Users/pt/', 'cat-code/app/', 'renderer/src/proseArrival.ts']],
      ['Grep', 'pattern', ['smooth', '|arrival', '|scroll']],
      ['Edit', 'new_string', ['one', '\\ntwo', '\\nthree']],
    ] as const) {
      let state = rolling ? finish(calls(start(), ['done']), 'done') : start()
      const stream = (event: unknown) => { state = message(state, { type: 'stream_event', event }) }
      stream({ type: 'message_start', message: { id: 'forming-target' } })
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'forming-call', name, input: {} } })
      const prefix = name === 'Edit' ? '{"file_path":"/repo/file.ts",' : '{'
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `${prefix}"${field}":"${chunks[0]}` } })
      const tree = await harness.mount(view(state))
      const selector = rolling ? '.focused-call-row .focused-ticker:has(.focused-caret)' : '.focused-step-text'
      const ticker = tree.container.querySelector(selector)!
      expect(ticker).not.toBeNull()
      const line = ticker.querySelector(':scope > span:not([aria-hidden="true"])')!
      const before = line.textContent
      for (const chunk of chunks.slice(1)) {
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: chunk } })
        await tree.render(view(state))
        expect(tree.container.querySelector(selector)).toBe(ticker)
        expect(ticker.querySelector(':scope > span:not([aria-hidden="true"])')).toBe(line)
        expect(ticker.querySelector('.focused-tick-in, .focused-tick-out')).toBeNull()
      }
      expect(line.textContent).not.toBe(before)
      if (name === 'Edit') expect(line.textContent).toContain('+3')
      else expect(line.textContent).toContain(chunks.join(''))
      await tree.unmount()
    }
  }
})

test('streaming output updates in place without sliding each output batch upward', async () => {
  for (const rolling of [false, true]) {
    let state = calls(start(), rolling ? ['done', 'running'] : ['running'])
    if (rolling) state = finish(state, 'done')
    state = activity(state, 'running', 'executing', { output: 'first line\n', totalLines: 1 })
    now += 2000
    const tree = await harness.mount(view(state))
    const ticker = tree.container.querySelector('.focused-live-out .focused-ticker')!
    expect(visibleText(ticker)).toBe('first line')
    const line = ticker.firstElementChild
    for (const [output, totalLines] of [['first line grows', 1], ['second line', 2], ['third line', 3]] as const) {
      state = activity(state, 'running', 'executing', { startedAt: 10000, output, totalLines })
      await tree.render(view(state))
      expect(tree.container.querySelector('.focused-live-out .focused-ticker')).toBe(ticker)
      expect(ticker.firstElementChild).toBe(line)
      expect(visibleText(ticker)).toBe(output)
      expect(ticker.querySelector('.focused-tick-in, .focused-tick-out')).toBeNull()
      expect(tree.container.querySelector('.focused-live-count')?.textContent).toBe(`${totalLines} lines`)
    }
    await tree.unmount()
  }
})

test('the first wait follows the phrase ladder without seconds and slides whole phrases', async () => {
  const state = start()
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  now = 10999
  await tick()
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  let previous: string | null = null
  for (const [elapsed, phrase] of [
    [1000, 'Reading your message'], [2999, 'Reading your message'],
    [3000, 'Thinking it over'], [6999, 'Thinking it over'],
    [7000, 'Weighing it up'], [11999, 'Weighing it up'],
    [12000, 'Thinking it through'], [60000, 'Thinking it through'],
  ] as const) {
    now = 10000 + elapsed
    await tick()
    const row = tree.container.querySelector('.focused-thinking')!
    expect(row).not.toBeNull()
    if (!previous) expect(row.querySelector('.focused-live-verb')?.textContent).toBe(phrase)
    expect(row.querySelector('.focused-meta')).toBeNull()
    expect(row.querySelector('.focused-reasoning-node')).not.toBeNull()
    const ticker = row.querySelector('.focused-ticker')!
    expect(visibleText(ticker)).toBe(phrase)
    expect(ticker.querySelector(':scope > span:not([aria-hidden="true"]) > .focused-live-verb')?.textContent).toBe(phrase)
    if (previous && phrase !== previous) {
      expect(ticker.querySelector('.focused-tick-out[aria-hidden="true"]')?.textContent).toBe(previous)
      expect(ticker.querySelector('.focused-tick-in')?.textContent).toBe(phrase)
    }
    previous = phrase
  }
})

test('hidden context and empty or redacted reasoning keep the first wait on the turn quiet clock', async () => {
  let state = start()
  now = 12000
  state = projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', event: { type: 'turn.status', activeTurn: true } })
  now = 12500
  state = message(state, { type: 'user', uuid: 'hidden-first', isSynthetic: true, parent_tool_use_id: null, message: { role: 'user', content: 'Hidden internal context' } })
  state = message(state, { type: 'assistant', uuid: 'redacted-first', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] } })
  state = message(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'empty-first' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } })
  expect(selectFocusedLiveState(state, 'live')!.lastVisibleChangeAt).toBe(12000)
  now = 12999
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  now = 13000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Reading your message')
  expect(tree.container.querySelector('.focused-thinking .focused-meta')).toBeNull()
  now = 15000
  await tick()
  expect(visibleText(tree.container.querySelector('.focused-thinking .focused-ticker'))).toBe('Thinking it over')
})

test('a later quiet gap after a finished call keeps Thinking and seconds, even after remount', async () => {
  let state = start()
  let tree = await harness.mount(view(state))
  now = 11000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Reading your message')
  now = 12000
  state = calls(state, ['first-output'])
  await tree.render(view(state))
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  now = 13000
  state = finish(state, 'first-output')
  await tree.render(view(state))
  now = 13999
  await tick()
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  now = 14000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking')
  now = 15000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking2s')
  await tree.unmount()
  tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking2s')
})

test('a Preparing call ends the first wait even if a replacement stream abandons it', async () => {
  let state = start()
  const tree = await harness.mount(view(state))
  state = message(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'preparing-first' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'abandoned-first', name: 'Bash', input: {} } } })
  await tree.render(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Preparing')
  state = message(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'replacement-first' } } })
  await tree.render(view(state))
  now = 13000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking3s')
})

test('empty reasoning does not reset the quiet clock; text streaming and final answers hide Thinking', async () => {
  let state = finish(calls(start(), ['check']), 'check')
  now = 10999
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
  now = 11000
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking')
  now = 12500
  state = message(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'empty' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } })
  state = message(state, { type: 'user', uuid: 'hidden', isSynthetic: true, parent_tool_use_id: null, message: { role: 'user', content: 'Hidden internal context' } })
  await tree.render(view(state))
  await tick()
  expect(tree.container.querySelector('.focused-thinking')?.textContent).toBe('Thinking2s')
  state = message(state, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', phase: 'final_answer' } } })
  state = message(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Fixed.' } } })
  await tree.render(view(state))
  expect(tree.container.querySelector('.focused-thinking')).toBeNull()
})

test('background jobs use engine time and retire four seconds after finishing', async () => {
  const state = activity(finish(calls(start(), ['background']), 'background'), 'background', 'executing')
  const tasks: TasksSnapshot = { items: [], focusedBashJobs: [{ id: 'job', toolUseId: 'background', label: 'Run the test suite', status: 'running', startTime: 10000 }] }
  now = 75000
  const tree = await harness.mount(view(state, 'focused', tasks))
  expect(tree.container.querySelector('.focused-bg')?.textContent).toBe('&Run the test suite1m 5s')
  const done = { items: [], focusedBashJobs: [{ ...tasks.focusedBashJobs![0]!, status: 'failed' as const, endTime: now }] }
  await tree.render(view(state, 'focused', done))
  expect(tree.container.querySelector('.focused-bg .focused-meta-fail')?.textContent).toBe('failed')
  now += 4100
  await tick()
  expect(tree.container.querySelector('.focused-bg')).toBeNull()
})

test('opened Focused steps keep successful Bash quiet and failures collapsed with their tail; Full keeps its peek', async () => {
  let state = finish(calls(start(), ['success', 'failure']), 'success', false, 'successful tail')
  state = finish(state, 'failure', true, 'failing tail')
  const tree = await harness.mount(view(state))
  await click(tree.container.querySelector('.focused-step-head'))
  const cards = [...tree.container.querySelectorAll('[data-tool-row]')]
  expect(cards[0]?.textContent).not.toContain('successful tail')
  expect(cards[1]?.textContent).toContain('failing tail')
  expect(cards[1]?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  await tree.render(view(state, 'full'))
  expect(tree.container.textContent).toContain('successful tail')
  expect(tree.container.querySelector('.focused-turn')).toBeNull()
})

test('an undelivered peer message splits the stretch and contributes no failure or call count', async () => {
  let state = finish(calls(start(), ['before']), 'before')
  state = message(state, { type: 'assistant', uuid: 'peer', parent_tool_use_id: null, message: { id: 'peer-msg', role: 'assistant', content: [{ type: 'tool_use', id: 'speech', name: 'SendToPeer', input: { to: 'Bellows', text: 'Check the boundary' } }] } })
  state = finish(state, 'speech', false, JSON.stringify({ delivery: 'not_delivered', outcome: 'blocked_by_user', summary: 'Could not deliver' }))
  state = finish(calls(state, ['after']), 'after')
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelectorAll('.focused-step')).toHaveLength(2)
  expect(tree.container.querySelector('.focused-lifted-speech')?.textContent).toContain('Bellows')
  expect(tree.container.querySelector('.focused-lifted-speech')?.textContent).toContain('not delivered')
  expect(tree.container.querySelector('.focused-lifted-speech')?.textContent).toContain('Check the boundary')
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('ran 2')
  expect(tree.container.querySelector('.focused-fail-note')).toBeNull()
})

test('a failed call inside a read run reveals its tail without opening its full output', async () => {
  let state = start()
  state = message(state, { type: 'assistant', uuid: 'reads', parent_tool_use_id: null, message: { id: 'reads', role: 'assistant', content: [
    { type: 'tool_use', id: 'read-a', name: 'Read', input: { file_path: '/repo/a.ts' } },
    { type: 'tool_use', id: 'read-b', name: 'Read', input: { file_path: '/repo/b.ts' } },
  ] } })
  state = finish(finish(state, 'read-a'), 'read-b', true, 'Cannot read the file')
  const tree = await harness.mount(view(state))
  await click(tree.container.querySelector('.focused-step-head'))
  const member = [...tree.container.querySelectorAll('.focused-step-body button')].find(button => button.textContent?.includes('b.ts'))
  expect(member?.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.querySelector('.focused-step-body')?.textContent).toContain('Cannot read the file')
})

test('a specialized failed tool keeps the same collapsed error window', async () => {
  let state = start()
  state = message(state, { type: 'assistant', uuid: 'search', parent_tool_use_id: null, message: { id: 'search', role: 'assistant', content: [
    { type: 'tool_use', id: 'search-tool', name: 'ToolSearch', input: { query: 'select:Read' } },
  ] } })
  state = finish(state, 'search-tool', true, 'Cannot load the tool\nTry again')
  const tree = await harness.mount(view(state))
  await click(tree.container.querySelector('.focused-step-head'))
  const card = tree.container.querySelector('[data-tool-row]')!
  expect(card.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  expect(card.textContent).toContain('Cannot load the tool')
  expect(card.textContent).toContain('Try again')
})


test('a replacement stream retires abandoned Preparing calls and manual approval ends Auto review timing', async () => {
  let state = start()
  const stream = (event: unknown) => { state = message(state, { type: 'stream_event', event }) }
  stream({ type: 'message_start', message: { id: 'abandoned' } })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'abandoned-call', name: 'Bash', input: {} } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"never issued' } })
  stream({ type: 'message_start', message: { id: 'retry' } })
  expect(Object.values(selectFocusedLiveState(state, 'live')!.preparing)).toHaveLength(0)
  state = activity(calls(state, ['manual']), 'manual', 'reviewing')
  now += 30000
  state = projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', event: { type: 'permission.requested', request: {
    requestId: 'manual-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'manual', input: { command: 'manual' } },
  } } })
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Waiting for approval manual')
  expect(tree.container.querySelector('.focused-step-head .focused-warn-verb')?.textContent).toBe('Waiting for approval')
  expect(tree.container.querySelector('.focused-step-head')?.hasAttribute('data-running')).toBe(false)
  expect(tree.container.querySelector('.focused-step-head .focused-meta')).toBeNull()
  expect(tree.container.querySelector('.focused-step-head')?.textContent).not.toContain('Reviewing')
})


type Call = { id: string; name: string; input: Record<string, unknown> }
let sequence = 0
function toolCalls(state: TranscriptState, list: Call[], parent: string | null = null) {
  sequence++
  return message(state, { type: 'assistant', uuid: `tc-${sequence}`, parent_tool_use_id: parent, message: { id: `tcm-${sequence}`, role: 'assistant', content: list.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })) } })
}
function answer(state: TranscriptState, id: string, content: string, options: { error?: boolean; result?: unknown; status?: string; parent?: string | null } = {}) {
  sequence++
  return message(state, { type: 'user', uuid: `tr-${sequence}`, parent_tool_use_id: options.parent ?? null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: options.error ?? false }] },
    ...(options.result ? { tool_use_result: options.result } : {}), ...(options.status ? { tool_result_status: options.status } : {}) })
}
function endTurn(state: TranscriptState, answerText: string | null, isError = false) {
  sequence++
  if (answerText) state = message(state, { type: 'assistant', uuid: `at-${sequence}`, parent_tool_use_id: null, message: { id: `atm-${sequence}`, role: 'assistant', content: [{ type: 'text', text: answerText }] } })
  return message(state, { type: 'result', uuid: `rs-${sequence}`, subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: 5000, result: answerText ?? '', errors: isError ? ['Turn stopped'] : [] })
}
const approval = (state: TranscriptState, id: string) => projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live',
  event: { type: 'permission.requested', request: { requestId: `ask-${id}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: id, input: {} } } } } as ServerFrame)
async function openTurn(tree: { container: HTMLElement }) {
  const head = tree.container.querySelector('.focused-fold-head')!
  if (head.getAttribute('aria-expanded') === 'false') await click(head)
  await act(async () => { await harness.nextFrame() })
}
const read = (id: string, file = '/repo/app/x.ts'): Call => ({ id, name: 'Read', input: { file_path: file } })
const bashCall = (id: string, command: string, extra: Record<string, unknown> = {}): Call => ({ id, name: 'Bash', input: { command, ...extra } })
const stepHead = (tree: { container: HTMLElement }) => tree.container.querySelector('.focused-step-head')!
const foldHead = (tree: { container: HTMLElement }) => tree.container.querySelector('.focused-fold-head')!

test('paths read relative to the project and a finished single call is not repeated by the rolling rows', async () => {
  const running = activity(toolCalls(start(), [read('r1')]), 'r1', 'executing')
  let tree = await harness.mount(view(running, 'focused', null, true, '/repo'))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Reading app/x.ts')
  expect(tree.container.querySelector('.focused-step-text .focused-step-target')?.textContent).toBe('app/x.ts')
  await tree.render(view(answer(running, 'r1', 'text'), 'focused', null, true, '/repo'))
  await tick()
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Read app/x.ts')
  expect(tree.container.querySelectorAll('.focused-call:not([aria-hidden="true"])')).toHaveLength(0)
  await tree.render(view(running, 'focused', null, true, null))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Reading /repo/app/x.ts')
})

test('a turn stopped mid-call names it with the project-relative path', async () => {
  const state = endTurn(toolCalls(start(), [read('r1')]), null, true)
  const tree = await harness.mount(view(state, 'focused', null, false, '/repo'))
  await openTurn(tree)
  expect(stepHead(tree).textContent).toContain('Stopped app/x.ts')
})

test('an apply_patch in flight is named by its file', async () => {
  const patch = '*** Begin Patch\n*** Update File: app/y.ts\n@@\n-old\n+new\n*** End Patch'
  const state = activity(toolCalls(start(), [{ id: 'p1', name: 'apply_patch', input: { input: patch } }]), 'p1', 'executing')
  const tree = await harness.mount(view(state, 'focused', null, true, '/repo'))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Editing app/y.ts')
})

test('a running agent shows its latest three calls, and a child that has not reported activity reads as running', async () => {
  let state = activity(toolCalls(start(), [{ id: 'agent', name: 'Agent', input: { description: 'Fix shell output', prompt: 'Fix it', subagent_type: 'implementor' } }]), 'agent', 'executing')
  state = toolCalls(state, [bashCall('c0', 'bun run old')], 'agent')
  state = answer(state, 'c0', 'ok', { parent: 'agent' })
  state = toolCalls(state, [bashCall('c1', 'bun test src/shell')], 'agent')
  state = answer(state, 'c1', '3 fail', { error: true, parent: 'agent' })
  state = toolCalls(state, [read('c2', '/repo/src/shell.ts'), { id: 'c3', name: 'SendToPeer', input: { to: 'Ada', text: 'hi' } }], 'agent')
  const tree = await harness.mount(view(state, 'focused', null, true, '/repo'))
  await tick()
  const rows = [...tree.container.querySelectorAll('.focused-call:not([aria-hidden="true"]) .focused-call-row')]
  expect(rows.map(row => row.querySelector('.focused-ticker')?.textContent)).toEqual(['Ran bun run old', 'Ran bun test src/shell', 'Reading src/shell.ts'])
  expect(rows[1]!.querySelector('.focused-meta-fail')?.textContent).toBe('failed')
  expect(rows[2]!.textContent).not.toContain('Queued')
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toContain('Delegating')
  await click(stepHead(tree))
  await tick()
  expect(tree.container.querySelectorAll('.focused-call:not([aria-hidden="true"])')).toHaveLength(0)
})

test('web, skill and MCP calls carry their family mark and colour', async () => {
  for (const [call, mark, colour] of [
    [{ id: 'w', name: 'WebFetch', input: { url: 'https://bun.sh/docs', prompt: 'x' } }, '↗', 'text-[light-dark(#0e7490,#22d3ee)]'],
    [{ id: 's', name: 'Skill', input: { skill: 'design-html' } }, '§', 'text-[light-dark(#0f766e,#5eead4)]'],
    [{ id: 'm', name: 'mcp__cua-driver__click', input: { element_index: 3 } }, '⧉', 'text-[light-dark(#7c3aed,#c084fc)]'],
  ] as const) {
    const tree = await harness.mount(view(answer(toolCalls(start(), [call]), call.id, 'ok')))
    const glyph = tree.container.querySelector('.focused-step-mark')!
    expect(glyph.textContent).toBe(mark)
    expect(glyph.className).toContain(colour)
    await tree.unmount()
  }
})

test('SendMessage and ToolSearch read as their own sentences', async () => {
  const state = answer(toolCalls(start(), [{ id: 'sm', name: 'SendMessage', input: { to: '@Shamir', summary: 'Transport confirmed', message: 'ok' } }]), 'sm', 'queued')
  let tree = await harness.mount(view(state, 'focused', null, false))
  await openTurn(tree)
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Messaged Shamir · Transport confirmed')
  await tree.unmount()
  const search = answer(toolCalls(start(), [{ id: 'ts', name: 'ToolSearch', input: { query: 'select:TaskOutput' } }]), 'ts', '', { result: { matches: ['TaskOutput'], query: 'select:TaskOutput', total_deferred_tools: 3 } })
  tree = await harness.mount(view(endTurn(search, null), 'focused', null, false))
  await openTurn(tree)
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Loaded TaskOutput')
  expect(tree.container.querySelector('.focused-step-mark')?.textContent).toBe('⌕')
})

test('a call waiting for approval is warned, not shimmered', async () => {
  const tree = await harness.mount(view(approval(toolCalls(start(), [bashCall('b', 'git push')]), 'b')))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Waiting for approval git push')
  expect(tree.container.querySelector('.focused-step-text .focused-warn-verb')?.textContent).toBe('Waiting for approval')
  expect(stepHead(tree).hasAttribute('data-running')).toBe(false)
})

test('a background command stays marked after it returns and follows its job', async () => {
  const launched = answer(toolCalls(start(), [bashCall('b', 'bun run dev', { run_in_background: true })]), 'b', 'Command running in background with ID: job')
  const job = (status: 'running' | 'failed' | 'killed') => ({ items: [], focusedBashJobs: [{ id: 'job', toolUseId: 'b', label: 'bun run dev', status, startTime: 10000, ...(status === 'running' ? {} : { endTime: now }) }] }) as TasksSnapshot
  const tree = await harness.mount(view(launched, 'focused', job('running')))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Ran bun run dev')
  expect(stepHead(tree).querySelector('.focused-meta-word')?.textContent).toBe('in background')
  await tree.render(view(launched, 'focused', job('killed')))
  expect(stepHead(tree).querySelector('.focused-meta-warn')?.textContent).toBe('stopped')
  await tree.render(view(launched, 'focused', job('failed')))
  expect(stepHead(tree).querySelector('.focused-meta-fail')?.textContent).toBe('failed')
  expect(stepHead(tree).querySelector('.focused-meta-word')).toBeNull()
})

test('a background agent is in the background until its notification says it failed', async () => {
  const input = { description: 'Mine transcripts', prompt: 'Research', subagent_type: 'general-purpose', run_in_background: true }
  let state = answer(toolCalls(start(), [{ id: 'ag', name: 'Agent', input }]), 'ag', 'Async agent launched successfully.\nagentName: Moggridge', { result: { status: 'async_launched', agentId: 'a9bc', agentName: 'Moggridge' } })
  let tree = await harness.mount(view(state))
  expect(stepHead(tree).querySelector('.focused-meta-word')?.textContent).toBe('in background')
  await tree.unmount()
  sequence++
  state = message(state, { type: 'user', uuid: `tn-${sequence}`, parent_tool_use_id: null, origin: { kind: 'task-notification', status: 'failed', toolUseId: 'ag', summary: 'Agent failed', result: 'Blocked.' }, message: { role: 'user', content: '<task-notification>failed</task-notification>' } })
  state = endTurn(state, 'It was blocked.')
  tree = await harness.mount(view(state, 'focused', null, false))
  expect(foldHead(tree).querySelector('.focused-fail-note')?.textContent).toBe('1 failed')
  await openTurn(tree)
  expect(stepHead(tree).querySelector('.focused-meta-fail')?.textContent).toBe('failed')
  expect(stepHead(tree).querySelector('.focused-fail-note')).toBeNull()
  expect(stepHead(tree).querySelector('.focused-meta-word')).toBeNull()
})

test('a cancelled call is stopped, not failed', async () => {
  const state = endTurn(answer(toolCalls(start(), [bashCall('b', 'bun test')]), 'b', '[Request interrupted by user]', { error: true, status: 'cancelled' }), null, true)
  const tree = await harness.mount(view(state, 'focused', null, false))
  await openTurn(tree)
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Stopped bun test')
  expect(foldHead(tree).querySelector('.focused-warn-note')?.textContent).toBe('1 stopped')
  expect(foldHead(tree).querySelector('.focused-fail-note')).toBeNull()
  expect(foldHead(tree).querySelector('.focused-status-dot')).toBeNull()
  expect(stepHead(tree).querySelector('.focused-warn-note, .focused-fail-note')).toBeNull()
})

test('a call auto mode refused is blocked, not failed', async () => {
  let state = toolCalls(start(), [bashCall('b', 'rm -rf dist')])
  state = projectServerFrame(state, { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live',
    event: { type: 'tool.review', toolUseId: 'b', attemptId: 'att', startedAt: now - 1000, completedAt: now, outcome: 'blocked', reason: 'Deletes build output' } } as ServerFrame)
  state = endTurn(answer(state, 'b', 'Permission for this action has been denied.', { error: true }), 'Skipped it.')
  const tree = await harness.mount(view(state, 'focused', null, false))
  expect(foldHead(tree).querySelector('.focused-fail-note')?.textContent).toBe('1 blocked')
  await openTurn(tree)
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Blocked rm -rf dist')
  expect(stepHead(tree).querySelector('.focused-fail-note, .focused-meta-fail')).toBeNull()
  expect(stepHead(tree).querySelector('.auto-mode-review')).not.toBeNull()
})

test('AskUserQuestion waits quietly and keeps the answer attached to its original step', async () => {
  const questions = [{ question: 'Can I read the transcripts?', header: 'Transcripts', options: [{ label: 'Yes', description: 'a' }, { label: 'No', description: 'b' }], multiSelect: false }]
  const asked = toolCalls(start(), [{ id: 'aq', name: 'AskUserQuestion', input: { questions } }])
  let tree = await harness.mount(view(asked))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Waiting for your answer Can I read the transcripts?')
  expect(tree.container.querySelector('.focused-step-text .focused-queued-verb')?.textContent).toBe('Waiting for your answer')
  expect(stepHead(tree).hasAttribute('data-running')).toBe(false)
  await tree.unmount()
  const answered = endTurn(answer(asked, 'aq', 'User has answered your questions: "Can I read the transcripts?"="Yes".', { result: { questions, answers: { 'Can I read the transcripts?': 'Yes' } } }), 'Reading them.')
  tree = await harness.mount(view(answered, 'focused', null, false))
  await openTurn(tree)
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Asked Can I read the transcripts? · Yes')
  expect(tree.container.querySelector('.focused-deliverables') === null).toBe(true)
  expect(tree.container.querySelector('.focused-turn [data-tool-row]')).toBeNull()
  await click(stepHead(tree))
  expect(tree.container.querySelector('.focused-step-body')?.textContent).toContain('Can I read the transcripts?Yes')
  expect(tree.container.querySelector('.focused-turn [data-tool-row]') !== null).toBe(true)
})

test('a blocking question waits on the answer, not on an approval', async () => {
  const questions = [{ question: 'Which port?', header: 'Port', options: [{ label: '1', description: 'a' }, { label: '2', description: 'b' }], multiSelect: false }]
  const state = approval(toolCalls(start(), [{ id: 'q', name: 'AskUserQuestion', input: { questions } }]), 'q')
  const tree = await harness.mount(view(state))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Waiting for your answer Which port?')
  expect(stepHead(tree).querySelector('.focused-warn-verb')).toBeNull()
  expect(stepHead(tree).hasAttribute('data-running')).toBe(false)
})

test('the call waiting for approval stays in view among many parallel calls', async () => {
  const ids = ['c1', 'c2', 'c3', 'c4', 'push']
  const state = approval(toolCalls(start(), ids.map(id => bashCall(id, id))), 'push')
  const tree = await harness.mount(view(state))
  expect(visibleText(tree.container.querySelector('.focused-step-text'))).toBe('Waiting for approval push')
})

test('an agent that is not the head call still says what it is doing', async () => {
  let state = toolCalls(start(), [read('r'), { id: 'ag', name: 'Agent', input: { description: 'Fix the loader', prompt: 'Fix' } }])
  state = answer(state, 'r', 'contents')
  state = toolCalls(state, [bashCall('c1', 'bun test src/a'), read('c2', '/repo/src/shell.ts')], 'ag')
  const tree = await harness.mount(view(state, 'focused', null, true, '/repo'))
  const agentRow = [...tree.container.querySelectorAll('.focused-call:not([aria-hidden="true"])')].find(row => row.textContent?.includes('Fix the loader'))
  expect(agentRow?.querySelector('.focused-live-out')?.textContent).toBe('Reading src/shell.ts2 calls')
})

test('a killed background job reads stopped on its job row, as on its step', async () => {
  const launched = answer(toolCalls(start(), [bashCall('b', 'bun run dev', { run_in_background: true })]), 'b', 'Command running in background with ID: job')
  const tasks: TasksSnapshot = { items: [], focusedBashJobs: [{ id: 'job', toolUseId: 'b', label: 'bun run dev', status: 'killed', startTime: now - 5000, endTime: now - 1000 }] }
  const tree = await harness.mount(view(launched, 'focused', tasks))
  expect(tree.container.querySelector('.focused-bg .focused-meta')?.textContent).toBe('stopped')
  expect(stepHead(tree).querySelector('.focused-meta-warn')?.textContent).toBe('stopped')
})
