import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptView } from './TranscriptView.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { createTranscriptState, projectServerFrame, selectFocusedLiveState, type TranscriptState } from './transcriptProjector.js'
import type { ServerFrame, TasksSnapshot } from '../../shared/protocol.js'

let harness: DomTestHarness
let now = 10000
let clock: ReturnType<typeof spyOn>
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); clock?.mockRestore() })
afterAll(async () => { await harness.teardown() })
function start() {
  now = 10000
  clock = spyOn(Date, 'now').mockImplementation(() => now)
  return message(projectServerFrame(createTranscriptState(), { kind: 'ready', protocolVersion: 4, sessionId: 'live', engineSessionId: 'engine', payload: {
    type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: true, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  } }), { type: 'user', uuid: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Check it' } })
}
function message(state: TranscriptState, message: unknown) {
  return projectServerFrame(state, { kind: 'event', protocolVersion: 4, sessionId: 'live', event: { type: 'message', message } } as ServerFrame)
}
function calls(state: TranscriptState, ids: string[]) {
  return message(state, { type: 'assistant', uuid: `calls-${ids}`, parent_tool_use_id: null, message: { id: `msg-${ids}`, role: 'assistant', content: ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id, timeout: 120000 } })) } })
}
function activity(state: TranscriptState, id: string, phase: 'reviewing' | 'executing', extra = {}) {
  return projectServerFrame(state, { kind: 'event', protocolVersion: 4, sessionId: 'live', event: { type: 'tool.activity', toolUseId: id, phase, startedAt: now, ...extra } })
}
function finish(state: TranscriptState, id: string, error = false, content = 'completed output') {
  return message(state, { type: 'user', uuid: `result-${id}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] } })
}
function view(state: TranscriptState, mode: TranscriptMode = 'focused', tasks: TasksSnapshot | null = null, live = true) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptView state={state} activeSessionId="live" turnLive={live} focusedTasks={tasks} /></TranscriptModeContext.Provider>
}
const visibleText = (node: Element | null) => node ? [...node.querySelectorAll(':scope > *:not([aria-hidden="true"])')].map(child => child.textContent).join('') : ''
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 270)) }) }
async function click(element: Element | null) { expect(element).not.toBeNull(); await act(async () => { (element as HTMLElement).click() }) }

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
  state = projectServerFrame(state, { kind: 'event', protocolVersion: 4, sessionId: 'live', event: { type: 'turn.status', activeTurn: true } })
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
  state = projectServerFrame(state, { kind: 'event', protocolVersion: 4, sessionId: 'live', event: { type: 'permission.requested', request: {
    requestId: 'manual-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'manual', input: { command: 'manual' } },
  } } })
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Running manual')
  expect(tree.container.querySelector('.focused-step-head .focused-meta')).toBeNull()
  expect(tree.container.querySelector('.focused-step-head')?.textContent).not.toContain('Reviewing')
})
