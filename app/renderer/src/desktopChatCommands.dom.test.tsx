import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, type ComponentProps } from 'react'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { CatCodeBridge } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); Reflect.deleteProperty(window, 'catcode') })
afterAll(async () => { await harness.teardown() })
const origin: SessionDescriptor = {
  appSessionId: 'session-1', engineSessionId: null, cwd: '/tmp/project', title: null,
  forked: false, titleUpdatedAt: null, status: 'ready', restorable: false, parked: false,
  createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null, binding: { kind: 'project' },
}
type PaneProps = ComponentProps<typeof SessionPane>

async function mountPane(over: Partial<PaneProps> = {}) {
  let submits = 0
  let engagements = 0
  const tree = await harness.mount(<SessionPane {...idleSessionPaneProps()}
    activeDescriptor={origin} prompt="/clear" submit={event => { event.preventDefault(); submits++ }}
    onPreviewEngage={() => { engagements++ }} {...over} />)
  const field = tree.container.querySelector<HTMLElement>('[aria-label="Prompt"]')!
  const form = field.closest('form')!
  const enter = async () => act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  const formSubmit = async () => act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  return { tree, field, form, enter, formSubmit, submits: () => submits, engagements: () => engagements }
}

const conflicts: Array<[string, Partial<PaneProps>]> = [
  ['missing origin', { activeDescriptor: undefined }],
  ['missing session', { activeSessionId: null }],
  ['held prompt', { pendingSubmit: { text: 'waiting', images: [], file: null, showQueuedRow: true } }],
  ['engine queue', { queuedPrompts: [{ id: 'queued', text: 'waiting' }] }],
  ['project route', { projectRoute: { appSessionId: 'session-1', submitId: 'pending', phase: 'checking', text: 'waiting', projectName: null, message: null } }],
  ['branch switch', { branchSwitchPending: true }],
  ['moving descriptor', { activeDescriptor: { ...origin, moving: true } }],
  ['workspace movement', { activeDescriptor: { ...origin, workspaceMove: { id: 'move', phase: 'moving', target: { kind: 'project', name: 'target', path: '/tmp/target' } } } }],
  ['same-origin creation', { desktopCommandPending: true }],
]

test.each(conflicts)('local Enter and Send both refuse %s', async (_name, props) => {
  const state = await mountPane(props)
  const send = state.form.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')
  if (send) expect(send.disabled).toBe(true)
  await state.enter()
  // Submit events can be dispatched even when the button is disabled: the form must gate too.
  await state.formSubmit()
  expect(state.submits()).toBe(0)
  expect(state.field.textContent).toBe('/clear')
})

test.each(['starting', 'connecting', 'parked', 'dead', 'ready'] as const)('local commands work with %s connection without submit motion or restore', async status => {
  const state = await mountPane({ activeConnection: { status, inputEnabled: false }, preview: status === 'parked' })
  const send = state.form.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!
  expect(send).not.toBeNull(); expect(send.disabled).toBe(false)
  await state.enter()
  await act(async () => send.click())
  expect(state.submits()).toBe(2)
  expect(state.engagements()).toBe(0)
  expect(state.tree.container.querySelector('.composer-ghost, .animate-composer-glyph-out')).toBeNull()
  expect(document.querySelector('.send-flight')).toBeNull()
})

test.each(['file', 'image'] as const)('attachment preparation for %s blocks commands until completion', async kind => {
  let finish!: (value: Awaited<ReturnType<CatCodeBridge['pickAttachmentFile']>>) => void
  let attached!: () => void
  const completed = new Promise<void>(resolve => { attached = resolve })
  window.catcode = { pickAttachmentFile: () => new Promise(resolve => { finish = resolve }) } as unknown as CatCodeBridge
  const state = await mountPane({ onAttachFile: attached, onAttachImage: attached })
  const attach = state.form.querySelector<HTMLButtonElement>('[aria-label="Add attachment"]')!
  await act(async () => { attach.click() })
  await state.enter(); await state.formSubmit()
  expect(state.submits()).toBe(0)
  await act(async () => {
    finish(kind === 'file'
      ? { kind: 'file', token: 'token', name: 'notes.txt' }
      : { kind: 'image', bytes: new Uint8Array([1]), mediaType: 'image/png', name: 'image.png' })
    await completed
  })
  await state.enter()
  expect(state.submits()).toBe(1)
})

test('an unavailable managed folder blocks both command entry points', async () => {
  window.catcode = { getSessionFolderState: async () => ({ ok: true, value: 'missing' }) } as unknown as CatCodeBridge
  const state = await mountPane({ activeDescriptor: { ...origin, binding: { kind: 'managed', storageRootId: 'root', storageId: 'chat' } } })
  await state.enter(); await state.formSubmit()
  expect(state.submits()).toBe(0)
  expect(state.tree.container.textContent).toContain('Recreate')
})
