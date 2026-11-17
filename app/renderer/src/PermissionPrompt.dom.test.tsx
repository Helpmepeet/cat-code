import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { PermissionPrompt } from './PermissionPrompt.js'
import { PermissionQueue } from './PermissionQueue.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { PermissionRequest } from './permissionState.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const command = './scripts/check.sh --channel beta\nprintf "finished\\n"\n'
const request: PermissionRequest = {
  requestId: 'command-approval',
  request: {
    subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'shell-1',
    input: { command, description: 'Check the beta build' },
    permission_suggestions: [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: command }] },
      { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'git add:*' }, { toolName: 'Bash', ruleContent: 'git commit:*' }] },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  },
}

async function key(target: EventTarget, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra })
  await act(async () => { target.dispatchEvent(event) })
  return event
}
async function settleFocus() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

function button(container: HTMLElement, name: string) {
  const result = [...container.querySelectorAll('button')].find(node => (node.querySelector('span')?.textContent ?? node.textContent)?.trim() === name)
  if (!result) throw new Error(`Missing ${name} button`)
  return result
}

test('Run applies precisely the checked engine suggestion indices by mouse and keyboard', async () => {
  const allowed: number[][] = []
  const view = () => <PermissionPrompt keyboardTarget request={request} onAllow={indices => allowed.push(indices)} onDeny={() => {}} />
  const tree = await harness.mount(view())
  await settleFocus()
  const boxes = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes).toHaveLength(3)
  expect(boxes.map(box => box.getAttribute('aria-label'))).toEqual([
    'Always allow this exact command in Project settings (local)',
    'Always allow git add:*, git commit:* in User settings',
    'Switch to Accept edits in This session',
  ])
  expect(boxes.every(box => !box.checked)).toBe(true)
  await act(async () => { boxes[0]!.click(); boxes[2]!.click() })
  await act(async () => { button(tree.container, 'Run').click() })
  expect(allowed).toEqual([[0, 2]])
  // Rerendering during streaming must preserve the operator's selection.
  await tree.render(view())
  await act(async () => { boxes[0]!.click(); boxes[1]!.click(); tree.container.querySelector<HTMLElement>('section')!.focus() })
  await key(harness.document, 'Enter')
  expect(allowed).toEqual([[0, 2], [1, 2]])
})

test('decision keys deny, repeat and unrelated navigation pass through, and checkbox focus owns its keys', async () => {
  const allowed: number[][] = []
  let denied = 0
  const tree = await harness.mount(<PermissionPrompt keyboardTarget request={request} onAllow={indices => allowed.push(indices)} onDeny={() => { denied++ }} />)
  await settleFocus()
  for (const unused of ['ArrowUp', 'ArrowDown', '1', '2', '9', 'j', 'k']) {
    expect((await key(harness.document, unused)).defaultPrevented).toBe(false)
  }
  for (const unused of ['p', 'n']) expect((await key(harness.document, unused, { ctrlKey: true })).defaultPrevented).toBe(false)
  for (const decision of ['Enter', 'Escape', 'n', 'Backspace']) {
    expect((await key(harness.document, decision, { repeat: true })).defaultPrevented).toBe(false)
  }
  for (const deny of ['Escape', 'n', 'N', 'Backspace']) expect((await key(harness.document, deny)).defaultPrevented).toBe(true)
  expect(denied).toBe(4)
  expect(allowed).toEqual([])
  const checkbox = tree.container.querySelector<HTMLInputElement>('input')!
  await act(async () => { checkbox.focus() })
  expect(tree.container.textContent).not.toContain('↵')
  for (const owned of ['Enter', 'Escape', ' ']) expect((await key(checkbox, owned)).defaultPrevented).toBe(false)
  expect(denied).toBe(4)
  expect(allowed).toEqual([])
})

test('Deny never applies checked suggestions and submitted decisions disable every answer and hint', async () => {
  const allowed: number[][] = []
  let denied = 0, snoozed = 0
  const view = (submitted = false) => <PermissionPrompt keyboardTarget request={request} submitted={submitted} onAllow={indices => allowed.push(indices)} onDeny={() => { denied++ }} onSnooze={() => { snoozed++ }} />
  const tree = await harness.mount(view())
  await settleFocus()
  await act(async () => { tree.container.querySelector<HTMLInputElement>('input')!.click(); button(tree.container, 'Deny').click() })
  expect(denied).toBe(1)
  expect(allowed).toEqual([])
  await act(async () => { button(tree.container, 'Later').click() })
  expect(snoozed).toBe(1)
  await tree.render(view(true))
  expect([...tree.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, .command-permission-actions button, .command-permission-later')].every(node => node.disabled)).toBe(true)
  expect(tree.container.textContent).not.toContain('↵')
  expect(tree.container.textContent).not.toContain('esc')
  await key(harness.document, 'Enter')
  await key(harness.document, 'Escape')
  expect(allowed).toEqual([])
  expect(denied).toBe(1)
})

test('a mixed pending queue answers only the keyboard target and retains non-command row navigation', async () => {
  const read: PermissionRequest = { requestId: 'read', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/repo/file' }, tool_use_id: 'read-1' } }
  const allowed: [string, number[]][] = []
  const items = [request, read].map(request => ({ request, submitted: false, dismissed: false }))
  const view = (target: string) => <PermissionQueue items={items} keyboardTargetRequestId={target} onAllow={(id, indices) => allowed.push([id, indices])} onDeny={() => {}} onRestore={() => {}} />
  const tree = await harness.mount(view(request.requestId))
  await settleFocus()
  await key(harness.document, 'Enter')
  expect(allowed).toEqual([[request.requestId, []]])
  await tree.render(view(read.requestId))
  await settleFocus()
  expect((await key(harness.document, 'ArrowDown')).defaultPrevented).toBe(true)
  expect(tree.container.querySelector('[aria-current="true"]')?.textContent).toContain('No')
  await key(harness.document, '1')
  expect(allowed).toEqual([[request.requestId, []], [read.requestId, []]])
})

test('folding measures wrapped rendered height, survives expansion and resizes without remeasuring on streamed renders', async () => {
  // Happy DOM has no layout engine. Supply only browser geometry and observer
  // delivery; the real component decides the fold, count and expanded state.
  const originalStyle = globalThis.getComputedStyle
  const style = spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const value = originalStyle(node, pseudo)
    return node.tagName === 'PRE' ? new Proxy(value, { get: (target, prop) => prop === 'lineHeight' ? '20px' : Reflect.get(target, prop, target) }) : value
  })
  let height = 240, measurements = 0
  const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    measurements++
    return { height, width: 400, top: 0, left: 0, bottom: height, right: 400, x: 0, y: 0, toJSON() {} }
  })
  const previousObserver = globalThis.ResizeObserver
  const observers: { callback: ResizeObserverCallback; target: Element | null }[] = []
  globalThis.ResizeObserver = class {
    entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, target: null }; observers.push(this.entry) }
    observe(target: Element) { this.entry.target = target }
    disconnect() { this.entry.target = null }
    unobserve() {}
  } as unknown as typeof ResizeObserver
  try {
    const singleLine = { ...request, request: { ...request.request, input: { command: 'echo ' + 'a'.repeat(1200) }, permission_suggestions: [] } }
    const view = () => <PermissionPrompt request={singleLine} onAllow={() => {}} onDeny={() => {}} />
    const tree = await harness.mount(view())
    const resize = async (next: number) => { height = next; await act(async () => { for (const observer of observers) if (observer.target) observer.callback([], {} as ResizeObserver) }) }
    expect(tree.container.textContent).not.toContain('Show ')
    await resize(260)
    const more = button(tree.container, 'Show 1 more line')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { more.click() })
    expect(button(tree.container, 'Show less').getAttribute('aria-expanded')).toBe('true')
    expect(tree.container.querySelector('pre code')!.textContent).toContain('a'.repeat(1200))
    await resize(540)
    await act(async () => { button(tree.container, 'Show less').click() })
    expect(button(tree.container, 'Show 15 more lines')).toBeDefined()
    await harness.nextFrame()
    const before = measurements
    await tree.render(view())
    expect(measurements).toBe(before)
    await resize(240)
    expect(tree.container.textContent).not.toContain('Show ')
    await tree.unmount()
    expect(observers.every(observer => observer.target === null)).toBe(true)
  } finally { globalThis.ResizeObserver = previousObserver; style.mockRestore(); bounds.mockRestore() }
})

test('destination disappears before the rule truncates and returns on widening; tooltip stays complete', async () => {
  const originalObserver = globalThis.ResizeObserver
  const observers: { callback: ResizeObserverCallback; target: Element | null }[] = []
  globalThis.ResizeObserver = class {
    entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, target: null }; observers.push(this.entry) }
    observe(target: Element) { this.entry.target = target }
    disconnect() { this.entry.target = null }
    unobserve() {}
  } as unknown as typeof ResizeObserver
  try {
    const tree = await harness.mount(<PermissionPrompt request={request} onAllow={() => {}} onDeny={() => {}} />)
    const label = tree.container.querySelectorAll('label')[1]!
    const rule = label.querySelector('code')!
    const destination = label.querySelector<HTMLElement>('.command-permission-destination')!
    let available = 100
    Object.defineProperty(rule, 'scrollWidth', { configurable: true, get: () => 160 })
    Object.defineProperty(rule, 'clientWidth', { configurable: true, get: () => destination.hidden ? 180 : available })
    const resize = async () => { await act(async () => { for (const observer of observers) if (observer.target === label) observer.callback([], {} as ResizeObserver) }) }
    await resize()
    expect(destination.hidden).toBe(true)
    expect(label.title).toBe('Always allow git add:*, git commit:* in User settings')
    expect(rule.textContent).toBe('git add:*, git commit:*')
    available = 200
    await resize()
    expect(destination.hidden).toBe(false)
  } finally { globalThis.ResizeObserver = originalObserver }
})

test('copy uses the complete original command and the shared copied check state', async () => {
  const write = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  try {
    const tree = await harness.mount(<PermissionPrompt request={request} onAllow={() => {}} onDeny={() => {}} />)
    await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click() })
    expect(write.mock.calls).toEqual([[command]])
    expect(tree.container.querySelector('[aria-label="Code copied"]')).not.toBeNull()
  } finally { write.mockRestore() }
})
