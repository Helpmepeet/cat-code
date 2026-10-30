import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { PendingQuestionDock } from './PendingQuestionDock.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import type { PendingQuestion, QuestionReplyBatch, QuestionDismiss } from '../../../src/utils/pendingQuestions.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
let id = 0
const question = (index: number, extra: Partial<PendingQuestion> = {}): PendingQuestion => ({
  toolUseId: `call-${index}`, questionIndex: 0, sourceMessageUuid: `assistant-${index}`,
  question: `Question ${index}?`, multiSelect: false,
  options: [{ label: 'First', description: 'First choice' }, { label: 'Second', description: 'Second choice' }], ...extra,
})
function fixture(questions: PendingQuestion[]) {
  const sessionId = `dock-test-${++id}`
  const replies: QuestionReplyBatch[] = []
  const dismissals: QuestionDismiss[] = []
  const props = { sessionId, questions, isActivePane: true, onReply: async (batch: QuestionReplyBatch) => { replies.push(batch) }, onDismiss: async (request: QuestionDismiss) => { dismissals.push(request) } }
  const view = (overrides: Partial<typeof props> & { suspended?: boolean } = {}) => <div data-pending-question-owner={sessionId}><PendingQuestionDock {...props} {...overrides} /><textarea aria-label="Composer" /><button data-outside>Transcript</button></div>
  return { sessionId, replies, dismissals, props, view }
}
async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).click() })
}
async function key(key: string, extras: KeyboardEventInit = {}) {
  await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extras })) })
}
async function wait(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const card = (tree: MountedTree) => tree.container.querySelector('.nq-card')
const pick = (tree: MountedTree, index = 0) => tree.container.querySelectorAll('.nq-body:not(.nq-out) [role="radio"], .nq-body:not(.nq-out) [role="checkbox"]')[index]!

test('After the turn stays collapsed; Ask 1 and Ask 3 change only the count without stealing focus', async () => {
  const f = fixture([question(1)])
  const tree = await harness.mount(f.view())
  const composer = tree.container.querySelector('textarea')!
  composer.focus()
  expect(card(tree)).toBeNull()
  expect(tree.container.querySelector('.nq-pending-text')?.textContent).toBe('Question 1?')
  await tree.render(f.view({ questions: [question(1), question(2), question(3), question(4)] }))
  expect(document.activeElement).toBe(composer)
  expect(card(tree)).toBeNull()
  expect(tree.container.querySelector('.nq-pending-text')?.textContent).toBe('Question 1?')
  expect(tree.container.querySelector('.nq-count')?.textContent).toBe('4 pending')
  await key('j', { metaKey: true })
  expect(card(tree)).not.toBeNull()
  expect(tree.container.querySelector('.nq-position')?.textContent).toBe('1/4')
  for (const text of ['Submit', 'Cancel', 'Back', 'Chat about this']) expect(card(tree)?.textContent).not.toContain(text)
  await key('j', { metaKey: true })
  expect(card(tree)).toBeNull()
})

test('picks are editable and withheld across calls until Escape closes the card', async () => {
  const f = fixture([question(1, { multiSelect: true }), question(2, { multiSelect: true })])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await click(pick(tree))
  await key('ArrowRight')
  await click(pick(tree, 1))
  expect(f.replies).toHaveLength(0)
  await key('ArrowLeft')
  await click(pick(tree))
  expect(pick(tree).getAttribute('aria-checked')).toBe('false')
  await click(pick(tree, 1))
  await key('Escape')
  expect(f.replies).toHaveLength(1)
  expect(f.replies[0]?.replies.map(reply => [reply.toolUseId, reply.answer.optionIndices])).toEqual([['call-1', [1]], ['call-2', [1]]])
})

test('single select briefly checks then advances unhighlighted and blocks accidental double input', async () => {
  const f = fixture([question(1), question(2)])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await key('1')
  expect(pick(tree).getAttribute('aria-checked')).toBe('true')
  await wait(165)
  expect(tree.container.querySelector('.nq-title')?.textContent).toBe('Question 2?')
  expect(tree.container.querySelector('.nq-body:not(.nq-out) .nq-active')).toBeNull()
  await key('1')
  await click(pick(tree))
  expect(pick(tree).getAttribute('aria-checked')).toBe('false')
  expect(f.replies).toHaveLength(0)
  await wait(360)
  await key('2')
  await wait(165)
  expect(card(tree)).toBeNull()
  expect(f.replies).toHaveLength(1)
  expect(f.replies[0]?.replies).toHaveLength(2)
})

test('up/down highlight only; horizontal keyboard navigation and swipe cover all pending calls', async () => {
  const f = fixture([question(1), question(2), question(3)])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await key('ArrowDown')
  expect(tree.container.querySelector('.nq-active')).not.toBeNull()
  expect(pick(tree).getAttribute('aria-checked')).toBe('false')
  await key('ArrowLeft')
  expect(tree.container.querySelector('.nq-position')?.textContent).toBe('3/3')
  await act(async () => { card(tree)!.dispatchEvent(new WheelEvent('wheel', { deltaX: -45, deltaY: 1, bubbles: true, cancelable: true })) })
  expect(tree.container.querySelector('.nq-position')?.textContent).toBe('2/3')
  expect(f.replies).toHaveLength(0)
})

test('dismiss is per question and never flushes other picks', async () => {
  const f = fixture([question(1, { multiSelect: true }), question(2), question(3)])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await click(pick(tree))
  await key('ArrowRight')
  await key('Backspace')
  expect(f.dismissals).toHaveLength(1)
  expect(f.dismissals[0]).toMatchObject({ toolUseId: 'call-2', questionIndex: 0 })
  expect(f.replies).toHaveLength(0)
})

test('title, outside click, composer focus and command-J close and flush', async () => {
  for (const gesture of ['title', 'outside', 'composer', 'shortcut']) {
    const f = fixture([question(1, { multiSelect: true }), question(2)])
    const tree = await harness.mount(f.view())
    await click(tree.container.querySelector('.nq-pending'))
    await click(pick(tree))
    if (gesture === 'title') await click(tree.container.querySelector('.nq-head'))
    if (gesture === 'outside') await act(async () => { tree.container.querySelector('[data-outside]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    if (gesture === 'composer') await act(async () => { tree.container.querySelector('textarea')!.focus() })
    if (gesture === 'shortcut') await key('j', { metaKey: true })
    expect(card(tree)).toBeNull()
    expect(f.replies).toHaveLength(1)
    await tree.unmount()
  }
})

test('pane switches, unmounts, window blur and blocking permission arrival preserve unsent picks', async () => {
  const f = fixture([question(1, { multiSelect: true }), question(2)])
  let tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await click(pick(tree))
  await tree.render(f.view({ isActivePane: false }))
  await key('Escape')
  await tree.render(f.view({ isActivePane: true, suspended: true }))
  await key('j', { metaKey: true })
  await act(async () => { window.dispatchEvent(new Event('blur')) })
  expect(f.replies).toHaveLength(0)
  await tree.unmount()
  tree = await harness.mount(f.view())
  expect(pick(tree).getAttribute('aria-checked')).toBe('true')
  expect(f.replies).toHaveLength(0)
  expect(localStorage.getItem(`pending-question-drafts:${f.sessionId}`)).toContain('optionIndices')
  await key('Escape')
  expect(f.replies).toHaveLength(1)
})

test('previews retain the existing inert sanitization seam', async () => {
  const f = fixture([question(1, { options: [{ label: 'First', description: 'First choice', preview: '<div>Layout<script>bad()</script></div>' }, { label: 'Second', description: 'Second choice' }] })])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  const root = tree.container.querySelector('.ask-preview-html')?.shadowRoot
  expect(root?.textContent).toContain('Layout')
  expect(root?.querySelector('script')).toBeNull()
})

test('Ctrl-number never selects and focused controls retain native Enter and Space activation', async () => {
  const f = fixture([question(1, { multiSelect: true }), question(2)])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await key('1', { ctrlKey: true })
  expect(pick(tree).getAttribute('aria-checked')).toBe('false')
  for (const selector of ['.nq-head', '.nq-note-button', '[aria-label="Dismiss question"]', '[aria-label="Next question"]', '.nq-other-label']) {
    const control = tree.container.querySelector<HTMLElement>(selector)!
    await act(async () => { control.focus() })
    for (const value of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
      await act(async () => { control.dispatchEvent(event) })
      // The DOM harness does not synthesize the browser's default button click.
      expect(event.defaultPrevented).toBe(false)
      expect(pick(tree).getAttribute('aria-checked')).toBe('false')
    }
  }
  await click(tree.container.querySelector('.nq-other-label'))
  expect(tree.container.querySelector('[aria-label="Other answer"]')).not.toBeNull()
  expect(f.replies).toHaveLength(0)
})

test('overlapping dismiss and close exclude the dismissed pick even when dismissal fails', async () => {
  const f = fixture([question(1, { multiSelect: true }), question(2, { multiSelect: true })])
  let reject!: (error: Error) => void
  const tree = await harness.mount(f.view({ onDismiss: () => new Promise<void>((_, fail) => { reject = fail }) }))
  await click(tree.container.querySelector('.nq-pending'))
  await click(pick(tree))
  await key('ArrowRight')
  await click(pick(tree, 1))
  await click(tree.container.querySelector('[aria-label="Dismiss question"]'))
  await key('Escape')
  expect(f.replies[0]?.replies.map(reply => reply.toolUseId)).toEqual(['call-1'])
  await act(async () => { reject(new Error('dismiss rejected')) })
  await click(tree.container.querySelector('.nq-pending'))
  await key('ArrowRight')
  expect(pick(tree, 1).getAttribute('aria-checked')).toBe('true')
  await tree.render(f.view())
  await click(tree.container.querySelector('[aria-label="Dismiss question"]'))
  expect(f.dismissals).toHaveLength(1)
})

test('failed reply retains picks for an explicit close retry without duplicate in-flight sends', async () => {
  const f = fixture([question(1, { multiSelect: true })])
  let reject!: (error: Error) => void
  let attempts = 0
  const tree = await harness.mount(f.view({ onReply: () => { attempts++; return new Promise<void>((_, fail) => { reject = fail }) } }))
  await click(tree.container.querySelector('.nq-pending'))
  await click(pick(tree))
  await key('Escape')
  await click(tree.container.querySelector('.nq-pending'))
  await key('Escape')
  expect(attempts).toBe(1)
  await act(async () => { reject(new Error('reply rejected')) })
  await tree.render(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  expect(pick(tree).getAttribute('aria-checked')).toBe('true')
  await key('Escape')
  expect(f.replies[0]?.replies[0]?.answer.optionIndices).toEqual([0])
})

test('window and pane reactivation cancel advance and lock picks without sending on restored composer focus', async () => {
  const f = fixture([question(1), question(2)])
  const tree = await harness.mount(f.view())
  await click(tree.container.querySelector('.nq-pending'))
  await key('1')
  await act(async () => { window.dispatchEvent(new Event('blur')) })
  await key('Escape')
  await wait(165)
  expect(card(tree)).not.toBeNull()
  expect(f.replies).toHaveLength(0)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    tree.container.querySelector('textarea')!.focus()
  })
  expect(card(tree)).not.toBeNull()
  await act(async () => { (card(tree) as HTMLElement).focus() })
  await key('2')
  expect(pick(tree).getAttribute('aria-checked')).toBe('true')
  await tree.render(f.view({ isActivePane: false }))
  await tree.render(f.view())
  await click(pick(tree, 1))
  expect(pick(tree, 1).getAttribute('aria-checked')).toBe('false')
  await wait(360)
  await key('2')
  expect(pick(tree, 1).getAttribute('aria-checked')).toBe('true')
  expect(f.replies).toHaveLength(0)
})
