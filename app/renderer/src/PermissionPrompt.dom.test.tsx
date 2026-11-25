import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { MAX_SUGGESTION_SELECTIONS } from '../../shared/limits.js'
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
    `Always allow ${command} in Project settings (local)`,
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

test('a command can save up to the transport limit, and can change its selection before Run', async () => {
  const allowed: number[][] = []
  const permission: PermissionRequest = {
    ...request,
    request: {
      ...request.request,
      tool_name: 'PowerShell',
      permission_suggestions: Array.from({ length: MAX_SUGGESTION_SELECTIONS + 1 }, (_, index) => ({
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'PowerShell', ruleContent: `Get-Item report-${index}.txt` }],
      })),
    },
  }
  const tree = await harness.mount(<PermissionPrompt request={permission} onAllow={indices => allowed.push(indices)} onDeny={() => {}} />)
  const boxes = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  const lastBox = boxes[MAX_SUGGESTION_SELECTIONS]!
  await act(async () => { for (const box of boxes.slice(0, MAX_SUGGESTION_SELECTIONS)) box.click() })
  expect(lastBox.disabled).toBe(true)
  expect(tree.container.querySelector('[role="status"]')?.textContent).toContain(String(MAX_SUGGESTION_SELECTIONS))
  await act(async () => { lastBox.click() })
  expect(lastBox.checked).toBe(false)
  await act(async () => { boxes[0]!.click() })
  expect(lastBox.disabled).toBe(false)
  await act(async () => { lastBox.click() })
  await act(async () => { button(tree.container, 'Run').click() })
  expect(allowed).toEqual([Array.from({ length: MAX_SUGGESTION_SELECTIONS }, (_, index) => index + 1)])
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
  expect(button(tree.container, 'Run').textContent).not.toContain('↵')
  expect(button(tree.container, 'Deny').textContent).not.toContain('esc')
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
    const pre = tree.container.querySelector('pre')!
    pre.scrollTop = 180
    await act(async () => { button(tree.container, 'Show less').click() })
    expect(pre.scrollTop).toBe(0)
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

test('the footer discloses full command input without answering the request', async () => {
  const input = { command, description: 'Check the beta build', dangerouslyDisableSandbox: true }
  const approval = { ...request, request: { ...request.request, input, permission_suggestions: [] } }
  let allowed = 0, denied = 0
  const tree = await harness.mount(<PermissionPrompt keyboardTarget request={approval} onAllow={() => { allowed++ }} onDeny={() => { denied++ }} />)
  await settleFocus()
  expect(tree.container.textContent).toContain('Requested to run outside the Bash sandbox.')
  const toggle = button(tree.container, 'Full input')
  expect(toggle.parentElement?.contains(button(tree.container, 'Run'))).toBe(true)
  const panel = harness.document.getElementById(toggle.getAttribute('aria-controls')!)!
  expect(panel.hidden).toBe(true)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { toggle.focus() })
  expect(harness.document.activeElement).toBe(toggle)
  expect((await key(toggle, 'Enter')).defaultPrevented).toBe(false)
  // Happy DOM does not synthesize native keyboard activation from keydown.
  await act(async () => { toggle.click() })
  expect(panel.hidden).toBe(false)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(JSON.parse(panel.textContent!)).toEqual(input)
  await act(async () => { toggle.click() })
  expect(panel.hidden).toBe(true)
  expect(allowed).toBe(0)
  expect(denied).toBe(0)
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

const editRequest: PermissionRequest = {
  requestId: 'edit-approval',
  request: {
    subtype: 'can_use_tool', tool_name: 'Edit', tool_use_id: 'edit-1',
    input: {
      file_path: '/repo/src/server.ts',
      old_string: 'const port = 3000\nstart(port)',
      new_string: 'const port = 8080\nstart(port)',
    },
    decision_reason: "Claude requested permissions to use Edit, but you haven't granted it yet.",
    permission_suggestions: [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/repo/src'], destination: 'localSettings' },
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Edit', ruleContent: '/src/server.ts' }], destination: 'userSettings' },
    ],
  },
}

test('one-action approval shows the exact input and offers only one-time approval or decline', async () => {
  const allowed: number[][] = []
  let declined = 0
  const { permission_suggestions: _suggestions, ...edit } = editRequest.request
  const reason = 'Auto Mode could not review this action because the request was too large. Target "/repo/src/server.ts". Approval applies to this action only.'
  const approval: PermissionRequest = { ...editRequest, request: {
    ...edit, title: 'Allow Edit once?', human_only: true, decision_reason: reason,
  } }
  const { container } = await harness.mount(<PermissionPrompt request={approval}
    onAllow={indices => allowed.push(indices)} onDeny={() => { declined++ }} />)
  expect(container.querySelector('h2')?.textContent).toBe(approval.request.title)
  expect(container.textContent).toContain(reason)
  expect(JSON.parse(container.querySelector('pre')!.textContent!)).toEqual(approval.request.input)
  const choices = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Response options"] button')]
  expect(choices).toHaveLength(2)
  expect(choices[0]?.textContent).toContain('Allow once')
  expect(choices[1]?.textContent).toContain('Decline')
  await act(async () => { choices[0]!.click(); choices[1]!.click() })
  expect(allowed).toEqual([[]])
  expect(declined).toBe(1)
})

test('Edit previews the file and its syntax-colored changes without a file gutter or generic controls', async () => {
  const { container } = await harness.mount(
    <PermissionPrompt request={editRequest} onAllow={() => {}} onDeny={() => {}} onSnooze={() => {}} />,
  )
  const path = container.querySelector('h2')!
  expect(path.textContent).toBe('Edit /repo/src/server.ts')
  expect(path.lastElementChild?.textContent).toBe('server.ts')
  expect(path.title).toBe('/repo/src/server.ts')
  expect(container.querySelector('.edit-permission-counts')?.textContent).toBe('+1−1')
  const rows = [...container.querySelectorAll('.edit-permission-diff-row')]
  expect(rows.map(row => [...row.children].map(child => child.textContent))).toEqual([
    ['−', 'const port = 3000'], ['+', 'const port = 8080'], [' ', 'start(port)'],
  ])
  expect(rows[0]?.querySelector('.hljs-keyword')?.textContent).toBe('const')
  expect(rows[1]?.querySelector('[class*="bg-tone-success"] .hljs-number')?.textContent).toBe('8080')
  expect([...container.querySelectorAll('button')].map(node => [node.textContent, node.title])).toEqual([
    ['Later', ''], ['Deny', 'Esc'], ['Apply', 'Enter'],
  ])
  expect(container.querySelector('button svg, details, kbd, [aria-current]')).toBeNull()
})

test('Edit wraps into visual lines, folds at twelve, and recalculates on pane resize', async () => {
  // Happy DOM provides events but has no layout engine. Supply the source's
  // geometry as a browser would report it at the two pane widths.
  const getStyle = globalThis.getComputedStyle
  const style = spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const properties = getStyle(node, pseudo)
    return new Proxy(properties, { get: (target, prop) => prop === 'lineHeight' ? '20px' : Reflect.get(target, prop, target) })
  })
  let height = 240
  const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height, width: 556, top: 0, left: 0, bottom: height, right: 556, x: 0, y: 0, toJSON() {} }),
  )
  const previousObserver = globalThis.ResizeObserver
  let notifyResize: (() => void) | undefined
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this as unknown as ResizeObserver) }
    observe() {}
    disconnect() { notifyResize = undefined }
  } as unknown as typeof ResizeObserver

  try {
    const { container } = await harness.mount(<PermissionPrompt request={editRequest} onAllow={() => {}} onDeny={() => {}} />)
    expect(container.textContent).not.toContain('Show ')
    height = 280
    await act(async () => { notifyResize!() })
    const fold = button(container, 'Show 2 more lines')
    const scroller = harness.document.getElementById(fold.getAttribute('aria-controls')!)!
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fold.click() })
    expect(button(container, 'Show less').getAttribute('aria-expanded')).toBe('true')
    scroller.scrollTop = 40
    await act(async () => { button(container, 'Show less').click() })
    expect(scroller.scrollTop).toBe(0)
    expect(button(container, 'Show 2 more lines').getAttribute('aria-expanded')).toBe('false')
    height = 240
    await act(async () => { notifyResize!() })
    expect(container.textContent).not.toContain('Show ')
  } finally {
    globalThis.ResizeObserver = previousObserver
    style.mockRestore()
    bounds.mockRestore()
  }
})

test('Edit reasons open on hover and focus, pin on click, and Escape closes the tip before denying', async () => {
  const reason = 'The change needs your approval.'
  const toolRequest = { ...editRequest.request, permission_suggestions: [] }
  const requestWithReason = { ...editRequest, request: { ...toolRequest, decision_reason: reason } }
  let denied = 0
  const view = (request: PermissionRequest) => <PermissionPrompt keyboardTarget request={request} onAllow={() => {}} onDeny={() => { denied++ }} />
  const tree = await harness.mount(view(requestWithReason))
  await settleFocus()
  const mark = tree.container.querySelector<HTMLButtonElement>('[aria-label="Why approval is needed"]')!
  const host = tree.container.querySelector<HTMLElement>('section')!
  const tip = () => harness.document.querySelector('[role="tooltip"]')
  const hover = (enter: boolean) => act(async () => {
    mark.dispatchEvent(new MouseEvent(enter ? 'mouseover' : 'mouseout', { bubbles: true }))
  })

  expect(tree.container.textContent).not.toContain(reason)
  expect(tree.container.querySelector('input')).toBeNull()
  await hover(true)
  expect(tip()?.textContent).toContain(reason)
  await hover(false)
  expect(tip()).toBeNull()
  await hover(true)
  expect((await key(host, 'Escape')).defaultPrevented).toBe(true)
  expect(tip()).toBeNull()
  expect(denied).toBe(0)
  await act(async () => { mark.focus() })
  expect(mark.getAttribute('aria-describedby')).toBe(tip()!.id)
  await key(mark, 'Escape')
  expect(tip()).toBeNull()
  expect(denied).toBe(0)
  await act(async () => { host.focus() })
  await hover(true)
  await act(async () => { mark.click() })
  await hover(false)
  expect(tip()?.textContent).toBe('Why approval is needed' + reason)
  await key(host, 'Escape')
  expect(tip()).toBeNull()
  expect(denied).toBe(0)
  await key(host, 'Escape')
  expect(denied).toBe(1)

  await tree.render(view({ ...requestWithReason, request: { ...requestWithReason.request, human_only: true } }))
  const reviewed = tree.container.querySelector<HTMLButtonElement>('[aria-label="Auto mode requested your decision"]')!
  await act(async () => { reviewed.focus() })
  expect(tip()?.textContent).toBe('Auto mode requested your decision' + reason)
  await tree.render(view(editRequest))
  expect(tree.container.querySelector('.permission-reason-mark')).toBeNull()
  expect(tip()).toBeNull()
})

test('Edit sends selected engine indices for Apply and Enter, and keeps Deny and Later independent', async () => {
  const answers: unknown[] = []
  const view = (submitted = false) => <PermissionQueue
    items={[{ request: editRequest, submitted, dismissed: false }, { request, submitted: false, dismissed: false }]}
    keyboardTargetRequestId={editRequest.requestId}
    onAllow={(id, indices) => answers.push(['allow', id, indices])}
    onDeny={(id, message) => answers.push(['deny', id, message])}
    onSnooze={id => answers.push(['later', id])}
    onRestore={() => {}}
  />
  const tree = await harness.mount(view())
  await settleFocus()
  const card = tree.container.querySelector<HTMLElement>('section')!
  const labels = [...card.querySelectorAll('label')]
  const boxes = labels.map(label => label.querySelector('input')!)
  expect(labels.map(label => label.textContent)).toEqual([
    'Switch to Accept edits in This session',
    'Add directory /repo/src in Project settings (local)',
    'Always allow Edit(/src/server.ts) in User settings',
  ])
  expect(card.querySelector('[aria-label="2 pending requests"]')?.textContent).toBe('2')
  expect(boxes.every(box => !box.checked)).toBe(true)
  await act(async () => { button(card, 'Apply').click(); boxes[2]!.click(); boxes[0]!.click() })
  await tree.render(view())
  await key(card, 'Enter')
  await act(async () => { button(card, 'Deny').click(); button(card, 'Later').click() })
  await key(card, 'Escape')
  expect(answers).toEqual([
    ['allow', editRequest.requestId, []],
    ['allow', editRequest.requestId, [0, 2]],
    ['deny', editRequest.requestId, undefined],
    ['later', editRequest.requestId],
    ['deny', editRequest.requestId, undefined],
  ])
  await tree.render(view(true))
  expect([...card.querySelectorAll('button, input')].every(node => (node as HTMLButtonElement | HTMLInputElement).disabled)).toBe(true)
  await key(card, 'Enter')
  expect(answers).toHaveLength(5)
})

test('a deny-only Edit still shows its worker, script, and blocked path but cannot apply', async () => {
  let allowed = 0, denied = 0
  const { container } = await harness.mount(<PermissionPrompt
    denyOnly
    keyboardTarget
    request={{ ...editRequest, request: {
      ...editRequest.request, agent_id: 'worker-1', blocked_path: '/outside/server.ts',
    } }}
    scriptSource={{ cellId: 'script-1', generation: '1', line: 4 }}
    onAllow={() => { allowed++ }}
    onDeny={() => { denied++ }}
  />)
  await settleFocus()
  expect(container.querySelector('[title="Relayed from a coding worker"]')?.querySelector('svg')).not.toBeNull()
  expect(container.textContent).toContain('from script · line 4')
  expect(container.textContent).toContain('Blocked path /outside/server.ts')
  expect(container.querySelector('input')).toBeNull()
  expect([...container.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Deny'])
  await key(container.querySelector('section')!, 'Enter')
  await act(async () => { button(container, 'Deny').click() })
  expect(allowed).toBe(0)
  expect(denied).toBe(1)
})
