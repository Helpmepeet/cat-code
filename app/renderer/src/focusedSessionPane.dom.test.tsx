import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { FOCUSED_PREVIOUS_OUTPUT_PEEK_PX } from './focusedTranscriptScroll.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows, type TranscriptState } from './transcriptProjector.js'
import { readTranscriptRowOffset } from './transcriptRowNavigation.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
let serial = 0
function project(content: unknown[], prior?: TranscriptState, options: { replay?: boolean; stopReason?: string; messageId?: string } = {}) {
  const sessionId = 'session-1'
  let state = prior ?? projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: 4, sessionId, engineSessionId: 'engine-1', payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  } as never)
  const id = ++serial
  const event = (message: unknown) => ({ kind: 'event', protocolVersion: 4, sessionId, replay: options.replay, event: { type: 'message', message } }) as never
  if (!prior) state = projectServerFrame(state, event({ type: 'user', uuid: `user-${id}`, session_id: 'engine-1', parent_tool_use_id: null, message: { role: 'user', content: 'Check the loader' } }))
  return projectServerFrame(state, event({ type: 'assistant', uuid: `assistant-${id}`, session_id: 'engine-1', parent_tool_use_id: null, message: {
    id: options.messageId ?? `message-${id}`, role: 'assistant', type: 'message', model: 'gpt-6.1-sol', stop_reason: options.stopReason ?? null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, service_tier: null }, content,
  } }))
}
function pane(state: TranscriptState, mode: TranscriptMode) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}>
    <SessionPane {...idleSessionPaneProps()} transcript={state} activeConnection={{ status: 'ready', inputEnabled: false }} turnStartedAt={Date.now()} />
  </TranscriptModeContext.Provider>
}

test('Focused pane installs its scroll owner and removes its reserved spacer when switched to Full', async () => {
  const state = project([{ type: 'thinking', thinking: 'Checking the module graph', reasoningKind: 'summary' }])
  expect(selectNestedTranscriptRows(state, 'session-1').map(row => row.kind)).toEqual(['user-text', 'thinking'])
  const tree = await harness.mount(pane(state, 'focused'))
  const spacer = tree.container.querySelector('.focused-transcript-space')
  expect(spacer).not.toBeNull()
  expect(spacer?.getAttribute('aria-hidden')).toBe('true')
  expect(spacer?.parentElement?.tabIndex).toBe(0)
  await tree.render(pane(state, 'full'))
  expect(tree.container.querySelector('.focused-transcript-space')).toBeNull()
  expect(tree.container.querySelector('.focused-turn')).toBeNull()
})

test('Focused keeps reasoning in the transcript and the running command visible until it settles', async () => {
  const state = project([{ type: 'thinking', thinking: 'Checking the module graph', reasoningKind: 'summary' }])
  const tree = await harness.mount(pane(state, 'focused'))
  expect(tree.container.querySelector('.focused-turn-body')?.textContent).toContain('Checking the module graph')
  expect([...tree.container.querySelectorAll('span.font-semibold')].find(element => element.textContent === 'Thinking')?.parentElement?.textContent).not.toContain('Checking the module graph')
  await tree.render(pane(state, 'full'))
  expect([...tree.container.querySelectorAll('span.font-semibold')].find(element => element.textContent === 'Thinking')?.parentElement?.textContent).not.toContain('Checking the module graph')
  let running = project([{ type: 'tool_use', id: 'pending-bash', name: 'Bash', input: { command: 'bun test src/loader' } }], state)
  running = projectServerFrame(running, { kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'tool.activity', toolUseId: 'pending-bash', phase: 'executing', startedAt: Date.now() } })
  await tree.render(pane(running, 'focused'))
  const activity = [...tree.container.querySelectorAll('span.font-semibold')].find(element => element.textContent === 'Running')?.parentElement
  expect(activity?.textContent).toContain('Bash')
  expect(activity?.textContent).not.toContain('bun test src/loader')
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Running bun test src/loader')
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).not.toContain('ran 1 command')
  expect(tree.container.querySelector('.focused-turn-body')?.textContent).toContain('Checking the module graph')
  const settled = projectServerFrame(running, {
    kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'message', message: {
      type: 'user', uuid: 'tool-result', session_id: 'engine-1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pending-bash', content: 'passed' }] },
    } },
  } as never)
  await tree.render(pane(settled, 'focused'))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Ran bun test src/loader')
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('ran 1')
})

test('producer assistant messages accumulate under Working and fold only when their result arrives', async () => {
  let state = project([{ type: 'text', text: 'I will trace the loader.' }])
  state = project([{ type: 'tool_use', id: 'read-loader', name: 'Read', input: { file_path: '/repo/loader.ts' } }], state)
  state = projectServerFrame(state, { kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'tool.activity', toolUseId: 'read-loader', phase: 'executing', startedAt: Date.now() } })
  state = project([{ type: 'text', text: 'The loader is fixed.' }], state, { stopReason: 'end_turn' })
  const tree = await harness.mount(pane(state, 'focused'))
  expect([...tree.container.querySelectorAll('[data-focused-update]')].map(node => node.textContent))
    .toEqual(['I will trace the loader.', 'The loader is fixed.'])
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Reading')
  state = projectServerFrame(state, {
    kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'message', message: {
      type: 'result', subtype: 'success', is_error: false, errors: [], duration_ms: 104000,
      uuid: 'completed-result', session_id: 'engine-1', result: 'The loader is fixed.',
    } },
  } as never)
  await tree.render(pane(state, 'focused'))
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('false')
  // The head keeps its live wording while the finished work settles.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 340)) })
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('1m 44s')
  expect(tree.container.querySelector('.focused-turn')?.textContent).not.toContain('The loader is fixed.')
  expect(tree.container.textContent).toContain('The loader is fixed.')
})

test('provider phase places the streamed answer outside Working before completion and keeps commentary inside', async () => {
  let state = project([{ type: 'text', text: 'An update, not the answer.', phase: 'commentary' }])
  const event = (value: unknown) => ({ kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: {
    type: 'message', message: { type: 'stream_event', event: value, parent_tool_use_id: null },
  } }) as never
  state = projectServerFrame(state, event({ type: 'message_start', message: { id: 'final-stream' } }))
  state = projectServerFrame(state, event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', phase: 'final_answer' } }))
  state = projectServerFrame(state, event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The actual answer' } }))
  const tree = await harness.mount(pane(state, 'focused'))
  expect(tree.container.querySelector('.focused-turn')?.textContent).toContain('An update, not the answer.')
  expect(tree.container.querySelector('.focused-turn')?.textContent).not.toContain('The actual answer')
  expect(tree.container.textContent).toContain('The actual answer')
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('true')
  const liveAnswer = [...tree.container.querySelectorAll('[data-row-key]')].find(node => node.textContent?.includes('The actual answer'))
  expect(liveAnswer?.closest('.focused-turn')).toBeNull()
  state = project([{ type: 'text', text: 'The actual answer, complete.', phase: 'final_answer' }], state, { messageId: 'final-stream' })
  expect(selectNestedTranscriptRows(state, 'session-1').filter(row => row.kind === 'assistant-text' && row.phase === 'final_answer')
    .map(row => row.kind === 'assistant-text' ? row.content : '')).toEqual(['The actual answer, complete.'])
  state = projectServerFrame(state, {
    kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'message', message: {
      type: 'result', subtype: 'success', is_error: false, errors: [], duration_ms: 1000,
      uuid: 'phase-result', session_id: 'engine-1', result: 'The actual answer, complete.',
    } },
  } as never)
  await tree.render(pane(state, 'focused'))
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.querySelector('.focused-turn')?.textContent).not.toContain('The actual answer')
  expect(tree.container.textContent).toContain('The actual answer, complete.')
})

test('saved previews use recorded end_turn for the answer, never missing or failed completion evidence', async () => {
  for (const ending of ['end_turn', 'max_tokens', 'unknown', 'interrupted']) {
    let state = project([{ type: 'text', text: 'Checking the saved conversation.' }], undefined, { replay: true })
    state = project([{ type: 'text', text: 'Saved answer.' }], state, { replay: true, stopReason: ending === 'unknown' ? undefined : 'end_turn' })
    if (ending === 'max_tokens') state = project([{ type: 'text', text: 'Cut off.' }], state, { replay: true, stopReason: 'max_tokens' })
    if (ending === 'interrupted') state = projectServerFrame(state, {
      kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'message', message: {
        type: 'result', subtype: 'interrupted', is_error: true, errors: [], uuid: 'stop', session_id: 'engine-1',
      } },
    } as never)
    const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
      <SessionPane {...idleSessionPaneProps()} transcript={state} />
    </TranscriptModeContext.Provider>)
    expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe(ending === 'end_turn' ? 'false' : 'true')
    expect(tree.container.textContent).toContain('Saved answer.')
    await tree.unmount()
  }
})

test('a tiny upward wheel releases Focused before a subsequent transcript commit', async () => {
  const state = project([{ type: 'text', text: 'I will trace the loader.' }])
  const tree = await harness.mount(pane(state, 'focused'))
  const scroller = tree.container.querySelector('.focused-transcript-space')!.parentElement!
  Object.defineProperties(scroller, { clientHeight: { configurable: true, value: 500 }, scrollHeight: { configurable: true, value: 1800 } })
  scroller.scrollTop = 800
  await act(async () => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -0.01, bubbles: true })) })
  const next = project([{ type: 'text', text: 'The first check passed.' }], state)
  await tree.render(pane(next, 'focused'))
  await act(async () => { await harness.nextFrame() })
  expect(scroller.scrollTop).toBe(800)
})

test('the real transcript virtual list publishes offsets for unmounted entries and unregisters on disposal', async () => {
  const stylesheet = document.createElement('style')
  stylesheet.textContent = '.overflow-auto { overflow-y: auto; }'
  document.head.append(stylesheet)
  try {
    let state = project([{ type: 'text', text: 'First update' }])
    for (let index = 0; index < 100; index++) state = project([{ type: 'text', text: `Update ${index}` }], state)
    const firstId = selectNestedTranscriptRows(state, 'session-1')[0]!.id
    const tree = await harness.mount(pane(state, 'full'))
    const column = tree.container.querySelector('.transcript-virtual-column')!
    const scroller = column.parentElement!
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 10000 },
    })
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 500)
    column.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 800, 8500)
    await act(async () => {
      scroller.scrollTop = 7000
      scroller.dispatchEvent(new Event('scroll'))
      await harness.nextFrame()
      await harness.nextFrame()
    })
    expect(column.querySelector(`[data-row-key="${firstId}"]`) !== null).toBe(false)
    expect(readTranscriptRowOffset(scroller, firstId)).not.toBeNull()
    expect(readTranscriptRowOffset(scroller, 'unknown-row')).toBeNull()
    await tree.unmount()
    expect(readTranscriptRowOffset(scroller, firstId)).toBeNull()
  } finally { stylesheet.remove() }
})

test('a text-and-image submission anchors its first row rather than the last attachment', async () => {
  let state = project([{ type: 'thinking', thinking: 'Checking the request' }])
  state = projectServerFrame(state, {
    kind: 'event', protocolVersion: 4, sessionId: 'session-1', event: { type: 'message', message: {
      type: 'user', uuid: 'multimodal-turn', session_id: 'engine-1', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg' } },
      ] },
    } },
  } as never)
  const rows = selectNestedTranscriptRows(state, 'session-1')
  const textRow = rows.find(row => row.kind === 'user-text' && row.content === 'What is in this screenshot?')!
  const imageRow = rows.find(row => row.kind === 'user-image' && row.frameId === textRow.frameId)!
  expect(imageRow).toBeDefined()
  const tree = await harness.mount(pane(state, 'full'))
  const column = tree.container.querySelector('.transcript-virtual-column')!
  const scroller = column.parentElement!
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, get: () => 1200 + Number.parseFloat(scroller.querySelector<HTMLElement>('.focused-transcript-space')?.style.getPropertyValue('--focused-transcript-space-height') || '0') },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 80, 800, 500)
  const textElement = column.querySelector<HTMLElement>(`[data-row-key="${textRow.id}"]`)!
  const imageElement = column.querySelector<HTMLElement>(`[data-row-key="${imageRow.id}"]`)!
  textElement.getBoundingClientRect = () => new DOMRect(0, 1080 - scroller.scrollTop, 800, 60)
  imageElement.getBoundingClientRect = () => new DOMRect(0, 1180 - scroller.scrollTop, 800, 100)
  const original = HTMLElement.prototype.getBoundingClientRect
  const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('focused-transcript-space')
      ? new DOMRect(0, 1280 - scroller.scrollTop, 800, 0) : original.call(this)
  })
  try {
    await tree.render(pane(state, 'focused'))
    expect(scroller.scrollTop).toBe(1000 - FOCUSED_PREVIOUS_OUTPUT_PEEK_PX)
  } finally { geometry.mockRestore() }
})
