import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { RoutingStorageRecovery } from './RoutingStorageRecovery.js'
import type { RoutingStorageHealth } from '../../shared/projectRouting.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const blocked = { status: 'blocked', code: 'routing_storage_unreadable' } as const
function button(root: HTMLElement, label: string) {
  const found = [...root.querySelectorAll('button')].find(row => row.textContent === label)
  if (!found) throw new Error(`Missing ${label}`)
  return found
}

test('global notice needs no session snapshots and preserves the exact draft when copying', async () => {
  const draft = '  unsent\nprivate draft  '
  const copied: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  try {
    const tree = await harness.mount(<RoutingStorageRecovery health={blocked} draft={draft} onRevalidate={async () => blocked} onInspect={async () => {}} />)
    expect(tree.container.textContent).toContain('Sending is paused')
    await act(async () => { button(tree.container, 'Copy draft').click() })
    expect(copied).toEqual([draft])
    expect(tree.container.textContent).toContain('Draft copied.')
    expect(tree.container.textContent).not.toContain(draft)
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('revalidate is explicit, single-flight, and a failed check leaves the notice actionable', async () => {
  let calls = 0
  let finish!: (health: RoutingStorageHealth) => void
  const tree = await harness.mount(<RoutingStorageRecovery health={blocked} draft="draft" onRevalidate={() => { calls++; return new Promise(resolve => { finish = resolve }) }} onInspect={async () => {}} />)
  expect(calls).toBe(0)
  await act(async () => {
    const check = button(tree.container, 'Check repaired file')
    check.click(); check.click()
  })
  expect(calls).toBe(1)
  expect(button(tree.container, 'Checking…').disabled).toBe(true)
  await act(async () => { finish(blocked) })
  expect(tree.container.textContent).toContain('Sending remains paused.')
  expect(button(tree.container, 'Check repaired file').disabled).toBe(false)
})

test('draft export uses exact text without calling repair or sending input', async () => {
  const draft = '  draft\nwith spacing  '
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalClick = HTMLAnchorElement.prototype.click
  let exported: Blob | undefined
  let download = ''
  let repairs = 0
  URL.createObjectURL = blob => { exported = blob as Blob; return 'blob:synthetic-draft' }
  URL.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function () { download = this.download }
  try {
    const tree = await harness.mount(<RoutingStorageRecovery health={blocked} draft={draft} onRevalidate={async () => { repairs++; return blocked }} onInspect={async () => {}} />)
    await act(async () => { button(tree.container, 'Export draft').click() })
    expect(await exported?.text()).toBe(draft)
    expect(download).toBe('cat-code-draft.txt')
    expect(repairs).toBe(0)
  } finally {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    HTMLAnchorElement.prototype.click = originalClick
  }
})

test('synchronous callback failures are curated and healthy state removes the notice', async () => {
  const tree = await harness.mount(<RoutingStorageRecovery health={blocked} draft="draft" onRevalidate={() => { throw new Error('/private/raw') }} onInspect={() => { throw new Error('/private/raw') }} />)
  await act(async () => { button(tree.container, 'Check repaired file').click() })
  expect(tree.container.textContent).toContain('Could not check')
  await act(async () => { button(tree.container, 'Show saved message file').click() })
  expect(tree.container.textContent).toContain('Could not show')
  expect(tree.container.textContent).not.toContain('/private/raw')
  await tree.render(<RoutingStorageRecovery health={{ status: 'healthy', code: null }} draft="draft" onRevalidate={async () => blocked} onInspect={async () => {}} />)
  expect(tree.container.textContent).toBe('')
})

for (const change of ['edit', 'session']) test(`copy completion and existing notice cannot follow a draft ${change}`, async () => {
  let finish!: () => void
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finish = resolve }) } })
  const props = { health: blocked, onRevalidate: async () => blocked, onInspect: async () => {} }
  try {
    const tree = await harness.mount(<RoutingStorageRecovery {...props} draft="draft A" draftIdentity="session A" />)
    await act(async () => { button(tree.container, 'Copy draft').click() })
    const next = { draft: change === 'edit' ? 'draft B' : 'draft A', draftIdentity: change === 'edit' ? 'session A' : 'session B' }
    await tree.render(<RoutingStorageRecovery {...props} {...next} />)
    await act(async () => { finish() })
    expect(tree.container.textContent).not.toContain('Draft copied.')
    await act(async () => { button(tree.container, 'Copy draft').click() })
    await act(async () => { finish() })
    expect(tree.container.textContent).toContain('Draft copied.')
    await tree.render(<RoutingStorageRecovery {...props} draft="new draft" draftIdentity="session C" />)
    expect(tree.container.textContent).not.toContain('Draft copied.')
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('late clipboard failure cannot warn for a different draft or an unmounted recovery panel', async () => {
  let fail!: (error: Error) => void
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>((_resolve, reject) => { fail = reject }) } })
  const props = { health: blocked, onRevalidate: async () => blocked, onInspect: async () => {} }
  try {
    const tree = await harness.mount(<RoutingStorageRecovery {...props} draft="A" draftIdentity="session A" />)
    await act(async () => { button(tree.container, 'Copy draft').click() })
    await tree.render(<RoutingStorageRecovery {...props} draft="B" draftIdentity="session B" />)
    await act(async () => { fail(new Error('Clipboard refused old draft')) })
    expect(tree.container.textContent).not.toContain('Could not copy')
    await act(async () => { button(tree.container, 'Copy draft').click() })
    await tree.unmount()
    await act(async () => { fail(new Error('Clipboard refused after unmount')) })
    expect(tree.container.textContent).toBe('')
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
