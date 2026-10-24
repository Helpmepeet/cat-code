import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows, type TranscriptState } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
let serial = 0
function project(content: unknown[], prior?: TranscriptState) {
  const sessionId = 'session-1'
  let state = prior ?? projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: 4, sessionId, engineSessionId: 'engine-1', payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  } as never)
  const id = ++serial
  const event = (message: unknown) => ({ kind: 'event', protocolVersion: 4, sessionId, event: { type: 'message', message } }) as never
  if (!prior) state = projectServerFrame(state, event({ type: 'user', uuid: `user-${id}`, session_id: 'engine-1', parent_tool_use_id: null, message: { role: 'user', content: 'Check the loader' } }))
  return projectServerFrame(state, event({ type: 'assistant', uuid: `assistant-${id}`, session_id: 'engine-1', parent_tool_use_id: null, message: {
    id: `message-${id}`, role: 'assistant', type: 'message', model: 'gpt-6.1-sol', stop_reason: null, stop_sequence: null,
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

test('only Focused adds the current reasoning step to the working line, keeping the real tool name when running', async () => {
  const state = project([{ type: 'thinking', thinking: 'Checking the module graph', reasoningKind: 'summary' }])
  const tree = await harness.mount(pane(state, 'focused'))
  expect(tree.container.querySelector('.focused-reasoning-target')?.textContent).toBe('Checking the module graph')
  await tree.render(pane(state, 'full'))
  expect(tree.container.querySelector('.focused-reasoning-target')).toBeNull()
  const running = project([{ type: 'tool_use', id: 'pending-bash', name: 'Bash', input: { command: 'bun test src/loader' } }], state)
  await tree.render(pane(running, 'focused'))
  const activity = [...tree.container.querySelectorAll('span.font-semibold')].find(element => element.textContent === 'Running')?.parentElement
  expect(activity?.textContent).toContain('Bash')
  expect(activity?.textContent).not.toContain('bun test src/loader')
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Running bun test src/loader')
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
