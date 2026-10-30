import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { QuestionSnapshot } from '../../shared/nonblockingQuestions.js'

let harness: DomTestHarness
let scrollIntoView: typeof HTMLElement.prototype.scrollIntoView
beforeAll(async () => { harness = await createDomTestHarness(); scrollIntoView = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = () => {} })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { HTMLElement.prototype.scrollIntoView = scrollIntoView; await harness.teardown() })
let serial = 0
const pending: QuestionSnapshot = { pending: [{ toolUseId: 'ask', questionIndex: 0, sourceMessageUuid: 'source', question: 'Which storage?', multiSelect: true, options: [{ label: 'Local', description: 'Disk' }, { label: 'Remote', description: 'Server' }] }], resolved: [] }
const activity = (container: HTMLElement) => [...container.querySelectorAll('div')].find(node => node.classList.contains('gap-2.5') && node.classList.contains('text-xs'))

for (const running of [false, true]) test(`the real pane stays collapsed after arrival and keeps running activity while open (running=${running})`, async () => {
  const sessionId = `question-pane-${++serial}`
  const props = { ...idleSessionPaneProps(), activeSessionId: sessionId, activeConnection: { status: 'ready' as const, inputEnabled: !running }, pendingQuestions: pending, onReplyPendingQuestions: async () => {}, onDismissPendingQuestion: async () => {} }
  const tree = await harness.mount(<SessionPane {...props} />)
  expect(tree.container.querySelector('.nq-card')).toBeNull()
  expect(tree.container.querySelector('.nq-pending-text')?.textContent).toBe('Which storage?')
  expect(!!activity(tree.container)).toBe(running)
  await act(async () => { (tree.container.querySelector('.nq-pending') as HTMLElement).click() })
  expect(tree.container.querySelector('.nq-card')).not.toBeNull()
  expect(!!activity(tree.container)).toBe(running)
  const pager = tree.container.querySelector('.nq-pager')
  expect(pager).toBeNull()
})

test('a blocking permission arrives below the open question without sending held picks', async () => {
  let replies = 0
  const props = { ...idleSessionPaneProps(), activeSessionId: `question-pane-${++serial}`, activeConnection: { status: 'ready' as const, inputEnabled: false }, pendingQuestions: pending, onReplyPendingQuestions: async () => { replies++ }, onDismissPendingQuestion: async () => {} }
  const tree = await harness.mount(<SessionPane {...props} />)
  await act(async () => { (tree.container.querySelector('.nq-pending') as HTMLElement).click() })
  await act(async () => { (tree.container.querySelector('[role="checkbox"]') as HTMLElement).click() })
  await tree.render(<SessionPane {...props} permissionQueue={[{ request: { requestId: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'dangerous-tool', input: { command: 'deploy' } } }, submitted: false, dismissed: false }]} />)
  const question = tree.container.querySelector('.nq-card')!
  const permission = tree.container.querySelector('[role="alertdialog"]')!
  expect(question).not.toBeNull()
  expect(permission).not.toBeNull()
  expect(question.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(tree.container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
  expect(replies).toBe(0)
  expect(activity(tree.container)).toBeDefined()
})
