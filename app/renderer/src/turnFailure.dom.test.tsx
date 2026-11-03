import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { TranscriptView, TranscriptRowsView } from './TranscriptView.js'
import { ConnectionRecovery } from './SessionPane.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from './transcriptProjector.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { TranscriptModeContext } from './transcriptMode.js'

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

test('live retry metadata is a countdown for the next call; recovery removes the notice', async () => {
  let state = projectServerFrame(readyState(), frame(retry))
  const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
  expect(tree.container.textContent).toContain('Overloaded. Retrying.')
  expect(tree.container.textContent).toContain('try 4 in 12s')
  state = projectServerFrame(state, frame({ type: 'result', subtype: 'success', uuid: 'success', is_error: false }))
  await tree.render(<TranscriptView state={state} activeSessionId="session" turnLive={false} />)
  expect(tree.container.textContent).not.toContain('Overloaded')
  expect(tree.container.textContent).not.toContain('Went through')
  expect(tree.container.querySelectorAll('[data-transcript-entry]')).toHaveLength(1)
  expect(tree.container.querySelector('[data-row-key*="api_retry"]')).toBeNull()
  expect(tree.container.textContent).not.toContain('↻')
  expect(tree.container.textContent).not.toContain(' in ')
})

test('the live countdown ticks down while the wait runs', async () => {
  const start = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(start)
  try {
    const state = projectServerFrame(readyState(), frame({ ...retry, uuid: 'ticking-retry' }))
    const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
    expect(tree.container.textContent).toContain('try 4 in 12s')
    clock.mockReturnValue(start + 5000)
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

for (const replay of [false, true]) {
  test(`${replay ? 'restored' : 'live'} connection notice disappears as soon as response text resumes`, async () => {
    let state = projectServerFrame(readyState(), frame({
      type: 'assistant', uuid: 'before-disconnect', parent_tool_use_id: null,
      message: { id: 'before', role: 'assistant', content: [{ type: 'text', text: 'Before the interruption.' }] },
    }, replay))
    state = projectServerFrame(state, frame({
      ...retry, error_status: null,
      error: { type: 'assistant_error', error: 'connection_error', message: 'Connection interrupted. Continuing automatically.' },
    }, replay))
    const tree = await harness.mount(<TranscriptView state={state} activeSessionId="session" turnLive />)
    expect(tree.container.textContent).toContain('Connection interrupted. Retrying.')
    state = projectServerFrame(state, frame({
      type: 'stream_event', uuid: 'resumed-start',
      event: { type: 'message_start', message: { id: 'resumed' } },
    }, replay))
    state = projectServerFrame(state, frame({
      type: 'stream_event', uuid: 'resumed-text',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'After the interruption.' } },
    }, replay))
    await tree.render(<TranscriptView state={state} activeSessionId="session" turnLive />)
    expect(tree.container.textContent).toContain('Before the interruption.')
    expect(tree.container.textContent).toContain('After the interruption.')
    expect(tree.container.textContent).not.toContain('Connection interrupted')
    expect(tree.container.textContent).not.toContain('Went through')
    expect(tree.container.querySelectorAll('[data-transcript-entry]')).toHaveLength(2)
    expect(selectNestedTranscriptRows(state, 'session').find(row => row.kind === 'system-notice')).toMatchObject({
      retry: { state: 'success' },
    })
  })
}

test.each([
  [false, 'full'], [true, 'full'], [false, 'focused'], [true, 'focused'],
] as const)('Copy response includes all parts after repeated disconnects (replay=%s, mode=%s)', async (replay, mode) => {
  const writes: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { writes.push(text) } },
  })
  try {
    let state = readyState()
    const parts = ['First **part**.', 'Second part.', 'Last part.\n\n```sh\npwd\n```']
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) state = projectServerFrame(state, frame({
        ...retry, uuid: `disconnect-${index}`, attempt: index, error_status: null,
        error: { type: 'assistant_error', error: 'connection_error', message: 'Connection interrupted. Continuing automatically.' },
      }, replay))
      state = projectServerFrame(state, frame({
        type: 'assistant', uuid: `part-${index}`, parent_tool_use_id: null,
        message: { id: `reply-${index}`, role: 'assistant', content: [{ type: 'text', text: parts[index] }] },
      }, replay))
    }
    state = projectServerFrame(state, frame({ type: 'result', subtype: 'success', uuid: 'finished', is_error: false }, replay))
    const tree = await harness.mount(
      <TranscriptModeContext.Provider value={{ mode, setMode: () => {} }}>
        <TranscriptView state={state} activeSessionId="session" turnLive={false} />
      </TranscriptModeContext.Provider>,
    )
    expect(tree.container.textContent).not.toContain('Connection interrupted')
    expect(tree.container.querySelectorAll('[aria-label="Copy response"]')).toHaveLength(1)
    const copy = tree.container.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!
    await act(async () => { copy.click() })
    expect(writes).toEqual([parts.join('\n\n')])
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard
  }
})

test('Retry sends the failed turn text to the submit callback and disappears while running', async () => {
  let state = projectServerFrame(readyState(), frame({ type: 'user', uuid: 'user', message: { role: 'user', content: 'Retry this exact text' } }))
  state = projectServerFrame(state, frame({ type: 'result', subtype: 'error_during_execution', uuid: 'failure', is_error: true }))
  const rows = selectNestedTranscriptRows(state, 'session')
  const submitted: string[] = []
  const draw = (live: boolean) => <TranscriptRowsView rows={rows} turnLive={live} onRetryTurn={text => { submitted.push(text) }} />
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

for (const status of ['refused', 'admitted', 'unknown', 'reject', 'throw'] as const) {
  test(`Retry ${status} releases only a definite refusal`, async () => {
    let state = projectServerFrame(readyState(), frame({ type: 'user', uuid: 'user', message: { role: 'user', content: 'Retry exact text' } }))
    state = projectServerFrame(state, frame({ type: 'result', subtype: 'error_during_execution', uuid: 'failure', is_error: true }))
    let sends = 0
    let resolve!: (value: import('../../shared/notificationNavigation.js').TurnRetryResult) => void
    const pending = new Promise<import('../../shared/notificationNavigation.js').TurnRetryResult>(done => { resolve = done })
    const tree = await harness.mount(<TranscriptRowsView rows={selectNestedTranscriptRows(state, 'session')} turnLive={false} onRetryTurn={() => {
      sends++
      if (status === 'throw') throw new Error('unknown invocation failure')
      if (status === 'reject') return Promise.reject(new Error('unknown delivery'))
      return pending
    }} />)
    const findRetry = () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Retry')
    const retry = findRetry()!
    await act(async () => { retry.click(); retry.click() })
    expect(sends).toBe(1)
    expect(findRetry()).toBeUndefined()
    if (status !== 'throw' && status !== 'reject') await act(async () => {
      resolve(status === 'refused' ? { status, reason: 'local_refusal' } : { status })
    })
    expect(Boolean(findRetry())).toBe(status === 'refused')
    if (status === 'refused') {
      await act(async () => { findRetry()!.click() })
      expect(sends).toBe(2)
    }
  })
}
