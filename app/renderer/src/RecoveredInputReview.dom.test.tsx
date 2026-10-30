import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type PromptRecallMessage, type ServerFrame } from '../../shared/protocol.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); Reflect.deleteProperty(window, 'catcode'); window.localStorage.clear() })
afterAll(async () => { await harness.teardown() })

const id = '00000000-0000-4000-8000-000000000101'
const recoveredId = '00000000-0000-4000-8000-000000000102'
async function mountReview() {
  let receive!: (frames: ServerFrame[]) => void
  const recalls: PromptRecallMessage[] = []
  let submits = 0, stops = 0
  let settleStop!: () => void
  const stopped = new Promise<void>(resolve => { settleStop = resolve })
  const descriptor: SessionDescriptor = {
    appSessionId: id, engineSessionId: '00000000-0000-4000-8000-000000000103', cwd: '/isolated/live', title: 'Live',
    forked: false, name: null, createdBy: null, peerWakeBlocked: false, titleUpdatedAt: null,
    status: 'ready', restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1,
    lastMessageSentAt: null, binding: { kind: 'project' },
  }
  window.catcode = {
    subscribe: listener => { receive = listener; return () => {} }, subscribeHost: () => () => {},
    rendererReady() {}, listSessions: async () => [descriptor], readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    reportVisibleSessions() {}, recordRenderCommit() {}, getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    recallPrompts: (_sessionId, message) => { recalls.push(message) },
    submit() { submits++ },
    closeSession: async () => { stops++; await stopped; return { ok: true, value: undefined } },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  await act(async () => { receive([{
    kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id, prompts: [],
    recoveredPrompts: [{ id: recoveredId, text: 'Legacy input preview' }], recoveredPromptCount: 3,
  }]) })
  return { tree, receive, recalls, submits: () => submits, stops: () => stops, settleStop }
}

test('recovered input is visibly uncertain, separate from executable queue, and returns original text/media for explicit send', async () => {
  const h = await mountReview()
  const section = h.tree.container.querySelector('section[aria-label="Recovered inputs for review"]')!
  expect(section.textContent).toContain('Delivery unknown')
  expect(section.textContent).toContain('will not be sent automatically')
  expect(section.textContent).toContain('keeps the saved input here')
  expect(section.textContent).toContain('2 more saved inputs')
  expect(h.tree.container.querySelector('[aria-label="Send next queued message now"]')).toBeNull()
  expect(h.tree.container.querySelectorAll('[data-user-bubble]')).toHaveLength(0)
  expect(h.submits()).toBe(0)
  await act(async () => { section.querySelector<HTMLButtonElement>('button')!.click() })
  expect(h.recalls).toHaveLength(1)
  expect(h.recalls[0]?.recoveredPromptId).toBe(recoveredId)
  await act(async () => { h.receive([{
    kind: 'prompt-recall.result', protocolVersion: PROTOCOL_VERSION, sessionId: id,
    requestId: h.recalls[0]!.requestId, ok: true, alreadyDelivered: 0, message: 'Recovered input is ready to review.',
    recalled: [{ id: recoveredId, prompt: [{ type: 'text', text: 'Original full input' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  }]) })
  expect(h.tree.container.querySelector('[contenteditable="true"][role="textbox"]')?.textContent).toContain('Original full input')
  expect(h.tree.container.querySelector('img[src="data:image/png;base64,AAAA"]')).not.toBeNull()
  expect(h.submits()).toBe(0)
  h.settleStop()
})

test('removing a saved review copy is explicit and does not erase or submit the copied draft', async () => {
  const h = await mountReview()
  const section = h.tree.container.querySelector('section[aria-label="Recovered inputs for review"]')!
  await act(async () => { section.querySelector<HTMLButtonElement>('button')!.click() })
  await act(async () => { h.receive([{
    kind: 'prompt-recall.result', protocolVersion: PROTOCOL_VERSION, sessionId: id,
    requestId: h.recalls[0]!.requestId, ok: true, alreadyDelivered: 0, message: 'Copied.',
    recalled: [{ id: recoveredId, prompt: 'Copied text remains in the draft' }],
  }]) })
  const remove = [...section.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove from review')!
  await act(async () => { remove.click() })
  expect(h.recalls[1]).toMatchObject({ recoveredPromptId: recoveredId, discard: true })
  await act(async () => { h.receive([{
    kind: 'prompt-recall.result', protocolVersion: PROTOCOL_VERSION, sessionId: id,
    requestId: h.recalls[1]!.requestId, ok: true, alreadyDelivered: 0, message: 'Removed from review.', recalled: [],
  }, { kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id,
    prompts: [], recoveredPrompts: [], recoveredPromptCount: 0 }]) })
  expect(h.tree.container.querySelector('[contenteditable="true"][role="textbox"]')?.textContent).toContain('Copied text remains in the draft')
  expect(h.submits()).toBe(0)
  h.settleStop()
})

test('a late recovered recall and close acknowledgement cannot reopen a dismissed tab', async () => {
  const h = await mountReview()
  await act(async () => { h.tree.container.querySelector<HTMLButtonElement>('section[aria-label="Recovered inputs for review"] button')!.click() })
  await act(async () => { h.tree.container.querySelector<HTMLButtonElement>('[aria-label="Close session Live"]')!.click() })
  expect(h.stops()).toBe(1)
  expect(h.tree.container.querySelector('[aria-label="Close session Live"]')).toBeNull()
  await act(async () => {
    h.receive([{
      kind: 'prompt-recall.result', protocolVersion: PROTOCOL_VERSION, sessionId: id,
      requestId: h.recalls[0]!.requestId, ok: true, alreadyDelivered: 0, message: 'Recovered input is ready to review.',
      recalled: [{ id: recoveredId, prompt: 'Must not resurrect' }],
    }, { kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: id, prompts: [],
      recoveredPrompts: [{ id: recoveredId, text: 'Stale saved preview' }], recoveredPromptCount: 1 }])
    h.settleStop()
  })
  expect(h.tree.container.querySelector('[aria-label="Close session Live"]')).toBeNull()
  expect(h.tree.container.querySelector('[contenteditable="true"][role="textbox"]')?.textContent ?? '').not.toContain('Must not resurrect')
  expect(h.submits()).toBe(0)
})
