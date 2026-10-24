import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from './transcriptProjector.js'
import { retryableTurn } from './turnFailure.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  Reflect.deleteProperty(window, 'catcode')
  window.localStorage.clear()
})
afterAll(async () => { await harness.teardown() })

function descriptor(id: string): SessionDescriptor {
  return {
    appSessionId: id, engineSessionId: `engine-${id}`, cwd: `/tmp/${id}`,
    title: id, forked: false, titleUpdatedAt: null, status: 'ready',
    restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1,
    lastMessageSentAt: null, binding: { kind: 'project' },
  }
}

test.each([false, true])('notification activation opens an offscreen session and accounts=%s', async accounts => {
  let receiveHost!: (event: HostEvent) => void
  const visible: string[][] = []
  window.catcode = {
    subscribe: () => () => {},
    subscribeHost: receive => { receiveHost = receive; return () => {} },
    rendererReady: () => {},
    listSessions: async () => [descriptor('first')],
    readProjectRoutes: async () => [],
    readSessionsCatalog: async () => null,
    reportVisibleSessions: ids => { visible.push([...ids]) },
    recordRenderCommit: () => {},
    refreshAccountsPool: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  await act(async () => {
    receiveHost({ type: 'session-status', session: { ...descriptor('offscreen'), appSessionId: '00000000-0000-4000-8000-000000000001' } })
    receiveHost({ type: 'notification-open', appSessionId: '00000000-0000-4000-8000-000000000001', accounts })
  })
  const selected = tree.container.querySelector('[role="tab"][aria-selected="true"]')
  expect(selected?.textContent).toContain(accounts ? 'Accounts' : 'offscreen')
  if (!accounts) expect(visible.at(-1)).toEqual(['00000000-0000-4000-8000-000000000001'])
  else expect(visible.at(-1)).toEqual([])
})

test('the live card selects the same projected result through the shared Retry gate', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000001'
  let receive!: (frames: ServerFrame[]) => void
  let receiveHost!: (event: HostEvent) => void
  const retries: string[][] = []
  const blocked: string[][] = []
  let finishAttachment!: (value: null) => void
  window.catcode = {
    subscribe: listener => { receive = listener; return () => {} },
    subscribeHost: listener => { receiveHost = listener; return () => {} },
    rendererReady: () => {},
    listSessions: async () => [{ ...descriptor('Retry target'), appSessionId: sessionId }],
    readProjectRoutes: async () => [],
    readSessionsCatalog: async () => null,
    reportVisibleSessions: () => {},
    recordRenderCommit: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    retryTurn: async (id, resultId) => { retries.push([id, resultId]); return true },
    reportNotificationRetryBlocked: ids => { blocked.push([...ids]) },
    pickAttachmentFile: () => new Promise<null>(resolve => { finishAttachment = resolve }),
    submit: () => { throw new Error('Retry must not bypass its claim gate') },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  const frames: ServerFrame[] = [
    { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: 'engine',
      payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } },
    { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
      event: { type: 'message', message: { type: 'user', uuid: '00000000-0000-4000-8000-000000000002', message: { role: 'user', content: 'Try this exact text' } } } },
    { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
      event: { type: 'message', message: { type: 'result', uuid: '00000000-0000-4000-8000-000000000003', subtype: 'error_during_execution', is_error: true } } },
  ]
  const candidate = retryableTurn(selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), frames), sessionId))!
  await act(async () => { receive(frames) })
  expect(blocked.at(-1)).toEqual([])
  const composer = () => tree.container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!
  await act(async () => {
    composer().textContent = 'Unsent draft'
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(blocked.at(-1)).toEqual([sessionId])
  expect([...tree.container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(false)
  await act(async () => { receiveHost({ type: 'notification-open', appSessionId: sessionId, accounts: true }) })
  expect(tree.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Accounts')
  expect(blocked.at(-1)).toEqual([sessionId])
  await act(async () => { receiveHost({ type: 'notification-open', appSessionId: sessionId, accounts: false }) })
  expect(composer().textContent).toBe('Unsent draft')
  await act(async () => {
    composer().textContent = ''
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(blocked.at(-1)).toEqual([])
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Add attachment"]')!.click() })
  expect(blocked.at(-1)).toEqual([sessionId])
  await act(async () => { receiveHost({ type: 'notification-open', appSessionId: sessionId, accounts: true }) })
  expect(blocked.at(-1)).toEqual([sessionId])
  await act(async () => { finishAttachment(null) })
  expect(blocked.at(-1)).toEqual([])
  await act(async () => { receiveHost({ type: 'notification-open', appSessionId: sessionId, accounts: false }) })
  const retry = [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Retry')
  expect(retry).toBeDefined()
  await act(async () => { retry!.click(); retry!.click() })
  expect(retries).toEqual([[sessionId, candidate.resultId]])
})
