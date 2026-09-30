import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { SessionDescriptor, HostEvent } from '../../shared/hostApi.js'
import type { CatCodeBridge } from '../../shared/protocol.js'

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
] as const)('New chat via %s with %s active uses the matching chat context without a picker', async (entry, context) => {
  let managedChats = 0
  let folderPicks = 0
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
    pickDirectory: async () => {
      folderPicks += 1
      return null
    },
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  if (entry === 'sidebar') {
    await act(async () => {
      tree.container.querySelector<HTMLButtonElement>('button[aria-label="Pin sidebar open"]')!.click()
    })
  }
  const button = tree.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')
  expect(button).not.toBeNull()
  await act(async () => {
    if (entry === 'shortcut') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))
    } else if (entry === 'sidebar') {
      const newChat = [...tree.container.querySelectorAll('button')].find(
        button => button.textContent?.includes('New chat') && !button.hasAttribute('aria-label'),
      )
      expect(newChat).toBeDefined()
      newChat!.click()
    } else button!.click()
  })
  expect(managedChats).toBe(context === 'project' ? 0 : 1)
  expect(workspaceCreates).toEqual(context === 'project' ? ['existing-chat'] : [])
  expect(folderPicks).toBe(0)
  expect(tree.container.querySelector('[aria-label="Prompt"]')).not.toBeNull()
  expect(tree.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Normal chat')
})
