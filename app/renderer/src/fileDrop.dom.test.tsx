import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { SessionPane } from './SessionPane.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { ToastContext } from './toastContext.js'
import type { CatCodeBridge } from '../../shared/protocol.js'

let harness: DomTestHarness
let original: PropertyDescriptor | undefined
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  if (original) Object.defineProperty(window, 'catcode', original)
  else Reflect.deleteProperty(window, 'catcode')
})
afterAll(async () => { await harness.teardown() })

test('dropped files use the picker selection path, clear retry blocking and show folder errors', async () => {
  original = Object.getOwnPropertyDescriptor(window, 'catcode')
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
  let rejectFolder = false
  const calls: unknown[] = []
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    dropAttachmentFile: async (sessionId: string, dropped: File) => {
      expect(sessionId).toBe('session-1')
      expect(dropped).toBe(file)
      return rejectFolder
        ? { kind: 'error', message: 'Choose a readable file, not a folder, and try again.' }
        : { kind: 'file', name: 'notes.txt', token: 'main-owned-token' }
    },
  } as unknown as CatCodeBridge })
  const tree = await harness.mount(<SessionPane {...idleSessionPaneProps()} isActivePane
    onAttachFile={selection => calls.push(selection)}
    onRetryBlockChange={(id, reason, blocked) => { if (reason === 'attachment') calls.push([id, reason, blocked]) }}
  />)
  async function drop() {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: {
      files: [file], items: [{ kind: 'file', type: file.type }], types: ['Files'], getData: () => '',
    } })
    await act(async () => { window.dispatchEvent(event) })
  }
  await drop()
  expect(calls).toEqual([
    ['session-1', 'attachment', true],
    { name: 'notes.txt', token: 'main-owned-token' },
    ['session-1', 'attachment', false],
  ])
  calls.length = 0
  rejectFolder = true
  await drop()
  expect(calls).toEqual([
    ['session-1', 'attachment', true], ['session-1', 'attachment', false],
  ])
  expect(tree.container.textContent).toContain('Choose a readable file, not a folder, and try again.')
})

test('a file dropped while another is attaching is refused out loud, not dropped silently', async () => {
  original = Object.getOwnPropertyDescriptor(window, 'catcode')
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
  let release: (value: unknown) => void = () => {}
  let bridgeCalls = 0
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    dropAttachmentFile: () => {
      bridgeCalls++
      return new Promise(resolve => { release = resolve })
    },
  } as unknown as CatCodeBridge })
  const toasts: string[] = []
  await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
    <SessionPane {...idleSessionPaneProps()} isActivePane />
  </ToastContext.Provider>)
  async function drop() {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: {
      files: [file], items: [{ kind: 'file', type: file.type }], types: ['Files'], getData: () => '',
    } })
    await act(async () => { window.dispatchEvent(event) })
  }
  await drop()
  await drop()
  expect(bridgeCalls).toBe(1)
  expect(toasts).toEqual(['Wait for the file to finish attaching.'])
  await act(async () => { release({ kind: 'file', name: 'notes.txt', token: 't' }) })
  await drop()
  expect(bridgeCalls).toBe(2)
})
