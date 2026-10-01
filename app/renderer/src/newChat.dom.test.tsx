import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { SessionDescriptor, HostEvent } from '../../shared/hostApi.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => {
  harness = await createDomTestHarness()
})
afterEach(async () => {
  await harness.unmountAll()
  Reflect.deleteProperty(window, 'catcode')
  window.localStorage.clear()
})
afterAll(async () => {
  await harness.teardown()
})

test.each([
  ['button', 'none'],
  ['shortcut', 'none'],
  ['sidebar', 'none'],
  ['button', 'managed'],
  ['button', 'project'],
  ['folder', 'none'],
] as const)('Chat creation via %s with %s active uses the matching host path', async (entry, context) => {
  let managedChats = 0
  let folderPicks = 0
  let directoryCreates = 0
  const workspaceCreates: string[] = []
  let receiveHost: ((event: HostEvent) => void) | undefined
  const created: SessionDescriptor = {
    appSessionId: 'new-chat', engineSessionId: null, cwd: '/tmp/chat-storage',
    title: 'Normal chat', forked: false, titleUpdatedAt: null,
    status: 'spawning', restorable: false, parked: false,
    createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null,
    binding: {
      kind: 'managed',
      storageRootId: '00000000-0000-4000-8000-000000000001',
      storageId: '00000000-0000-4000-8000-000000000002',
    },
  }
  const active: SessionDescriptor = {
    ...created,
    appSessionId: 'existing-chat',
    title: 'Existing chat',
    binding: context === 'project' ? { kind: 'project' } : created.binding,
  }
  window.catcode = {
    subscribe: () => () => {},
    subscribeHost: receive => {
      receiveHost = receive
      return () => {}
    },
    rendererReady: () => {},
    listSessions: async () => context === 'none' ? [] : [active],
    readProjectRoutes: async () => [],
    readSessionsCatalog: async () => null,
    reportVisibleSessions: () => {},
    recordRenderCommit: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    createManagedChat: async () => {
      managedChats += 1
      receiveHost?.({ type: 'session-added', session: created })
      return { ok: true, value: created }
    },
    createSessionInWorkspace: async (id: string) => {
      workspaceCreates.push(id)
      const projectChat = { ...created, binding: { kind: 'project' as const } }
      receiveHost?.({ type: 'session-added', session: projectChat })
      return { ok: true, value: projectChat }
    },
    createSession: async input => {
      expect(input).toEqual({ cwdToken: 'picked-folder' })
      directoryCreates++
      receiveHost?.({ type: 'session-added', session: created })
      return { ok: true, value: created }
    },
    pickDirectory: async () => {
      folderPicks += 1
      return entry === 'folder' ? 'picked-folder' : null
    },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  if (entry === 'sidebar' || entry === 'folder') {
    await act(async () => {
      tree.container.querySelector<HTMLButtonElement>('button[aria-label="Pin sidebar open"]')!.click()
    })
  }
  const button = tree.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')
  expect(button).not.toBeNull()
  await act(async () => {
    if (entry === 'shortcut') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))
    } else if (entry === 'folder') {
      tree.container.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.click()
    } else if (entry === 'sidebar') {
      const newChat = [...tree.container.querySelectorAll('button')].find(
        button => button.textContent?.includes('New chat') && !button.hasAttribute('aria-label'),
      )
      expect(newChat).toBeDefined()
      newChat!.click()
    } else button!.click()
  })
  expect(managedChats).toBe(context === 'project' || entry === 'folder' ? 0 : 1)
  expect(workspaceCreates).toEqual(context === 'project' ? ['existing-chat'] : [])
  expect(folderPicks).toBe(entry === 'folder' ? 1 : 0)
  expect(directoryCreates).toBe(entry === 'folder' ? 1 : 0)
  expect(tree.container.querySelector('[aria-label="Prompt"]')).not.toBeNull()
  expect(tree.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Normal chat')
})

function descriptor(id: string, project = false): SessionDescriptor {
  return {
    appSessionId: id, engineSessionId: `engine-${id}`, cwd: `/tmp/${id}`,
    title: id, forked: false, titleUpdatedAt: null, status: 'ready',
    restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1,
    lastMessageSentAt: null,
    binding: project ? { kind: 'project' } : {
      kind: 'managed', storageRootId: '00000000-0000-4000-8000-000000000001',
      storageId: '00000000-0000-4000-8000-000000000002',
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type CreateResult = Awaited<ReturnType<CatCodeBridge['createManagedChat']>>

async function mountCommands({
  sessions = [descriptor('origin')], drafts = {}, delayed = false,
}: {
  sessions?: SessionDescriptor[]; drafts?: Record<string, string>; delayed?: boolean
} = {}) {
  const creates: Array<{ origin: string | null; result: ReturnType<typeof deferred<CreateResult>> }> = []
  const submits: unknown[][] = []
  const restores: string[] = []
  const otherActions: string[] = []
  let attachmentPicks = 0
  let host!: (event: HostEvent) => void
  let frame!: (events: ServerFrame[]) => void
  window.localStorage.setItem('catcode.promptDrafts.v1', JSON.stringify({ version: 1, drafts }))
  window.localStorage.setItem('catcode.workspaceLayout.v1', JSON.stringify({
    version: 1, panels: sessions.map(row => row.appSessionId),
    widths: sessions.map(() => 100 / sessions.length), activeIndex: 0,
  }))
  const create = async (origin: string | null): Promise<CreateResult> => {
    const result = deferred<CreateResult>()
    creates.push({ origin, result })
    if (!delayed) result.resolve({ ok: true, value: descriptor(`created-${creates.length}`, origin !== null) })
    const answer = await result.promise
    if (answer.ok) host({ type: 'session-added', session: answer.value })
    return answer
  }
  window.catcode = {
    subscribe: receive => { frame = receive; return () => {} },
    subscribeHost: receive => { host = receive; return () => {} },
    rendererReady: () => {}, listSessions: async () => sessions,
    readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    reportVisibleSessions: () => {}, recordRenderCommit: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    createManagedChat: () => create(null), createSessionInWorkspace: id => create(id),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: 'main', branches: ['main'], dirty: false } }),
    submit: (...args) => { submits.push(args) },
    restoreSession: async id => { restores.push(id); return { ok: true, value: sessions[0]! } },
    abort: () => { otherActions.push('abort') }, closeSession: async () => { otherActions.push('close'); return { ok: true, value: undefined } },
    pickDirectory: async () => { otherActions.push('pick'); return null },
    pickAttachmentFile: async () => ++attachmentPicks === 1
      ? { kind: 'file', token: 'file-token', name: 'notes.txt' }
      : { kind: 'image', name: 'sketch.png', mediaType: 'image/png', bytes: new Uint8Array([1]) },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  const ready = async (id: string, inputEnabled = true) => {
    await act(async () => frame([{
      kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: id, engineSessionId: `engine-${id}`,
      payload: { type: 'app.ready', protocolVersion: 1, inputEnabled, activeTurn: !inputEnabled,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
    }]))
  }
  for (const session of sessions) await ready(session.appSessionId)
  return { tree, creates, submits, restores, otherActions, host, frame, ready }
}

function prompts(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label="Prompt"]')]
}

async function edit(field: HTMLElement, text: string) {
  await act(async () => {
    field.textContent = text
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  })
}

async function key(field: HTMLElement, keyName = 'Enter', modifiers: KeyboardEventInit = {}) {
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...modifiers })))
}

function send(field: HTMLElement): HTMLButtonElement {
  return field.closest('form')!.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!
}

function selectTab(container: HTMLElement, id: string): HTMLButtonElement {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.includes(id))
  if (!tab) throw new Error(`Missing tab ${id}`)
  return tab
}

test.each([
  ['/clear', false, false], ['/new', true, false], [' \n/clear\t', true, false],
  ['/new', false, true], ['/clear', true, true],
] as const)('desktop command %s project=%s pasted=%s creates only on submit', async (draft, project, pasted) => {
  const testState = await mountCommands({ sessions: [descriptor('origin', project)] })
  const field = prompts(testState.tree.container)[0]!
  if (pasted) {
    const data = new DataTransfer(); data.setData('text/plain', draft)
    await act(async () => field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })))
  } else await edit(field, draft)
  expect(testState.creates).toHaveLength(0)
  expect(field.textContent).toBe(draft)
  if (draft === '/clear' || draft === '/new') expect(field.getAttribute('aria-expanded')).toBe('true')
  if (!project && !pasted) {
    await testState.ready('origin', false)
    await act(async () => send(field).click())
  } else await key(field)
  expect(testState.creates.map(call => call.origin)).toEqual([project ? 'origin' : null])
  expect(testState.submits).toEqual([])
  expect(testState.otherActions).toEqual([])
  expect(testState.tree.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('created-1')
  await act(async () => selectTab(testState.tree.container, 'origin').click())
  const original = prompts(testState.tree.container)[0]!
  expect(original.textContent).toBe('')
  await key(original, 'ArrowUp')
  expect(original.textContent).toBe('')
})

test('Tab completes without creation; IME and modified Enter do not execute', async () => {
  const state = await mountCommands()
  const field = prompts(state.tree.container)[0]!
  await edit(field, '/clear')
  await key(field, 'Tab')
  expect(field.textContent).toBe('/clear ')
  expect(state.creates).toEqual([])
  for (const modifier of ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'] as const) {
    await edit(field, '/new')
    await key(field, 'Enter', { [modifier]: true })
    expect(state.creates).toEqual([])
    expect(field.textContent).toContain('\n')
  }
  await edit(field, '/new')
  await key(field, 'Enter', { isComposing: true })
  expect(state.creates).toEqual([])
})

test.each(['/clear foo', 'explain /clear', '/newer'])('%s retains ordinary submission', async draft => {
  const state = await mountCommands()
  const field = prompts(state.tree.container)[0]!
  await edit(field, draft)
  await act(async () => send(field).click())
  expect(state.creates).toEqual([])
  expect(state.submits[0]?.slice(0, 2)).toEqual(['origin', draft])
})

test.each(['unchanged', 'text', 'whitespace', 'failure', 'throw'] as const)('creation %s retains original attachments and compares exact draft', async outcome => {
  const state = await mountCommands({ delayed: true })
  const field = prompts(state.tree.container)[0]!
  // A file is prepared through the real pane callback and belongs to the origin.
  const attach = [...field.closest('form')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === 'Add attachment')
  if (!attach) throw new Error('Missing attachment control')
  await act(async () => attach.click())
  await act(async () => {
    attach.click()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  })
  expect(state.tree.container.querySelector('[aria-label="Remove sketch.png"]')).not.toBeNull()
  await act(async () => state.frame([{
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'origin',
    event: { type: 'message', message: { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000091',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Original conversation' }] } } as never },
  }]))
  const rowsBefore = [...state.tree.container.querySelectorAll('[data-row-key]')].map(row => row.textContent)
  await edit(field, '/clear')
  // Two events before React updates the pane also exercise the shell's synchronous guard.
  await act(async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    }
  })
  expect(state.creates).toHaveLength(1)
  const revised = outcome === 'text' ? 'intervening edit' : outcome === 'whitespace' ? '/clear ' : '/clear'
  if (revised !== '/clear') await edit(field, revised)
  await act(async () => {
    if (outcome === 'throw') state.creates[0]!.result.reject(new Error('creation broke'))
    else if (outcome === 'failure') state.creates[0]!.result.resolve({ ok: false, error: { code: 'spawn_failed', message: 'creation refused' } })
    else state.creates[0]!.result.resolve({ ok: true, value: descriptor('created-1') })
  })
  if (!['failure', 'throw'].includes(outcome)) await act(async () => selectTab(state.tree.container, 'origin').click())
  const original = prompts(state.tree.container)[0]!
  expect(original.textContent).toBe(outcome === 'unchanged' ? '' : revised)
  expect(state.tree.container.textContent).toContain('notes.txt')
  expect(state.tree.container.querySelector('[aria-label="Remove sketch.png"]')).not.toBeNull()
  expect([...state.tree.container.querySelectorAll('[data-row-key]')].map(row => row.textContent)).toEqual(rowsBefore)
  expect(state.submits).toEqual([])
  expect(state.otherActions).toEqual([])
})

test.each([false, true])('split creation follows its origin after focus changes (project=%s)', async leftProject => {
  const state = await mountCommands({ sessions: [descriptor('left', leftProject), descriptor('right')], delayed: true })
  const [left, right] = prompts(state.tree.container)
  expect(left).toBeDefined(); expect(right).toBeDefined()
  await edit(left!, '/clear'); await key(left!)
  await act(async () => right!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await edit(right!, '/new'); await key(right!)
  expect(state.creates).toHaveLength(2)
  expect(state.creates.map(call => call.origin)).toEqual([leftProject ? 'left' : null, null])
  await act(async () => state.creates[0]!.result.resolve({ ok: true, value: descriptor('created-left') }))
  expect(JSON.parse(window.localStorage.getItem('catcode.workspaceLayout.v1')!).panels).toEqual(['created-left', 'right'])
  await act(async () => state.creates[1]!.result.resolve({ ok: true, value: descriptor('created-right') }))
  expect(JSON.parse(window.localStorage.getItem('catcode.workspaceLayout.v1')!).panels).toEqual(['created-left', 'created-right'])
  expect(state.submits).toEqual([])
})

test('a removed origin panel uses the current focus fallback', async () => {
  const state = await mountCommands({ sessions: [descriptor('left', true), descriptor('right')], delayed: true })
  const left = prompts(state.tree.container)[0]!
  await edit(left, '/new'); await key(left)
  const close = state.tree.container.querySelector<HTMLButtonElement>('[aria-label^="Close panel 1"]')
  if (!close) throw new Error('Missing panel close')
  await act(async () => close.click())
  await act(async () => state.creates[0]!.result.resolve({ ok: true, value: descriptor('created-1', true) }))
  expect(state.creates[0]!.origin).toBe('left')
  expect(JSON.parse(window.localStorage.getItem('catcode.workspaceLayout.v1')!).panels).toEqual(['created-1'])
  expect(state.otherActions).toEqual([])
})

test('old descriptors without binding retain the project fallback', async () => {
  const old = descriptor('legacy', true)
  delete old.binding
  const state = await mountCommands({ sessions: [old] })
  const field = prompts(state.tree.container)[0]!
  await edit(field, '/clear'); await key(field)
  expect(state.creates.map(call => call.origin)).toEqual(['legacy'])
  expect(state.submits).toEqual([])
})

test('a paste added during creation stays in the origin draft after success', async () => {
  const state = await mountCommands({ delayed: true })
  const field = prompts(state.tree.container)[0]!
  await edit(field, '/new'); await key(field)
  const data = new DataTransfer()
  data.setData('text/plain', 'a long pasted line\n'.repeat(30))
  await act(async () => field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })))
  expect(field.querySelector('[aria-label="Remove pasted text 1"]')).not.toBeNull()
  const draft = field.textContent
  await act(async () => state.creates[0]!.result.resolve({ ok: true, value: descriptor('created-1') }))
  await act(async () => selectTab(state.tree.container, 'origin').click())
  const original = prompts(state.tree.container)[0]!
  expect(original.textContent).toBe(draft)
  expect(original.querySelector('[aria-label="Remove pasted text 1"]')).not.toBeNull()
  expect(state.submits).toEqual([])
})
