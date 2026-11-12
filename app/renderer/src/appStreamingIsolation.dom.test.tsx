import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  Reflect.deleteProperty(window, 'catcode')
  window.localStorage.clear()
})
afterAll(async () => { await harness.teardown() })

test('real App token batches do not execute unrelated shell work-mark consumers', async () => {
  const sessionId = 'isolation-live'
  let receive!: (frames: ServerFrame[]) => void
  let serial = 0
  const event = (message: unknown): ServerFrame => ({
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
    event: { type: 'message', message: { type: 'stream_event', uuid: `isolation-${++serial}`, event: message } as never },
  })
  window.catcode = {
    subscribe: listener => { receive = listener; return () => {} },
    subscribeHost: () => () => {}, rendererReady() {}, recordRenderCommit() {},
    listSessions: async () => [sessionDescriptor(sessionId, { title: 'Isolation chat' })],
    readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge

  // Only Sidebar/TabBar rows read this particular map value. Observing that
  // read proves execution inside the actual consumers, not a wrapper or paint.
  const original = Map.prototype.get
  let workReads = 0
  const reads = spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    const value = original.call(this, key)
    if (key === sessionId && value === 'working') workReads++
    return value
  })
  try {
    const tree = await harness.mount(<App />)
    await act(async () => {
      receive([{ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: 'isolation-engine', payload: {
        type: 'app.ready', protocolVersion: 1, activeTurn: true, inputEnabled: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
      } }, event({ type: 'message_start', message: { id: 'stream' } }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })])
    })
    expect(workReads).toBeGreaterThan(0)
    // Complete the shell's own entrance before isolating streamed updates.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    const before = workReads
    for (let token = 0; token < 20; token++) {
      await act(async () => { receive([event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' more' } })]) })
    }
    expect(workReads).toBe(before)
    expect(tree.container.textContent).toContain('Hello more')
  } finally {
    reads.mockRestore()
  }
})
