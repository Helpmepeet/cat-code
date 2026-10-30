import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptModeContext } from './transcriptMode.js'
import type { CatCodeBridge, ServerFrame, SubmitOptions } from '../../shared/protocol.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); Reflect.deleteProperty(window, 'catcode'); window.localStorage.clear() })
afterAll(async () => { await harness.teardown() })

test('Enter shows the Focused queue before any sidecar reply, reconciles once, and restores a refused submit', async () => {
  let receive!: (frames: ServerFrame[]) => void
  const submits: SubmitOptions[] = []
  const descriptor: SessionDescriptor = {
    appSessionId: 'live', engineSessionId: 'engine', cwd: '/tmp/live', title: 'Live', forked: false,
    titleUpdatedAt: null, status: 'ready', restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1,
    lastMessageSentAt: null, binding: { kind: 'project' },
  }
  window.catcode = {
    subscribe: listener => { receive = listener; return () => {} }, subscribeHost: () => () => {},
    rendererReady() {}, listSessions: async () => [descriptor], readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    reportVisibleSessions() {}, recordRenderCommit() {}, getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    submit: (_id, _prompt, options) => { submits.push(options!) },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}><App /></TranscriptModeContext.Provider>)
  await act(async () => { receive([{ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', engineSessionId: 'engine', payload: {
    type: 'app.ready', protocolVersion: 1, activeTurn: true, inputEnabled: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  } }]) })
  const composer = () => tree.container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!
  async function send(text: string) {
    await act(async () => { composer().textContent = text; composer().dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  }
  await send('Check the queue')
  expect(submits).toHaveLength(1)
  const strip = () => tree.container.querySelector('[role="status"] .conversation-prose')
  expect(strip()?.textContent).toContain('Check the queue')
  const submitId = submits[0]!.submitId!
  await act(async () => { receive([{ kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', prompts: [{ id: 'engine-queue-id', submitId, text: 'Check the queue' }] }]) })
  expect(tree.container.querySelectorAll('[role="status"] .conversation-prose')).toHaveLength(1)
  await act(async () => { receive([{ kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', prompts: [] }]) })
  expect(strip()).toBeNull()
  await send('Directly delivered after the turn ended')
  const directSubmitId = submits.at(-1)!.submitId!
  await act(async () => { receive([
    { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', event: { type: 'message', message: { type: 'user', uuid: '00000000-0000-4000-8000-000000000010', parent_tool_use_id: null, session_id: 'engine', message: { role: 'user', content: 'Directly delivered after the turn ended' } } } },
    { kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', submitId: directSubmitId, accepted: true, queued: false },
  ]) })
  expect(strip()).toBeNull()
  expect(tree.container.querySelectorAll('[data-user-bubble]')).toHaveLength(1)
  await send('Refused input')
  expect(strip()?.textContent).toContain('Refused input')
  await act(async () => { receive([{ kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'live', submitId: submits.at(-1)!.submitId!, accepted: false, code: 'bad_request' }]) })
  expect(strip()).toBeNull()
  expect(composer().textContent).toContain('Refused input')
})
