import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { ExternalLinkRecovery } from './ExternalLinkRecovery.js'
import { RemoteSettingsPage } from './RemoteSettingsPage.js'
import { ToastContext } from './toastContext.js'
import { ToastHost } from './ToastHost.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'
import { readPromptDraftsFromStorage, writePromptDraftsToStorage } from './promptDraftPersistence.js'
import type { PromptDraftState } from './appModel.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previousBridge })
afterAll(async () => { await harness.teardown() })

for (const outcome of ['false', 'reject', 'throw', 'success'] as const) {
  test(`external opener ${outcome} preserves intercepted navigation and exposes copy fallback`, async () => {
    let opens = 0
    window.catcode = { openExternalUrl: () => {
      opens++
      if (outcome === 'throw') throw new Error('local refusal')
      return outcome === 'reject' ? Promise.reject(new Error('OS failure')) : Promise.resolve(outcome === 'success')
    } } as unknown as typeof window.catcode
    const tree = await harness.mount(<ToastHost><ExternalLinkRecovery /><a href="https://example.test/path">Document</a></ToastHost>)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    await act(async () => { tree.container.querySelector('a')!.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(opens).toBe(1)
    if (outcome === 'success') { expect(tree.container.querySelector('[aria-label="Notifications"]')).toBeNull(); return }
    expect(tree.container.textContent).toContain('Could not open this link. Click to copy it.')
    expect(tree.container.textContent).not.toContain('https://example.test/path')
    expect(tree.container.querySelector('textarea')).toBeNull()
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    await act(async () => { tree.container.querySelector('button')!.click() })
    expect(tree.container.textContent).toContain('Could not copy this link. Click to try again.')
    expect(tree.container.textContent).not.toContain('Link copied.')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
    await act(async () => { tree.container.querySelector('button')!.click() })
    expect(copied).toEqual(['https://example.test/path'])
    expect(tree.container.textContent).toContain('Link copied.')
    await act(async () => { tree.container.querySelector('button')!.click() })
    expect(tree.container.querySelector('[aria-label="Notifications"]')).toBeNull()
  })
}

test('external links intercept middle clicks but leave unsafe, download, selected and prevented links alone', async () => {
  const opened: string[] = []
  window.catcode = { openExternalUrl: async (url: string) => { opened.push(url); return false } } as unknown as typeof window.catcode
  const tree = await harness.mount(<ToastHost><ExternalLinkRecovery />
    <a href="https://example.test/middle">Middle</a>
    <a href="javascript:alert(1)">Unsafe</a>
    <a href="https://example.test/download" download>Download</a>
    <a href="https://example.test/selected">Selected</a>
  </ToastHost>)
  const anchors = tree.container.querySelectorAll('a')
  const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  await act(async () => { anchors[0]!.dispatchEvent(middle) })
  expect(middle.defaultPrevented).toBe(true)
  expect(opened).toEqual(['https://example.test/middle'])
  for (const anchor of [anchors[1]!, anchors[2]!]) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { anchor.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  }
  const prevented = new MouseEvent('click', { bubbles: true, cancelable: true })
  prevented.preventDefault()
  await act(async () => { anchors[0]!.dispatchEvent(prevented) })
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(anchors[3]!)
  selection.removeAllRanges()
  selection.addRange(range)
  try {
    const selected = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { anchors[3]!.dispatchEvent(selected) })
    expect(selected.defaultPrevented).toBe(false)
  } finally {
    selection.removeAllRanges()
  }
  expect(opened).toEqual(['https://example.test/middle'])
})

test('last-good draft survives oversized replacement', () => {
  const storage = memoryStorage()
  writePromptDraftsToStorage(storage, { session: 'last good' } as PromptDraftState)
  const result = writePromptDraftsToStorage(storage, { session: 'x'.repeat(20001) } as PromptDraftState)
  expect(result.session!.status).toBe('stale')
  expect(readPromptDraftsFromStorage(storage)).toEqual({ session: 'last good' })
})

test('local remote-settings refusal settles both pending controls and preserves server input', async () => {
  const notices: string[] = []
  let sends = 0
  const tree = await harness.mount(<ToastContext.Provider value={message => { notices.push(message) }}>
    <RemoteSettingsPage snapshot={{ bridge: { enabled: false, error: null, transport: 'v1' }, commandFilter: { skillSafe: [], optIn: [], blocked: [] } }} lastResult={null} onVerb={() => { sends++; throw new Error('Too many requests at once. Wait a moment and try again.') }} />
  </ToastContext.Provider>)
  const toggle = tree.container.querySelector<HTMLButtonElement>('button')!
  await act(async () => { toggle.click() })
  expect(toggle.disabled).toBe(false)
  expect(notices.join(' ')).toContain('Could not send')
  const input = tree.container.querySelector('input')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'wss://remote.example.test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { tree.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(sends).toBe(2)
  expect(tree.container.textContent).not.toContain('Connecting…')
  expect(input.value).toBe('wss://remote.example.test')
})

test('unknown remote mutation is not repeated and only its exact result releases the control', async () => {
  let requestId = ''
  let sends = 0
  const snapshot = { bridge: { enabled: false, error: null, transport: 'v1' as const }, commandFilter: { skillSafe: [], optIn: [], blocked: [] } }
  const onVerb = (verb: import('../../shared/protocol.js').RemoteVerbMessage) => { sends++; requestId = verb.requestId; throw new Error('Uncertain transport error') }
  const tree = await harness.mount(<RemoteSettingsPage snapshot={snapshot} lastResult={null} onVerb={onVerb} />)
  const toggle = tree.container.querySelector<HTMLButtonElement>('button')!
  await act(async () => { toggle.click(); toggle.click() })
  expect(sends).toBe(1)
  expect(toggle.disabled).toBe(true)
  const result = { kind: 'remoteSettings.result' as const, protocolVersion: PROTOCOL_VERSION, sessionId: 'fixture', requestId: 'stale', verb: 'remoteSettings.bridgeToggle' as const, ok: true, message: 'Updated' }
  await tree.render(<RemoteSettingsPage snapshot={snapshot} lastResult={result} onVerb={onVerb} />)
  expect(toggle.disabled).toBe(true)
  await tree.render(<RemoteSettingsPage snapshot={snapshot} lastResult={{ ...result, requestId }} onVerb={onVerb} />)
  expect(toggle.disabled).toBe(false)
})
