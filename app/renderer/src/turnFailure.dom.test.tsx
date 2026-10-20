import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { TranscriptView, TranscriptRowsView } from './TranscriptView.js'
import { ConnectionRecovery } from './SessionPane.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from './transcriptProjector.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode | undefined
beforeAll(async () => {
  harness = await createDomTestHarness()
  previousBridge = window.catcode
  window.catcode = { restart: async () => ({ ok: false, error: { code: 'session_limit', message: 'Restart refused' } }) } as unknown as typeof window.catcode
})
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => {
  if (previousBridge) window.catcode = previousBridge
  else delete (window as unknown as Record<string, unknown>).catcode
  await harness.teardown()
})

function frame(message: unknown, replay = false): ServerFrame {
  return { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', ...(replay ? { replay: true } : {}), event: { type: 'message', message } } as ServerFrame
}
const retry = { type: 'system', subtype: 'api_retry', uuid: 'retry', attempt: 3, max_retries: 10, retry_delay_ms: 12000, error_status: 529, error: 'rate_limit' }

function readyState() {
  return projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'session',
    engineSessionId: 'engine-session', payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  })
}

test('live retry metadata is a countdown for the next call; settlement removes glyph and countdown', async () => {
  let state = projectServerFrame(readyState(), frame(retry))
  const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
  expect(tree.container.textContent).toContain('Overloaded. Retrying.')
  expect(tree.container.textContent).toContain('try 4 in 12s')
  state = projectServerFrame(state, frame({ type: 'result', subtype: 'success', uuid: 'success', is_error: false }))
  await tree.render(<TranscriptView state={state} activeSessionId="session" turnLive={false} />)
  expect(tree.container.textContent).toContain('Went through on try 4.')
  expect(tree.container.textContent).not.toContain('↻')
  expect(tree.container.textContent).not.toContain(' in ')
})

test('the live countdown ticks down while the wait runs', async () => {
  const start = Date.now()
  const state = projectServerFrame(readyState(), frame({ ...retry, uuid: 'ticking-retry' }))
  const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
  expect(tree.container.textContent).toContain('try 4 in 12s')
  const clock = spyOn(Date, 'now').mockImplementation(() => start + 5000)
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(tree.container.textContent).toContain('try 4 in 7s')
  } finally {
    clock.mockRestore()
  }
})

test('restored retry history never starts a countdown even while the session is running', async () => {
  const state = projectServerFrame(readyState(), frame(retry, true))
  const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
  expect(tree.container.textContent).toContain('Overloaded. Retrying.')
  expect(tree.container.textContent).not.toContain(' in ')
})

test('Retry sends the failed turn text to the submit callback and disappears while running', async () => {
  let state = projectServerFrame(readyState(), frame({ type: 'user', uuid: 'user', message: { role: 'user', content: 'Retry this exact text' } }))
  state = projectServerFrame(state, frame({ type: 'result', subtype: 'error_during_execution', uuid: 'failure', is_error: true }))
  const rows = selectNestedTranscriptRows(state, 'session')
  const submitted: string[] = []
  const draw = (live: boolean) => <TranscriptRowsView rows={rows} turnLive={live} onRetryTurn={text => submitted.push(text)} />
  const tree = await harness.mount(draw(false))
  const button = [...tree.container.querySelectorAll('button')].find(control => control.textContent === 'Retry')
  expect(button).toBeDefined()
  await act(async () => button!.click())
  expect(submitted).toEqual(['Retry this exact text'])
  // The engine has not answered yet, so the turn is still idle: a second click
  // must not send the same message again.
  await act(async () => button!.click())
  expect(submitted).toEqual(['Retry this exact text'])
  expect([...tree.container.querySelectorAll('button')].some(control => control.textContent === 'Retry')).toBe(false)
  await tree.render(draw(true))
  expect([...tree.container.querySelectorAll('button')].some(control => control.textContent === 'Retry')).toBe(false)
})

test('connection recovery uses the failure card and keeps restart failures in the detail', async () => {
  const tree = await harness.mount(<ConnectionRecovery connection={{ status: 'disconnected', inputEnabled: false }} sessionId="session" />)
  expect(tree.container.textContent).toContain('This session lost its connection')
  expect(tree.container.textContent).not.toContain('Restart it to')
  expect(tree.container.querySelector('.border-tone-danger\\/30')).not.toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('button')!.click())
  expect(tree.container.querySelector('.text-text-muted')?.textContent).toContain('Restart refused')
  await tree.render(<ConnectionRecovery connection={{ status: 'restore_failed', inputEnabled: false }} sessionId="session" />)
  expect(tree.container.querySelector('button')).toBeNull()
})
