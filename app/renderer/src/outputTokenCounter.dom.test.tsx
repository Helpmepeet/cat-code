import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../../shared/protocol.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'

let harness: DomTestHarness
const restores: Array<() => void> = []
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  for (const restore of restores.splice(0)) restore()
  Reflect.deleteProperty(window, 'catcode')
  window.localStorage.clear()
})
afterAll(async () => { await harness.teardown() })

const SID = 'counter-session'
let serial = 0
function descriptor(id: string): SessionDescriptor {
  return {
    appSessionId: id, engineSessionId: `engine-${id}`, cwd: `/tmp/${id}`,
    title: id, forked: false, titleUpdatedAt: null, status: 'ready',
    restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1,
    lastMessageSentAt: null, binding: { kind: 'project' },
  }
}
function ready(sessionId = SID): ServerFrame {
  return {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  }
}
function turn(activeTurn: boolean): ServerFrame {
  return { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: SID, event: { type: 'turn.status', activeTurn } }
}
function message(value: unknown, replay = false): ServerFrame {
  return {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
    ...(replay ? { replay: true } : {}),
    event: { type: 'message', message: {
      parent_tool_use_id: null, session_id: `engine-${SID}`, uuid: `counter-${++serial}`, ...value as object,
    } },
  } as ServerFrame
}
function stream(event: unknown): ServerFrame { return message({ type: 'stream_event', event }) }
function completed(id: string, tokens: number): ServerFrame[] {
  return [
    stream({ type: 'message_start', message: { id, usage: { output_tokens: 0 } } }),
    message({ type: 'assistant', message: {
      id, role: 'assistant', model: 'gpt-6.1-sol', stop_reason: null,
      usage: { output_tokens: 0, input_tokens: 0 }, content: [{ type: 'text', text: 'Done.' }],
    } }),
    stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: tokens } }),
    stream({ type: 'message_stop' }),
  ]
}
async function mountApp(initial: ServerFrame[] = [ready(), ready('other-session')]) {
  let receive!: (frames: ServerFrame[]) => void
  let now = 100_000
  const ticks: Array<() => void> = []
  const date = spyOn(Date, 'now').mockImplementation(() => now)
  restores.push(() => date.mockRestore())
  const originalInterval = globalThis.setInterval
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 1000) ticks.push(() => callback(...args))
    return originalInterval(callback, ms, ...args)
  }) as typeof setInterval)
  restores.push(() => interval.mockRestore())
  window.catcode = {
    subscribe: listener => { receive = listener; return () => {} },
    subscribeHost: () => () => {},
    rendererReady: () => { if (initial.length) receive(initial) },
    listSessions: async () => [descriptor(SID), descriptor('other-session')],
    readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    listWorkspaceBranches: async () => ({ ok: true, value: { current: 'main', branches: ['main'], dirty: false } }),
    reportVisibleSessions: () => {}, recordRenderCommit: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  return {
    tree,
    async send(frames: ServerFrame[]) { await act(async () => { receive(frames) }) },
    async elapsed(ms: number) {
      await act(async () => { now += ms; for (const tick of ticks) tick() })
    },
  }
}

const reported = (root: ParentNode) => root.querySelector('[aria-label^="Reported output:"]')
const estimated = (root: ParentNode) => root.querySelector('[aria-label^="Estimated output:"]')

test('real App batches show tool arguments immediately, replace estimates with usage, and survive pane switches', async () => {
  const { tree, send, elapsed } = await mountApp()
  await send([
    turn(true),
    message({ type: 'user', origin: { kind: 'peer', name: 'Alex' }, message: { role: 'user', content: 'Write the file' } }),
    stream({ type: 'message_start', message: { id: 'tool-response', usage: { output_tokens: 0 } } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'write-file', name: 'Write', input: {} } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(40_000) } }),
  ])
  expect(estimated(tree.container)).toBeNull()
  await elapsed(31_000)
  expect(estimated(tree.container)?.textContent).toBe(' · ↓ 10k tokens')
  expect(estimated(tree.container)?.getAttribute('aria-label')).toContain('Excludes separate agents')
  await send([
    stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12_345 } }),
    stream({ type: 'message_stop' }),
  ])
  expect(estimated(tree.container)).toBeNull()
  expect(reported(tree.container)?.textContent).toContain('↓ 12.3k tokens')
  for (const title of ['other-session', SID]) {
    await act(async () => {
      const tab = [...tree.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.includes(title))
      expect(tab).toBeDefined()
      tab!.click()
    })
  }
  expect(reported(tree.container)?.textContent).toContain('↓ 12.3k tokens')
  expect(reported(tree.container)?.parentElement?.textContent).toContain('31s')
})

test('unmarked document replay cannot seed an exact-looking current total; the next live turn can', async () => {
  const { tree, send, elapsed } = await mountApp([
    ready(), turn(true), ...completed('historical', 5000), turn(false), turn(true),
  ])
  await elapsed(31_000)
  expect(reported(tree.container)).toBeNull()
  expect(estimated(tree.container)).toBeNull()
  expect(tree.container.querySelector('[title="Output count unavailable for this turn."]')).not.toBeNull()
  await send([turn(false), turn(true), ...completed('new-peer-turn', 200)])
  await elapsed(31_000)
  expect(reported(tree.container)?.textContent).toContain('↓ 200 tokens')
  await send([message({ type: 'assistant', message: {
    id: 'saved-old', model: 'gpt-6.1-sol', stop_reason: 'end_turn', usage: { output_tokens: 8000 },
    content: [{ type: 'text', text: 'Old history' }],
  } }, true)])
  expect(reported(tree.container)?.textContent).toContain('↓ 200 tokens')
})

test('same-batch turn changes reset totals and connection loss hides them', async () => {
  const { tree, send, elapsed } = await mountApp()
  await send([turn(true), ...completed('first', 5000)])
  await elapsed(31_000)
  expect(reported(tree.container)?.textContent).toContain('↓ 5k tokens')
  await send([turn(false), turn(true), ...completed('next', 200)])
  expect(reported(tree.container)?.textContent).toContain('↓ 200 tokens')
  await send([{ kind: 'transcript.reset', protocolVersion: PROTOCOL_VERSION, sessionId: SID }])
  expect(reported(tree.container)).toBeNull()
  await send([turn(false), turn(true), ...completed('after-reset', 300)])
  expect(reported(tree.container)?.textContent).toContain('↓ 300 tokens')
  await send([])
  await send([{ kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: SID, status: 'disconnected' }])
  expect(reported(tree.container)).toBeNull()
  expect(estimated(tree.container)).toBeNull()
})

test('an empty bootstrap conservatively withholds a first-batch turn, then counts the next live turn', async () => {
  const { tree, send, elapsed } = await mountApp([])
  await send([ready(), turn(true), ...completed('first-batch', 5000)])
  await elapsed(31_000)
  expect(reported(tree.container)).toBeNull()
  expect(estimated(tree.container)).toBeNull()
  await send([turn(false), turn(true), ...completed('known-live', 200)])
  await elapsed(31_000)
  expect(reported(tree.container)?.textContent).toContain('↓ 200 tokens')
})
